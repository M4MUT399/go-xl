# Go XL — PR-c: fiação do app ao motor v2 (flag `dispatch_engine_v2`)

Terceiro e último bloco da reconstrução do dispatch estilo Uber. O PR-a corrigiu a
causa raiz no cliente (fila FIFO de ofertas) e o PR-b construiu o **motor no
servidor** (tabelas `trip_requests`/`ride_offers`/`dispatch_events` + Edge Function
`dispatch-engine` + RPC de aceite atômico). Faltava **ligar o app** a esse motor.

Este PR faz exatamente a troca de fiação prevista no fim do PR-b, atrás da **mesma
flag `dispatch_engine_v2` (OFF por padrão)**:

- (a) solicitar corrida → chama `dispatch-engine action=create` no lugar do leque
  legado (`notifyOnlineDrivers`);
- (b) card do motorista → dirigido pela tabela `ride_offers` (assinatura realtime
  por `driver_id`), não mais pelo leque em `rides`;
- (c) aceitar → passa pelo aceite atômico do servidor (`dispatch-engine
  action=accept` → RPC `accept_trip_offer`);
- (d) recusar/expirar/cancelar → avisam o servidor para promover o próximo
  (`action=reject` / `action=cancel`).

Com a flag OFF, **nada disso roda** — o app segue idêntico ao fluxo legado.
Rollback = flag.

## Núcleo puro da ponte (`src/lib/dispatchClientBridge.ts`)

Toda a DECISÃO da ponte cliente↔motor vive num módulo puro (sem React, sem
Supabase), testável isoladamente — mesmo espírito de `dispatchEngine.ts`/
`offerQueue.ts`:

| Função | Papel |
|--------|-------|
| `decideOfferAction(row, ctx)` | dado um registro de `ride_offers` chegando pelo realtime + contexto do motorista, decide **`enqueue`** (mostra card), **`dismiss`** (some card) ou **`ignore`** (nada). |
| `livePendingOffers(rows, nowMs, driverId)` | dado o conjunto lido do servidor na reabertura do app, devolve só as ofertas **VIVAS** (PENDING e não expiradas) deste motorista, preservando a ordem — reconstrói o card sem fantasma (critério 5). |

Matriz de `decideOfferAction`:

| Situação | Ação |
|----------|------|
| Oferta de OUTRO motorista | `ignore` (RLS já filtra; defesa em profundidade). |
| `REVOKED` / `EXPIRED` / `REJECTED` | `dismiss` (perdedor do aceite, expirou ou recusou). |
| `ACCEPTED` | `ignore` (desfecho conduzido pelo fluxo de `acceptRide`). |
| `PENDING` mas `expires_at` no passado | `dismiss` (stale pelo relógio). |
| `PENDING` viva mas corrida **lapidada** neste device | `ignore` (não reabre o que já foi recusado/expirado localmente). |
| `PENDING` viva | `enqueue`. |

## Como a fiação liga o motor sem duplicar o card

O ponto delicado: com a flag ON, a linha em `rides` **continua** sendo inserida
(ela é a entidade de tarifa/pagamento). Isso dispararia o card por **dois**
caminhos — o leque legado (`rides` realtime) **e** o novo (`ride_offers`). A
solução é **suprimir o caminho legado** só para o pool aberto quando a flag está
ligada, mantendo QR e agendamento no fluxo legado:

- **INSERT `requesting`** (`useDriverRide`): `if (engineV2Ref.current &&
  !ride.driver_id) return;` — ignora o leque aberto, mas mantém a corrida travada
  por QR (`driver_id` pré-fixado), que continua legada.
- **UPDATE `requesting`** (ativação de agendada vira pool aberto): `if
  (engineV2Ref.current) return;` — a mesma solicitação passa a chegar por
  `ride_offers`.
