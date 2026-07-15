# Go XL — PR-b: motor de distribuição estilo Uber (servidor)

Reconstrução do sistema de distribuição de corridas para o modelo Uber, com o
**servidor como fonte da verdade**. Complementa o PR-a (correção da causa raiz no
cliente) trocando o dispatch em leque client-orchestrado por uma **máquina de
estados por pedido** persistida, com oferta sequencial por ETA, aceite atômico e
re-dispatch dirigido por eventos.

Tudo atrás da flag **`dispatch_engine_v2` (OFF por padrão)**. Enquanto desligada,
nada escreve nas novas tabelas e o fluxo legado segue idêntico — rollback = flag.

## Arquitetura

```
Passageiro solicita ─▶ Edge Function `dispatch-engine` (action=create)
                          │  usa o NÚCLEO PURO dispatchEngine.ts
                          ▼
        ┌───────────────────────────────────────────┐
        │ trip_requests   (1 pedido = 1 máquina)     │  ← fonte da verdade
        │ ride_offers     (1 oferta = trip × driver) │
        │ dispatch_events (trilha imutável)          │
        └───────────────────────────────────────────┘
                          ▲   realtime (postgres_changes) + push best-effort
   App do motorista ──────┘   INSERT PENDING → card ; UPDATE REVOKED/EXPIRED → some
```

- **Núcleo puro** (`src/lib/dispatchEngine.ts`): decide TODAS as transições, sem
  React/Supabase. A Edge Function e as tabelas só aplicam o que ele decide. É o
  mesmo módulo re-exportado ao runtime Deno via
  `supabase/functions/_shared/dispatchEngine.ts` (fonte única, sem duplicação —
  `supabase/functions` está fora do tsconfig do app).
- **Servidor = fonte da verdade**: o card do motorista é reconstruído lendo
  `ride_offers` (foreground → fetch das ofertas ativas). App morto e reaberto →
  estado reconstituído do banco, sem card fantasma.

## Máquina de estados (por pedido)

```
REQUESTED → MATCHING → OFFERING → ACCEPTED → ONGOING
                 └──────────────→ NO_DRIVERS   (raio esgotado / timeout global)
     (qualquer não-terminal) ────→ CANCELLED   (passageiro cancelou)
```

N máquinas em paralelo, **totalmente independentes**: criar um pedido nunca
altera outro (a invariante do bug, agora garantida no servidor).

## Regras implementadas (núcleo puro)

| Regra | Como |
|-------|------|
| Candidatos ranqueados | por ETA (asc), desempate distância e id — `rankCandidates`. |
| Oferta sequencial | `dispatchMode='sequential'`: 1 oferta por vez, timer configurável. |
| Modo broadcast | `dispatchMode='broadcast'`: leque a todos os candidatos livres. |
| Trava por motorista | 1 oferta pendente por motorista (índice único parcial no banco + `reconcile` no núcleo). |
| Aceite atômico | compare-and-set `UPDATE ... WHERE status='OFFERING' AND accepted_by IS NULL` (RPC `accept_trip_offer`). Perdedores → `TRIP_NO_LONGER_AVAILABLE`. |
| Re-dispatch por evento | ao aceitar/recusar/expirar, `reconcile` promove o próximo candidato/pedido no mesmo ciclo. |
| Fila FIFO + desempate ETA | `reconcile` ordena pendentes por `createdAt` e, empatando, pela melhor ETA disponível. |
| Expansão de raio | `tick` cresce o raio (step) até o máximo quando ninguém aceita. |
| Timeout global | `tick` marca `NO_DRIVERS` após `globalTimeoutMs`. |
| Idempotência | `createRequest`/`resolveOffer`/`accept` idempotentes; 1 pedido por `ride_id`; 1 oferta por (pedido, motorista). |
| Observabilidade | toda transição logada em `dispatch_events` com `trip_request_id` + `driver_id` + `timestamp`. |

## Tabelas (migration `0054_dispatch_engine_v2.sql`)

- **`trip_requests`** — a máquina por pedido (status, dispatch_mode, radius_km,
  accepted_by, pickup/destination, ride_id). Índices por status+created_at.
