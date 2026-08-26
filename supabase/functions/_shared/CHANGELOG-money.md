# CHANGELOG — dinheiro

Toda mudança que altera **quando dinheiro sai, entra ou deixa de sair** entra aqui.
Uma linha por defeito. `arquivo:linha` aponta para onde a correção MORA, não para
onde o defeito estava.

Coluna "teste": o que existe é teste de **lógica pura** em Jest
(`_shared/__tests__/`). Não há Postgres, não há Docker e não há chamada ao
Stripe neste repositório — nenhuma migration de 0064 em diante jamais rodou, e
nenhum comportamento do Stripe foi exercitado. "sim" significa "a decisão foi
verificada", nunca "o caminho de ponta a ponta foi verificado".

| id | defeito | correção mora em | teste |
|----|---------|------------------|-------|
| S1 | `--no-verify-jwt` + `isServiceRole` que só fazia `atob` do payload: `Bearer x.<base64 de {"role":"service_role"}>.x` disparava estornos não autenticados em lote | `_shared/serviceAuth.ts:87` (`isServiceRoleCaller`, comparação da chave inteira); chamada em `sweep-stale-requesting/index.ts:212` | sim — `_shared/__tests__/serviceAuth.test.ts` |
| S2 | `isAcceptingDriver && isConfigFlagEnabled('dispatch_engine_v2')`: flag default `false` e nenhuma migration a liga, o `&&` curto-circuitava e a exigência de oferta nunca rodava — qualquer motorista cobrava qualquer corrida aberta | `_shared/chargeAuth.ts:165` (`decideChargeAuthorization`, nega por padrão); elegibilidade derivada pelo servidor em `charge-ride/index.ts:681` (`driverAcceptEligibility`); exclusividade por reserva atômica em `:239`/`:733` (`claimOpenRide`) | sim (decisão) — `_shared/__tests__/chargeAuth.test.ts`; **não** (elegibilidade e atomicidade da reserva: exigem Postgres) |
| S2b | a 1ª correção do S2 exigia PROVA DE OFERTA em `ride_push_offers`, gravada sobre a lista de ids **que o cliente mandava** (`is_online = true`). Concedia demais (todo motorista online ganhava direito de cobrança off-session naquele cartão por 2 h) e recusava legítimos: sem ninguém online no instante do pedido, a corrida nascia com zero linhas e **todo** aceite posterior levava 403 para sempre | a prova deixou de decidir cobrança e virou auditoria — `send-ride-push/index.ts:189` (`onlineDriverIds`, leque derivado com a service key) e `recordPushOffers` logo abaixo; decisão de cobrança migrou para a elegibilidade do S2 | sim (decisão) — `_shared/__tests__/chargeAuth.test.ts`; **não** (que a gravação de auditoria funciona) |
| S2c | `notifyOnlineDrivers`/`pushSilentRevokeToOnlineDrivers` liam `driver_locations` no CLIENTE e faziam `return` sobre lista vazia: leitura vazia, RLS mudando de baixo ou rede caindo e a corrida nascia **sem nenhum push**, sem erro aparecer — o cliente podia cancelar a distribuição inteira | `src/hooks/useRide.ts:190` e `:365` (a requisição sempre sai; o leque e o "não há ninguém online" passam a ser constatação do servidor) | **não** — exige entrega de push |
| S3 | `await admin.rpc('assign_driver_tier', …)` com erro descartado depois de já ter escrito `stripe_charges_enabled = true`: motorista ficava com `driver_share_percent` NULL e os dois cálculos de split coagiam NULL → 0.80, pagando 80/20 a motorista da faixa 85/15 | `stripe-webhook/index.ts:604` (confere o erro, NÃO grava `charges_enabled`, grava conciliação `needs_attention` e devolve 500 para o Stripe reentregar) | **não** — exige webhook do Stripe e banco |
| S3b | a correção do S3 fechou UMA das duas portas. `connect-account-status/index.ts` escrevia `charges_enabled = true` primeiro e descartava o erro da RPC — e é a porta MAIS usada: `src/hooks/useConnectAccount.ts:43` a chama a cada abertura do app do motorista, e a 0038 a designa como a consulta corretiva. O webhook recusava corretamente e a próxima abertura do app habilitava assim mesmo | `connect-account-status/index.ts:107` (`needsTier`, mesma forma do webhook: RPC antes, erro confere, 503 sem gravar `charges_enabled`) | **não** — exige Stripe e banco |
| S4 | estorno da varredura decidia sobre uma releitura e só marcava `paid = false` DEPOIS: um aceite no intervalo fazia o estorno sair sobre corrida em andamento — viagem de graça e motorista sem repasse | `_shared/refundFlow.ts:229` (porta `claim` antes de qualquer ida ao Stripe; `compensateClaim` em `:329` e `:340`); update condicional em `sweep-stale-requesting/index.ts:431` | sim (ordem e compensação) — `_shared/__tests__/refundFlow.test.ts`; **não** (atomicidade do `update … where`: garantia do Postgres) |
| S5 | `resource_missing` tratado como "nunca existiu" e seguido de cobrança nova; o Stripe devolve o mesmo código para objeto invisível à chave em uso (rotação, live × test) → cobrança dupla em série | `_shared/chargeCycle.ts:151` (`classifyMissingIntent`) e `:204` (`createMissingIntentBreaker`); decisão em `charge-ride/index.ts:300` | sim (classificação e disjuntor) — `_shared/__tests__/chargeCycle.test.ts`; **não** (que o Stripe devolve esse código nesses casos) |
| S6 | corrida varrida ficava `requesting` + `paid = false` + sem motorista para sempre; o passageiro via "procurando motorista" por uma viagem estornada 30 min antes | mesma reserva condicional do S4 — `sweep-stale-requesting/index.ts:431` move para `cancelled` + `cancellation_reason`; aviso ao passageiro em `:577`; coluna em `migrations/0070_offer_proof_and_cancellation_reason.sql:111` | **não** — exige banco e entrega de push |
| S7 | `timeout_milliseconds := 60000` contra laço sequencial de até 100 estornos: o `pg_net` largava a resposta, o Deno continuava estornando e o corte era invisível | `sweep-stale-requesting/index.ts` (`MAX_PER_RUN = 15`, `RUN_BUDGET_MS`, linha de resumo `run_summary`) + `:345`, que agora CHAMA `alertAdmins` quando trunca — antes o sinal era gravado e não chegava a ninguém | **não** — o número 15 é escolha conservadora, não medição; a latência do Stripe por estorno não foi medida |
| S8 | corrida que ninguém aceitou nunca fica `paid` (a cobrança acontece NO ACEITE), e a varredura filtra `paid = true` — logo ela nunca era candidata a nada e ficava `requesting` para sempre. Nenhum dos seis `cron.schedule` do repositório a alcançava. O passageiro via "procurando motorista" indefinidamente | `sweep-stale-requesting/index.ts:437` (`cancelStaleUnpaid` — sem Stripe: não houve PaymentIntent, não há estorno; avisa o passageiro sem falar em devolução) | **não** — exige banco e entrega de push |
| S9 | regressão criada pela reserva atômica do S2: se a invocação do `charge-ride` morre entre `claimOpenRide` e a devolução (ou se a devolução falha), a corrida fica `requesting` + `driver_id` preenchido + não paga. Nesse estado ninguém a aceita — a RLS a esconde dos outros motoristas e o reoferecimento filtra `driver_id is null` | `sweep-stale-requesting/index.ts:390` (`releaseOrphanClaims`, fuse de 5 min, `where` com as mesmas guardas do S4 para não soltar corrida que passou a valer) | **não** — exige banco |