- **Nova assinatura `ride_offers`**: efeito dedicado que só abre canal quando
  `driverId && engineV2`; INSERT/UPDATE → `decideOfferAction` → enfileira/descarta
  reusando a MESMA fila/UI do card legado (`offerQueue` + `setPendingRide`), então
  som, watchdog, Android Auto e overlay funcionam sem alteração.

Assim o card do motorista é **um só**; muda apenas quem o alimenta.

## Fluxos ligados ao motor (todos flag-gated)

| Fluxo | Arquivo | Legado (flag OFF) | v2 (flag ON) |
|-------|---------|-------------------|--------------|
| Solicitar corrida (pool aberto) | `useRide.requestRide` | `notifyOnlineDrivers` | `dispatchEngineCreate` → `dispatch-engine action=create`; fallback ao leque se o motor pular. |
| Ativar corrida agendada (vira pool aberto) | `useScheduledRides.activate` | `notifyOnlineDrivers` | mesmo `dispatchEngineCreate` (unifica o caminho do pool imediato). |
| Card do motorista | `useDriverRide` | `rides` realtime + offerQueue | `ride_offers` realtime por `driver_id` (leque legado suprimido). |
| Aceitar | `useDriverRide.acceptRide` | cobra cartão → compare-and-set em `rides` | cobra cartão → `dispatch-engine action=accept` (RPC atômica); perdedor → `null` (paridade com corrida-já-tomada). |
| Recusar / expirar | `GlobalDriverRideOverlay` → `rejectServerOffer` | só limpa local | + `dispatch-engine action=reject` (promove o próximo na hora). |
| Cancelar (passageiro) | `useActiveRide.cancelRide` | broadcasts | + `dispatch-engine action=cancel` (revoga ofertas pendentes). |

**Reconstrução (critério 5):** o efeito da assinatura, ao montar, lê as
`ride_offers` PENDING do motorista e re-enfileira via `livePendingOffers` — o card
volta exatamente ao estado do servidor após app morto/reaberto, sem fantasma.

## Parâmetros configuráveis

Nenhum parâmetro NOVO. O PR-c reusa a flag e os 6 parâmetros do PR-b (todos em
`system_config`, jurisdição-aware):

| Chave | Default | Papel no PR-c |
|-------|---------|---------------|
| `dispatch_engine_v2` | `false` | **Único interruptor.** OFF = app 100% legado. |
| `dispatch_offer_ttl_seconds` | `15` | (servidor) timer de cada oferta. |
| `dispatch_mode` | `sequential` | (servidor) sequencial vs. broadcast. |
| `dispatch_radius_initial_km` | `3` | (servidor) raio inicial. |
| `dispatch_radius_step_km` | `2` | (servidor) incremento de raio. |
| `dispatch_radius_max_km` | `15` | (servidor) raio máximo. |
| `dispatch_global_timeout_seconds` | `300` | (servidor) timeout global do pedido. |

## Arquivos

| Arquivo | Mudança |
|---------|---------|
| `src/lib/dispatchClientBridge.ts` | **novo** — núcleo puro da ponte (`decideOfferAction` + `livePendingOffers`). |
| `src/lib/__tests__/dispatchClientBridge.test.ts` | **novo** — 13 testes (matriz de decisão + reconstrução). |
| `src/hooks/useRide.ts` | `dispatchEngineCreate`; v2 em `requestRide`/`activate`/`acceptRide`/`cancelRide`; flag+refs; supressão do leque legado; assinatura `ride_offers` + reconstrução; `rejectServerOffer`. |
| `src/components/driver/GlobalDriverRideOverlay.tsx` | `rejectServerOffer` em recusar/expirar. |
| `supabase/functions/dispatch-engine/index.ts` | correção do `create`: seleciona `origin_lat/lng` de `rides` (não `pickup_lat/lng`, inexistente) e mapeia origem → pickup no `trip_requests`. |

## Validação (verde)

- `tsc --noEmit` → **EXIT 0** (Edge Functions ficam fora do tsconfig do app; o
  typecheck Deno roda à parte).