- **`ride_offers`** — a oferta (trip × motorista). Índices únicos que impõem as
  invariantes:
  - `ride_offers_unique_pair (trip_request_id, driver_id)` — sem oferta duplicada.
  - `ride_offers_one_pending_per_driver (driver_id) WHERE status='PENDING'` —
    **um motorista = no máximo uma oferta pendente**.
  - `ride_offers_one_accepted_per_trip (trip_request_id) WHERE status='ACCEPTED'`
    — **um vencedor por pedido**.
- **`dispatch_events`** — trilha append-only.
- **RPC `accept_trip_offer(trip_request_id, driver_id)`** — aceite atômico
  (SECURITY DEFINER, valida `auth.uid()`); marca o vencedor, **revoga os
  perdedores** e loga o evento. Idempotente para o mesmo vencedor.
- **RLS**: passageiro dono lê seu pedido; motorista lê/recusa só as suas ofertas
  (aceite só via RPC); admin lê tudo; `service_role` acesso completo (Edge Function).

## Edge Function `dispatch-engine`

Orquestrador. Lê a flag; se OFF responde `{ skipped: true }` sem escrever.
Ações (POST `{ action, ... }` + JWT):

| Ação | Efeito |
|------|--------|
| `create { rideId }` | cria `trip_request` (1 por ride) e faz o 1º match (reconcile + persiste ofertas + push). |
| `accept { tripRequestId }` | RPC atômica + redispatch dos perdedores para o próximo pedido. |
| `reject { tripRequestId }` | marca `REJECTED` e promove o próximo candidato. |
| `cancel { tripRequestId }` | passageiro cancela; revoga ofertas pendentes. |
| `tick {}` | expira ofertas vencidas, expande raio, aplica timeout global, reconcilia. Ideal chamar por cron a cada poucos segundos. |

## Parâmetros configuráveis (`system_config`, jurisdição-aware)

| Chave | Default | Controla |
|-------|---------|----------|
| `dispatch_engine_v2` | `false` | Liga o motor v2 no servidor. **OFF = fluxo legado**. |
| `dispatch_offer_ttl_seconds` | `15` | Timer de cada oferta antes de expirar → próximo. |
| `dispatch_mode` | `sequential` | `sequential` (1 por vez) ou `broadcast` (leque). |
| `dispatch_radius_initial_km` | `3` | Raio inicial de busca. |
| `dispatch_radius_step_km` | `2` | Incremento de raio por expansão. |
| `dispatch_radius_max_km` | `15` | Raio máximo antes de `NO_DRIVERS`. |
| `dispatch_global_timeout_seconds` | `300` | Tempo global do pedido antes de `NO_DRIVERS`. |

Todos os tempos/raios vêm de config remota — nada chumbado no código.

## Arquivos

| Arquivo | Mudança |
|---------|---------|
| `src/lib/dispatchEngine.ts` | **novo** — núcleo puro (máquina de estados + escalonador). |
| `src/lib/__tests__/dispatchEngineConcurrency.test.ts` | **novo** — 8 testes cobrindo os 6 critérios. |
| `supabase/functions/_shared/dispatchEngine.ts` | **novo** — ponte Deno (re-exporta o núcleo). |
| `supabase/functions/dispatch-engine/index.ts` | **novo** — orquestrador (create/accept/reject/cancel/tick). |
| `supabase/migrations/0054_dispatch_engine_v2.sql` | **novo** — tabelas + índices + RPC + RLS. |
| `src/lib/systemConfig.ts` | flag `dispatch_engine_v2` + 6 parâmetros. |

## Cobertura dos 6 critérios de aceitação (concorrência)

Testes em `dispatchEngineConcurrency.test.ts` — **8 passam, 0 falham** (validados
via esbuild+node com shim de jest; ver PR-a para o método):

1. **P1 então P2 (5 s depois)** → máquinas independentes; criar P2 não revoga
   nem altera a oferta viva de P1; P2 vai ao próximo motorista livre (ou fica em
   MATCHING se não houver). ✔
2. **M1 aceita P1 → motorista liberado recebe P2** no reconcile seguinte
   (event-driven; ≤ um ciclo, alvo ≤2 s em produção). ✔
