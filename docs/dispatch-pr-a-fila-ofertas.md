# Go XL — PR-a: correção do dispatch concorrente (fila FIFO de ofertas)

Correção da **causa raiz** do bug de corridas concorrentes no app do motorista.
Escopo do PR-a: só o lado cliente (hook + fila pura + flag). O novo motor de
distribuição estilo Uber (máquina de estados por pedido, Edge Function + tabelas)
vem no **PR-b**, separado.

## O bug (invariante violada)

Fluxo antigo (slot único por motorista):

1. Passageiro P1 solicita → motoristas online recebem a chamada (toca/aparece).
2. **Antes de qualquer motorista aceitar**, passageiro P2 solicita.
3. A oferta de P2 **sobrescrevia** o slot único `pendingRide` do device → a
   chamada de P1 era **cancelada/silenciada** no aparelho do motorista.
4. Pior: o `offerAlertManager` colocava P1 em *tombstone* (10 min) ao ser
   superada — então P1 não voltava a tocar nem que fosse reofertada.
5. Resultado: **as duas corridas morriam**. P2 não distribuía direito e P1 sumia.

**Invariante que passa a valer:** criar/receber uma nova oferta **JAMAIS**
cancela, silencia ou lapida (tombstone) outra oferta válida. Cada pedido é
independente.

## A correção

Substituição do **slot único** (`pendingRide` como um único `useState`) por uma
**fila FIFO de ofertas** (`offerQueue`) no `useDriverRide`. A **cabeça** da fila
(`offerQueue[0]`) é a corrida que toca/aparece agora; as demais aguardam sem
serem canceladas. O motorista atende **uma por vez** (FIFO) e, ao resolver a
cabeça (aceite/recusa/expira/tomada), a **próxima é promovida automaticamente**.

Toda a decisão de fila vive num módulo **puro e testável** sem React:
`src/lib/offerQueue.ts`.

| Função | Comportamento |
|--------|---------------|
| `arriveOffer(queue, offer, multiOffer)` | Nova oferta chega. `multiOffer=true`: acrescenta no fim se o id for novo (dedupe por id; mesma referência se nada muda). `multiOffer=false`: **substitui** (`[offer]`) — reproduz o slot único legado. |
| `resolveOffer(queue, id)` | Remove a oferta por id de qualquer posição (cabeça ou cauda). Idempotente: id ausente → mesma referência (sem re-render). |
| `headOffer(queue)` | A oferta que toca agora (`queue[0]`) ou `null`. |
| `queueHasOffer(queue, id)` | A fila contém aquele id? (usado para revogar ofertas da cauda). |

### Pontos-chave do wiring (`src/hooks/useRide.ts`)

- `pendingRide = offerQueue[0] ?? null` — API pública inalterada para os
  consumidores (overlay, telas). Nada quebra.
- `setPendingRide(ride)` → `arriveOffer` (enfileira / substitui sob flag off).
- `setPendingRide(null)` → resolve a **cabeça** (promove a próxima).
- Novo `dismissOffer(id)` → remove **uma** oferta por id (idempotente). Os
  callers que sabem o id (aceitar/recusar/expirar/pagamento) preferem este,
  evitando remover por engano a oferta promovida.
- **Motorista fica ocupado** (aceitou): ao detectar `driver_id` → status busy,
  a fila inteira é **esvaziada** (`setOfferQueue([])`) — o motorista que aceitou
  P1 não fica tocando a P2 enfileirada; P2 segue para os OUTROS motoristas.
- **Revogação de cauda:** sob multi-oferta, o handler de revogação usa
  `queueHasOffer` para também parar/remover ofertas que não são a cabeça (ex.:
  P2 tomada por outro motorista enquanto P1 ainda toca aqui).

### Por que o `offerAlertManager` não precisou mudar

Com a fila, o `startAlert` só dispara para uma cabeça **genuinamente nova**,
depois que a cabeça anterior terminou. O *tombstone-on-supersede* (que matava a
corrida superada) nunca mais é acionado sobre uma oferta ainda válida — a fila
elimina a superação indevida na origem.

## Feature flag (rollout gradual + rollback)

`src/lib/systemConfig.ts` → `CONFIG_DEFAULTS`:

```
dispatch_multi_offer_fix: false   // DESLIGADA por padrão
```

- **OFF (padrão):** `arriveOffer`/`resolveOffer` reduzem a fila a no máximo 1
  item → comportamento **idêntico ao slot único legado**. Rollback instantâneo
  sem redeploy (config dinâmica por jurisdição, TTL 60 s).
- **ON:** o motorista mantém várias ofertas válidas ao mesmo tempo e atende uma
  por vez (FIFO). Habilitar por jurisdição só após validação em campo.

## Parâmetros configuráveis

| Chave (`system_config`) | Default | O que controla |
|-------------------------|---------|----------------|
| `dispatch_multi_offer_fix` | `false` | Liga a fila FIFO de ofertas (multi-oferta). Off = slot único legado. |
| `ride_offer_timeout_seconds` | `30` | (existente) Segundos que a chamada toca antes de expirar — sem alteração aqui. |