- `deno check supabase/functions/dispatch-engine/index.ts` → **OK**.
- Suítes puras (esbuild+node com shim de jest; ver PR-a para o método):
  - `dispatchClientBridge` → **13 passed, 0 failed**.
  - `offerQueue` → **9 passed, 0 failed**.
  - `dispatchConcurrency` → **7 passed, 0 failed**.
  - `dispatchEngineConcurrency` → **8 passed, 0 failed**.

```
npx tsc --noEmit
/Users/mamute99/.deno/bin/deno check supabase/functions/dispatch-engine/index.ts
for t in dispatchClientBridge offerQueue dispatchConcurrency dispatchEngineConcurrency; do
  npx esbuild src/lib/__tests__/$t.test.ts --bundle --platform=node --format=cjs \
    --outfile=/tmp/de.cjs --inject:/tmp/jestshim.js --define:__DEV__=false && node /tmp/de.cjs
done
```

## Roteiro de teste manual (staging, flag ON)

Pré: `dispatch_engine_v2 = true` na jurisdição de teste, `dispatch-engine`
deployada, cron chamando `action=tick` a cada ~2 s.

1. **Card via `ride_offers` (a+b):** 1 motorista online. Passageiro solicita → o
   card **toca** (INSERT PENDING em `ride_offers`), não mais pelo leque em `rides`.
2. **Invariante do bug (independência):** com o card de P1 tocando, um 2º
   passageiro solicita → o card de P1 **continua** (o pedido de P2 é outra máquina
   no servidor). Criar/receber um pedido nunca cancela/silencia outra oferta viva.
3. **Aceite atômico (c):** 2 motoristas recebem a mesma oferta (broadcast). Um
   aceita → o outro vê o card sumir na hora (REVOKED); o vencedor navega. Toque
   quase simultâneo → só um vence; o outro recebe alerta de corrida já tomada.
4. **Recusa promove o próximo (d):** motorista recusa → `action=reject` → o próximo
   candidato recebe a oferta no ciclo seguinte (≤ ~2 s).
5. **Reconstrução (crit. 5):** com uma oferta pendente, mate o app do motorista e
   reabra → o card volta a partir de `ride_offers` (sem duplicar, sem fantasma).
6. **Cancelamento:** passageiro cancela durante a busca → `action=cancel` revoga as
   ofertas pendentes; os cards somem.
7. **Rollback:** `dispatch_engine_v2 = false` → o app volta 100% ao fluxo legado
   (leque via `send-ride-push`), sem redeploy.

## Notas de paridade e limites conhecidos

- **QR e agendamento continuam legados neste PR.** Só o pool aberto imediato foi
  migrado para o motor v2. Corrida travada por QR (`driver_id` pré-fixado) segue
  pelo caminho legado — intencional, para reduzir a superfície do rollout.
- **Ordem cobrar→aceitar (aceite):** mantida a ordem legada (cobra o cartão e
  depois trava o vencedor). No v2 a trava é a RPC `accept_trip_offer`. Em toques
  quase simultâneos há a aresta conhecida de **cobrança órfã** (um motorista cobra
  e perde a eleição); mitigada pelo `broadcastRideRevoked(...'taken'...)`
  otimista disparado no passo 0 do aceite, que silencia os outros cards na hora.
  Endurecer para "trava-antes-de-cobrar" fica como melhoria futura.
- **`tick` por cron:** a expiração de ofertas, expansão de raio e timeout global
  dependem de alguém chamar `action=tick` periodicamente (cron/scheduler). Sem
  isso, o motor ainda funciona no caminho feliz (create/accept/reject event-driven),
  mas não expira/expande sozinho.

## Deploy (quando autorizado — NÃO executado neste PR)

```
npx supabase functions deploy dispatch-engine --no-verify-jwt   # inclui o fix do create
# flag dispatch_engine_v2 = true na jurisdição-piloto (rollout gradual)
# cron chamando POST {action:'tick'} a cada ~2s
```

Nada foi comitado, buildado nem deployado neste PR.