3. **M1 e M2 aceitam P1 ao mesmo tempo** → compare-and-set elege **um único
   vencedor**; o outro recebe `TRIP_NO_LONGER_AVAILABLE` e cai para P2. ✔
4. **10 pedidos / 3 motoristas** → FIFO (R0,R1,R2 primeiro); recusa promove o
   próximo sem perder R0; aceites sucessivos drenam os 10 em ordem, sem deadlock. ✔
5. **Reconstrução de estado** → `offerForDriver` reconstrói a oferta ativa a
   partir do estado do servidor; após outro vencer, a oferta stale **não
   reaparece** (sem card fantasma). ✔
6. **Carga — 50 pedidos, pool pequeno** → invariantes mantidas a cada ciclo
   (sem oferta duplicada, sem oferta órfã), todos os 50 drenados em FIFO, sem
   deadlock. ✔

## Como validar localmente (núcleo puro)

```
printf "import '/Users/mamute99/go-xl/src/lib/__tests__/dispatchEngineConcurrency.test.ts';" > /tmp/de.ts
npx esbuild /tmp/de.ts --bundle --platform=node --format=cjs --outfile=/tmp/de.cjs --inject:/tmp/jestshim.js --define:__DEV__=false && node /tmp/de.cjs
npx tsc --noEmit
```

Resultado atual: `8 passed, 0 failed`; `tsc` EXIT 0 (as Edge Functions ficam fora
do tsconfig do app; o typecheck Deno roda no deploy).

## Roteiro de teste manual (staging, flag ON)

Pré: `dispatch_engine_v2 = true` (jurisdição de teste), `dispatch-engine`
deployada, cron chamando `action=tick` a cada ~2 s.

1. **Independência (crit. 1):** 1 motorista online. Passageiro A solicita → card
   toca (via `ride_offers` INSERT). Passageiro B solicita 5 s depois → o card de A
   **continua**; o pedido de B fica `MATCHING` (fila) sem tocar em A.
2. **Aceite + redispatch (crit. 2/3):** 2 motoristas. Passageiro A solicita.
   Ambos recebem oferta (modo broadcast) ou o mais próximo (sequential). Um
   aceita → o outro vê o card sumir na hora; se houver pedido B na fila, ele passa
   a receber B em ≤2 s.
3. **Expiração/expansão (raio/timer):** solicite numa região sem motorista perto.
   Sem aceite em `dispatch_offer_ttl_seconds`, a oferta expira e o raio cresce
   (`dispatch_radius_step_km`) até o máximo; sem ninguém, o pedido vira
   `NO_DRIVERS` após `dispatch_global_timeout_seconds` (passageiro vê "nenhum
   motorista disponível").
4. **Reconstrução (crit. 5):** com uma oferta pendente, mate o app do motorista e
   reabra → o card volta a partir de `ride_offers` (sem duplicar, sem fantasma).
5. **Rollback:** `dispatch_engine_v2 = false` → `dispatch-engine` responde
   `{ skipped: true }`; o app volta ao fluxo legado (leque via `send-ride-push`).

## Deploy (quando autorizado — NÃO executado neste PR)

```
npx supabase db push                         # aplica a migration 0054
npx supabase functions deploy dispatch-engine --no-verify-jwt
# opcional: cron chamando POST {action:'tick'} a cada ~2s
```

## Riscos e rollback

- **Rollback instantâneo:** flag OFF (config dinâmica, sem redeploy). A migration
  é inerte enquanto a flag estiver OFF (nada escreve nas tabelas novas).
- **Sem impacto no legado:** `rides` continua a entidade de tarifa/pagamento; as
  tabelas novas modelam só a distribuição em volta dela.
- **Wiring do app (próximo passo, fora deste PR):** o cliente ainda precisa
  passar a (a) chamar `dispatch-engine action=create` no lugar de
  `notifyOnlineDrivers`, (b) assinar `ride_offers` por `driver_id` para o card,
  e (c) aceitar via `accept_trip_offer`. Fica atrás da mesma flag, para o rollout
  gradual. Recomendo um PR-c só para essa troca de fiação no app.
```