## Arquivos

| Arquivo | Mudança |
|---------|---------|
| `src/lib/offerQueue.ts` | **novo** — módulo puro da fila FIFO. |
| `src/lib/__tests__/offerQueue.test.ts` | **novo** — 9 testes unitários da fila. |
| `src/lib/__tests__/dispatchConcurrency.test.ts` | **novo** — 7 testes de concorrência (modela o device do motorista). |
| `src/lib/systemConfig.ts` | flag `dispatch_multi_offer_fix: false`. |
| `src/hooks/useRide.ts` | slot único → fila; `dismissOffer`; esvaziar fila ao ficar ocupado; revogação de cauda. |
| `src/components/driver/GlobalDriverRideOverlay.tsx` | usa `dismissOffer(id)` nos caminhos terminais (aceite/recusa/expira/pagamento). |

## Cobertura dos critérios de aceitação (concorrência)

Testes em `dispatchConcurrency.test.ts` (modelam o device do motorista com a
mesma lógica do hook). **7 passam, 0 falham.**

1. **P1, depois P2 5 s depois** → P1 permanece tocando, P2 enfileirada; nada é
   revogado. (+ regressão: sob flag OFF, P2 substitui P1 — comportamento legado
   preservado.)
2. **Motorista aceita P1** → device fica ocupado e esvazia a fila (P2 vai p/ os
   outros). **Motorista recusa P1** → P2 assume automaticamente.
3. **Dois motoristas** M1/M2 veem P1; M1 aceita → M2 recebe revogação de P1 e
   cai para P2 (exatamente um vencedor de cada corrida).
4. **10 pedidos / 3 motoristas** → FIFO mantida, ninguém é cancelado por engano;
   aceites sucessivos redistribuem sem perder pedidos.
5. **Invariante:** a chegada de P2/P3 não reordena nem remove P1 (cabeça estável;
   fila só cresce no fim).

> Os critérios (5) reconstrução de estado após kill/reopen e (6) teste de carga
> 50 req/min pertencem ao **PR-b** (servidor como fonte da verdade + máquina de
> estados por pedido) e serão cobertos lá.

## Como validar localmente

O jest local está quebrado (layout `.deno` em `node_modules`). Validação dos
módulos puros via esbuild + node com shim de jest:

```
# offerQueue (9 testes)
printf "import '/Users/mamute99/go-xl/src/lib/__tests__/offerQueue.test.ts';" > /tmp/oq.ts
npx esbuild /tmp/oq.ts --bundle --platform=node --format=cjs --outfile=/tmp/oq.cjs --inject:/tmp/jestshim.js && node /tmp/oq.cjs

# dispatchConcurrency (7 testes)
printf "import '/Users/mamute99/go-xl/src/lib/__tests__/dispatchConcurrency.test.ts';" > /tmp/dc.ts
npx esbuild /tmp/dc.ts --bundle --platform=node --format=cjs --outfile=/tmp/dc.cjs --inject:/tmp/jestshim.js && node /tmp/dc.cjs

# typecheck
npx tsc --noEmit
```

Resultado atual: `9 passed, 0 failed`, `7 passed, 0 failed`, `tsc` EXIT 0.

## Roteiro de teste manual (2 aparelhos de motorista + 2 de passageiro)

Pré-condição: `dispatch_multi_offer_fix = true` (jurisdição de teste).

1. **P1 então P2 (mesmo motorista):** M1 online e livre. Passageiro A solicita
   (P1) → M1 toca P1. ~5 s depois, passageiro B solicita (P2) → **P1 continua
   tocando** e P2 fica na fila. Recuse P1 → **P2 assume e toca** na hora.
2. **Aceite esvazia a fila:** repita até M1 ter P1 (cabeça) e P2 (fila). M1
   **aceita P1** → M1 vai para a navegação; **não** volta a tocar P2. P2 é
   redistribuída aos outros motoristas online.
3. **Dois motoristas, um aceita:** M1 e M2 online. Passageiro A solicita → ambos
   tocam P1. M1 aceita → **M2 para de tocar P1** (revogação) e, se houver P2 na
   fila de M2, passa a tocar P2.
4. **Rollback:** ponha `dispatch_multi_offer_fix = false`. Repita o passo 1 → o
   comportamento volta ao slot único legado (P2 substitui P1). Confirma o
   rollback sem redeploy.

## Riscos e rollback

- **Rollback:** flag OFF restaura 1:1 o comportamento antigo (config dinâmica,
  sem build). Nenhuma migration nova neste PR.
- **Sem mudança de contrato:** `pendingRide` e `setPendingRide` seguem exportados
  e com a mesma semântica para os consumidores; a fila é interna ao hook.
- **Escopo contido:** rede/Supabase, alert manager e telas não mudam de regra —
  só a máquina de decisão de qual oferta está na cabeça.