## Ordem de implantação

**A trava de ordem descrita aqui antes NÃO existe mais** — ela era consequência
do desenho do S2b (aceite dependia de uma linha gravada por outra função) e caiu
junto com ele. `charge-ride` decide sobre fatos que já estão em `profiles` e
sobre uma função que a 0065 já criou; `ride_push_offers` só recebe auditoria e
uma falha nela não impede aceite nenhum.

O que **continua** valendo: a 0070 precisa ter rodado antes de `send-ride-push`
tentar gravar auditoria — senão a gravação falha e o erro vira só uma linha de
log (`Falha ao registrar ride_push_offers`). Ninguém deixa de rodar, mas a
resposta a "para quem o telefone tocou?" fica vazia justamente no período em que
ela seria mais útil.

Nada disso foi exercitado: **nenhuma migration de 0064 em diante jamais rodou.**

## Contradição herdada, não corrigida aqui

`run-weekly-payouts/index.ts:25` manda publicar com `--no-verify-jwt`, e
`:55-61` do MESMO arquivo afirma que a função é "publicada COM verify_jwt" e que
"o gateway já validou a ASSINATURA". As duas coisas não podem ser verdade. O
arquivo está em edição pelo dono e não foi tocado — a correção correta é a mesma
do S1: `isServiceRoleCaller` de `_shared/serviceAuth.ts`, que acerta com ou sem
a flag de deploy.

## Recomendação em aberto (S3) — não aplicada

`src/lib/split.ts:78-82` (`shareToMilli`) e `0065_money_write_guard.sql:716-717`
coagem `driver_share_percent` NULL para 0.80. Silenciosamente. Enquanto essa
coerção existir, qualquer furo futuro na atribuição de faixa volta a pagar
80/20 a motorista de 85/15 sem deixar rastro — a correção do S3 fecha a porta
conhecida, não a classe. O certo é a coerção virar recusa dura. Não foi feito:
`split.ts` é arquivo protegido em edição pelo dono.
