# Go XL — Bloco 4: tolerância zero, confirmação de embarque e recibo (TNC F.S. 627.748)

Quarto e último dos 4 blocos do COMANDO de compliance da lei de TNC da
Flórida. Escopo do Bloco 4: **três frentes independentes** que não dependiam
de nenhuma das anteriores para existir, mas se apoiam na infraestrutura já
construída nos Blocos 1-3 (máquina de períodos P0-P3, telemetria/log
auditável, gates de onboarding):

1. **Denúncia de segurança → suspensão imediata** para categorias de
   tolerância zero (ex.: motorista intoxicado, agressão).
2. **Confirmação de foto do motorista + placa do veículo** pelo passageiro
   antes do embarque.
3. **Recibo eletrônico completo** para o passageiro, reaproveitando a infra
   de waybill já existente (P4).

## O requisito

O COMANDO pede, sobre a base já construída nos Blocos 1-3:

1. Uma categoria de denúncia que resulte em **suspensão IMEDIATA** do
   motorista, distinta do fluxo normal de revisão administrativa.
2. Um mecanismo para o passageiro **confirmar a identidade do
   motorista/veículo** (foto + placa) antes de embarcar.
3. Um **recibo eletrônico completo** disponível ao passageiro após a
   corrida, com os mesmos dados que hoje só o motorista consegue exportar
   (waybill).

## Decisões de design

### 1. Veredito de suspensão persistido, não recomputado (mesmo padrão do Bloco 3)

`driver_suspensions` é a fonte única de verdade: uma linha com
`lifted_at is null` significa suspensão ativa. Nem o TS nem o SQL
recalculam "o motorista deveria estar suspenso?" a partir do histórico de
denúncias — a suspensão é **criada uma vez**, por um trigger, e só
**lida** depois (`driver_can_go_online()` no servidor; nenhum equivalente
client-side recomputa isso, ao contrário do gate do Bloco 3, porque aqui
não há "razão para mostrar" no cliente antes do servidor decidir — a
suspensão é sempre um bloqueio, não um aviso).

### 2. Auditoria sempre, enforcement condicional (duas flags separadas)

O trigger `trg_auto_suspend_on_zero_tolerance_report` **sempre** cria a
linha em `driver_suspensions` quando a categoria da denúncia é de
tolerância zero — independente de qualquer flag. Isso preserva o
histórico/auditoria mesmo com o bloco inteiro "desligado". Se essa
suspensão de fato **impede** o motorista de ficar online é decidido
separadamente, em `driver_can_go_online()`, pela flag
`safety_suspension_gate_v1_enabled` — checada **antes** do early-return da
flag do Bloco 3 (`onboarding_gates_v1_enabled`), para que os dois blocos
liguem/desliguem de forma independente (regra geral do COMANDO: "feature
flag por bloco", não por COMANDO inteiro).

### 3. Confirmação de embarque: prompt forte, não bloqueio rígido

O gatilho real de `rides.boarded_at` é a transição de status para
`'in_progress'`, disparada pelo motorista via o trigger incondicional
`stamp_ride_period_timestamps` (Bloco 1, migration 0056), usado por toda
corrida desde então. Condicionar essa trigger à confirmação do passageiro
arriscaria travar corridas legítimas se o passageiro estivesse com o app
fechado ou sem internet no momento exato do embarque. A solução adotada:

- o app do **passageiro** mostra a confirmação de forma proeminente assim
  que motorista+veículo são conhecidos (`shouldPromptDriverConfirmation`),
  e grava o aceite via RPC (`confirm_driver_before_boarding`, carimba
  `rides.passenger_confirmed_driver_at`);
- o app do **motorista** mostra um aviso extra — não um bloqueio — se
  tentar avançar para `'in_progress'` sem confirmação registrada
  (`boardingWarning`).

Documentado para revisão: se o requisito estatutário precisar de um
bloqueio rígido, a mudança é em `stamp_ride_period_timestamps` (Bloco 1),
não neste módulo.

### 4. Recibo eletrônico: zero tabelas novas, reaproveita 100% o waybill do P4

`generateAndShareWaybill(rideId, extras)` (`src/lib/waybillExport.ts`) já
é genérico — hoje usado pela `EarningsScreen` do motorista. A única
mudança é wiring: `TripDetailsScreen` (passageiro) chama a mesma função,
passando `{ passengerName }` como `extras`. Nenhuma tabela/coluna nova; a
flag nova (`receipt_passenger_v1_enabled`) só controla se o **botão**
aparece na tela do passageiro — a função em si continua tendo sua PRÓPRIA
checagem interna (`getWaybillConfig(jurisdiction).enabled`, flag do P4,
pré-existente), então as duas flags precisam estar ligadas para o recibo
efetivamente sair (a nova controla a UI; a do P4 controla se a empresa
configurou os dados necessários para gerar o documento).

### 5. UI de denúncia com flag própria, distinta do trigger sempre-ativo do servidor

`safety_reports_v1_enabled` (nova, adicionada nesta sessão) controla
apenas se o botão "denunciar" aparece na tela `RateRideScreen` do
passageiro. O registro em `driver_safety_reports` e o trigger de
suspensão automática (item 2 acima) **sempre** existem no servidor, com ou
sem essa flag — a mesma separação "auditoria sempre, enforcement
condicional" da suspensão em si, mas aplicada um nível acima (visibilidade
de UI em vez de bloqueio de negócio).

## A implementação

### Camada pura (`src/lib/safetyIncidents.ts`, `src/lib/driverBoardingConfirmation.ts`)

| Módulo | Responsabilidade |
|---|---|
| `safetyIncidents.ts` | `SAFETY_INCIDENT_CATEGORIES` (9 categorias) + `ZERO_TOLERANCE_CATEGORIES` (4 delas) + `isZeroToleranceCategory`. `buildSuspensionReason(category)` monta o código persistido em `driver_suspensions.reason` (`zero_tolerance_report:<category>`). `hasActiveSuspension(suspensions)` e `canLiftSuspension(suspension)` são guardas puras usadas por qualquer futuro admin/UI que precise ler/levantar suspensões. |
| `driverBoardingConfirmation.ts` | `shouldPromptDriverConfirmation(input)` — mostra o prompt no passageiro só nos status `accepted`/`driver_en_route`, uma vez por corrida. `canConfirmDriver(input)` — guarda de idempotência usada pela RPC. `boardingWarning(input)` — `'none' \| 'unconfirmed'`, consumido pelo app do motorista. |

Ambos recebem só dados categorizados/booleanos — a descrição livre da
denúncia (texto do passageiro) **nunca** entra em `safetyIncidents.ts`
(mesmo princípio de privacidade do Bloco 3: `disqualificationRules.ts`
nunca via o laudo bruto do background check).

### Camada de persistência (`supabase/migrations/0060_safety_suspension_boarding_bloco4.sql`)

1. `driver_safety_reports` — denúncia (não append-only: admin precisa
   poder atualizar `status`/`resolution_notes` ao revisar). RLS: o
   denunciante lê a própria denúncia; admins leem todas; **o motorista
   denunciado nunca lê via esta policy** (proteção contra retaliação — se
   precisar saber que foi denunciado, isso vem do veredito em
   `driver_suspensions`, não da denúncia bruta). Insert liberado a
   qualquer `authenticated` com `reporter_id = auth.uid()`. Update só
   admin. Sem policy de delete para ninguém além de `service_role`
   (denúncia não se apaga, no máximo vira `'dismissed'`).
2. `driver_suspensions` — veredito persistido (suspensão ativa =
   `lifted_at is null`). RLS: o próprio motorista vê suas suspensões (só o
   motivo categorizado, nunca a denúncia bruta); admins veem todas.
   Insert/update via client: nenhum — só a trigger (item 3) e a RPC
   `lift_driver_suspension` (`security invoker`, checa `is_admin`,
   idempotente — erro claro se já levantada).
3. `is_zero_tolerance_category(category)` (SQL, espelha
   `ZERO_TOLERANCE_CATEGORIES` do TS) + trigger
   `trg_auto_suspend_on_zero_tolerance_report` (`after insert` em
   `driver_safety_reports`, `security definer`) — **sempre** cria a
   suspensão quando a categoria é de tolerância zero, independente de
   qualquer flag (ver Decisão 2).
4. `rides.passenger_confirmed_driver_at timestamptz` (nova coluna) + RPC
   `confirm_driver_before_boarding(ride_id)` (`security invoker`) —
   carimba no servidor, idempotente (`return` silencioso se já
   confirmado), só o próprio passageiro da corrida pode chamar, só em
   status `accepted`/`driver_en_route`/`in_progress`. **Não** usa a
   trigger genérica `stamp_ride_period_timestamps` de propósito (ver
   Decisão 3) — é gravado só por ação explícita do passageiro.
5. `driver_can_go_online(p_driver_id)` — **estendida** (não substituída):
   `create or replace function` preserva byte a byte a lógica do Bloco 3
   (migration 0059), e adiciona a checagem de suspensão de tolerância zero
   ANTES do early-return da flag `onboarding_gates_v1_enabled`, atrás da
   sua própria flag `safety_suspension_gate_v1_enabled`.
6. Nenhuma tabela/função nova para o recibo — reaproveita `waybills`
   (migration do P4) integralmente.
7. Seeds idempotentes em `system_config`: `safety_suspension_gate_v1_enabled`
   (`false`), `driver_confirmation_required` (`false`),
   `receipt_passenger_v1_enabled` (`false`), `safety_reports_v1_enabled`
   (`false`) — todas jurisdição `'global'`.

### Camada de wiring (cliente)

| Arquivo | Papel |
|---|---|
| `src/hooks/useDriverBoardingConfirmation.ts` | Busca `driver_confirmation_required` resolvido por jurisdição, computa `shouldPrompt` via `shouldPromptDriverConfirmation`, expõe `confirm()` que chama a RPC e espelha o carimbo localmente (mesmo padrão de `refreshDisclosureAcceptance` do Bloco 3). |
| `src/screens/passenger/ActiveRideScreen.tsx` | Usa o hook acima; mostra o prompt `confirmDriverPrompt` quando `shouldPrompt` é `true`; em falha da RPC mostra `confirmDriverTitle`/`confirmDriverFailed`. |
| `src/screens/driver/DriverNavigateScreen.tsx` | Lê `driver_confirmation_required` + `ride.passenger_confirmed_driver_at`, computa `boardingWarning`; se `'unconfirmed'`, mostra um `Alert` não bloqueante (`boardingConfirmationWarningTitle`/`Msg`) antes de prosseguir para o próximo estágio — o motorista pode confirmar "OK" e continuar mesmo assim. |
| `src/screens/passenger/RateRideScreen.tsx` | Nova seção de denúncia, atrás de `safety_reports_v1_enabled` (`useFeatureFlag`). Chips de categoria (`SAFETY_INCIDENT_CATEGORIES`), campo de descrição opcional, `Alert` de confirmação antes de enviar (ação sensível — pode disparar suspensão imediata), insert direto em `driver_safety_reports` (mesmo padrão de `submitRating()` já existente na tela — RLS já cobre, sem necessidade de RPC dedicada). |
| `src/screens/passenger/TripDetailsScreen.tsx` | Botão "baixar recibo", atrás de `receipt_passenger_v1_enabled` e só para `ride.status === 'completed'`. Chama `generateAndShareWaybill(ride.id, { passengerName })`; erro `'disabled'` (flag do P4 desligada) é engolido silenciosamente — mesmo padrão já usado em `EarningsScreen.tsx` — só falhas genuínas mostram `Alert`. |

## Interpretações registradas para revisão (comportamento ambíguo do comando)

- **Lista de categorias de tolerância zero**: a F.S. 627.748 exige
  explicitamente uma política de tolerância zero quanto a uso de
  álcool/drogas pelo motorista em serviço — esse é o núcleo estatutário
  certo (`driver_intoxication`). As outras três categorias
  (`sexual_assault`, `physical_assault`, `weapon_possession`) são uma
  **extensão por analogia** ao padrão usual do setor de TNC
  (Uber/Lyft tratam essas categorias como tolerância zero também), **não**
  uma citação direta do estatuto. Precisa de revisão jurídica/compliance
  antes de habilitar em produção (`safety_suspension_gate_v1_enabled`,
  default OFF). A lista é fixa no código (não configurável por
  jurisdição via `system_config`) porque é curta e binária — se precisar
  variar por jurisdição no futuro, mover para `system_config` é o
  fast-follow natural (mesmo espírito do limiar do Bloco 3).
- **Confirmação de embarque como prompt, não bloqueio rígido**: ver
  Decisão de design #3 — o COMANDO não especifica se a confirmação deve
  IMPEDIR o embarque; a interpretação adotada prioriza não travar
  corridas legítimas por falha de conectividade do passageiro. Se a
  leitura jurídica exigir bloqueio rígido, a mudança é em
  `stamp_ride_period_timestamps` (Bloco 1) — fora do escopo deste bloco
  para não arriscar uma trigger em produção usada por toda corrida desde
  o Bloco 1.
- **Recibo eletrônico = waybill reaproveitado, não um documento novo**: o
  COMANDO pede "recibo eletrônico completo"; a interpretação adotada é que
  os dados do waybill (já auditado/RBAC/retenção no P4) satisfazem esse
  requisito, evitando duplicar um segundo formato de documento fiscal/de
  viagem. Requer confirmação de que o conteúdo do waybill atual (preço,
  rota, horários, motorista, veículo) cobre o que a lei exige como
  "recibo" para o passageiro.

## Feature flags (rollout gradual + rollback)

`src/lib/systemConfig.ts` → `CONFIG_DEFAULTS`:

```
safety_suspension_gate_v1_enabled: false   // DESLIGADA por padrão
driver_confirmation_required: false        // DESLIGADA por padrão
receipt_passenger_v1_enabled: false        // DESLIGADA por padrão
safety_reports_v1_enabled: false           // DESLIGADA por padrão
```

- **`safety_suspension_gate_v1_enabled` OFF (padrão)**: `driver_suspensions`
  continua sendo alimentada normalmente pelo trigger (auditoria nunca
  para), mas `driver_can_go_online()` **ignora** essa tabela — o motorista
  suspenso continua conseguindo ficar online (comportamento idêntico ao
  pré-Bloco-4). Independente de `onboarding_gates_v1_enabled` (Bloco 3).
- **`safety_suspension_gate_v1_enabled` ON**: motorista com qualquer
  suspensão ativa (`lifted_at is null`) não consegue ficar online — vale
  mesmo com o Bloco 3 desligado.
- **`driver_confirmation_required` OFF (padrão)**: nenhum prompt no
  passageiro, nenhum aviso no motorista — telas de embarque idênticas ao
  pré-Bloco-4.
- **`driver_confirmation_required` ON**: liga o prompt (passageiro) + aviso
  não bloqueante (motorista). Nunca bloqueia `boarded_at`/`in_progress`
  independente do valor desta flag (ver Decisão 3).
- **`receipt_passenger_v1_enabled` OFF (padrão)**: botão de recibo some da
  `TripDetailsScreen`. Precisa estar ON **e** a flag do P4
  (`getWaybillConfig(jurisdiction).enabled`) também estar configurada para
  o passageiro conseguir efetivamente baixar o recibo.
- **`safety_reports_v1_enabled` OFF (padrão)**: botão de denúncia some da
  `RateRideScreen`. O trigger de suspensão automática no servidor continua
  ativo de qualquer forma — se uma denúncia entrar por outro canal (admin,
  suporte inserindo diretamente), ainda dispara suspensão normalmente.

## Parâmetros configuráveis

| Chave (`system_config`) | Default | O que controla |
|---|---|---|
| `safety_suspension_gate_v1_enabled` | `false` | Liga o BLOQUEIO de `driver_can_go_online()` para motoristas com suspensão ativa. Não afeta a criação da suspensão em si (sempre ativa via trigger). |
| `driver_confirmation_required` | `false` | Liga o prompt de confirmação de foto+placa no passageiro e o aviso correspondente no motorista. Nunca bloqueia o embarque. |
| `receipt_passenger_v1_enabled` | `false` | Mostra o botão de baixar recibo eletrônico na `TripDetailsScreen` do passageiro (corrida concluída). Depende também da flag interna do waybill (P4) estar configurada. |
| `safety_reports_v1_enabled` | `false` | Mostra o botão/formulário de denúncia de segurança na `RateRideScreen` do passageiro. Não afeta o trigger de suspensão automática no servidor, que é sempre ativo. |

## Limitações conhecidas (fast-follow, não bloqueiam o Bloco 4)

- **Nenhuma UI de admin para revisar denúncias/suspensões ainda** —
  `driver_safety_reports.status`/`resolution_notes` e a RPC
  `lift_driver_suspension` existem no servidor, mas não há tela admin
  dedicada nesta entrega (mesmo padrão do Bloco 3: a RPC/coluna existe,
  o fluxo de revisão humana fica pra depois). Hoje, levantar uma
  suspensão ou revisar uma denúncia exige SQL direto por um admin com
  acesso (`lift_driver_suspension(uuid, text)`).
- **Lista de categorias de tolerância zero fixa no código** — ver
  "Interpretações registradas" acima; exposição via `system_config` por
  jurisdição é fast-follow se a revisão jurídica pedir variação regional.
- **Confirmação de embarque nunca bloqueia** — por design (Decisão 3);
  se a lei exigir bloqueio rígido, é mudança de escopo maior (trigger do
  Bloco 1), documentada aqui para não ser esquecida.
- **Recibo eletrônico depende de duas flags simultâneas** —
  `receipt_passenger_v1_enabled` (nova) E a config do waybill do P4
  (`getWaybillConfig`) precisam estar ambas prontas; isso não é um bug,
  mas pode confundir no rollout se só uma delas for ligada — documentar no
  runbook de ativação.

## Arquivos

| Arquivo | Mudança |
|---|---|
| `src/lib/safetyIncidents.ts` | **novo** — classificação de categorias de denúncia + tolerância zero. |
| `src/lib/__tests__/safetyIncidents.test.ts` | **novo** — testes do núcleo puro. |
| `src/lib/driverBoardingConfirmation.ts` | **novo** — regra pura de prompt/aviso de confirmação de embarque. |
| `src/lib/__tests__/driverBoardingConfirmation.test.ts` | **novo** — testes do núcleo puro. |
| `supabase/migrations/0060_safety_suspension_boarding_bloco4.sql` | **novo** — `driver_safety_reports`, `driver_suspensions`, trigger de auto-suspensão, `lift_driver_suspension`, `rides.passenger_confirmed_driver_at` + `confirm_driver_before_boarding`, extensão de `driver_can_go_online()`, seeds das 4 flags. |
| `src/hooks/useDriverBoardingConfirmation.ts` | **novo** — wiring do prompt/confirmação no cliente (passageiro). |
| `src/screens/passenger/ActiveRideScreen.tsx` | Prompt de confirmação de motorista/veículo. |
| `src/screens/driver/DriverNavigateScreen.tsx` | Aviso não bloqueante se avançar sem confirmação do passageiro. |
| `src/screens/passenger/RateRideScreen.tsx` | Seção de denúncia de segurança (categorias + descrição + confirmação antes de enviar). |
| `src/screens/passenger/TripDetailsScreen.tsx` | Botão de recibo eletrônico (reaproveita `generateAndShareWaybill`). |
| `src/lib/driverOnboardingGate.ts`, `src/hooks/useDriverOnboardingGate.ts`, `src/screens/driver/DriverHomeScreen.tsx` | `evaluateOnboardingGate` ganha o motivo `safety_suspension` (veredito lido, nunca recomputado); o hook do Bloco 3 passa a ler `driver_suspensions` (RLS própria + realtime) e repassar `safetySuspended`; `DriverHomeScreen.handleOnlineChange` ganha um novo `if` — primeiro da cadeia, mesma prioridade do servidor — mostrando alerta específico (`driver.suspendedTitle`/`Body`) quando o motorista tenta ficar online estando suspenso. Fecha a lacuna entre o campo/testes de `safetySuspended` (que já existiam) e o wiring real de dados. |
| `src/i18n/translations.ts` | Novas chaves `tripDetails.*` (recibo), `driverNav.boardingConfirmationWarning*`, `activeRide.confirmDriver*`, `rate.report*` e `rate.category.*` — en/es/pt. |
| `src/lib/systemConfig.ts` | flags `safety_suspension_gate_v1_enabled: false`, `driver_confirmation_required: false`, `receipt_passenger_v1_enabled: false`, `safety_reports_v1_enabled: false`. |
| `docs/bloco4-tolerancia-zero-embarque-recibo.md` | **novo** — este documento. |

## Cobertura de testes

Núcleo puro — **41 testes passam, 0 falham** (`safetyIncidents.test.ts` +
`driverBoardingConfirmation.test.ts`). Suíte completa do projeto (todos os
módulos, não só Bloco 4): **471 passam, 0 falham**. `npx tsc --noEmit`
limpo.

```
npx jest src/lib/__tests__/safetyIncidents.test.ts src/lib/__tests__/driverBoardingConfirmation.test.ts
npx jest    # suíte completa
npx tsc --noEmit
```

## Roteiro de teste manual (ambiente de teste, jurisdição isolada)

Pré-condições: migration 0060 aplicada; as 4 flags do Bloco 4 ligadas na
jurisdição de teste; uma corrida de teste com motorista+veículo atribuídos.

1. **Flags OFF preservam comportamento atual:** com as 4 flags desligadas,
   confirme que (a) nenhum prompt/aviso de confirmação aparece, (b) nenhum
   botão de denúncia/recibo aparece, (c) um motorista com suspensão ativa
   (inserida manualmente) ainda consegue ficar online.
2. **Denúncia de tolerância zero suspende automaticamente:** com
   `safety_reports_v1_enabled = true`, na tela de avaliação da corrida,
   registre uma denúncia com categoria `driver_intoxication`. Confirme
   direto no banco que `driver_suspensions` ganhou uma linha nova
   (`reason = 'zero_tolerance_report:driver_intoxication'`, `lifted_at`
   nulo) — mesmo com `safety_suspension_gate_v1_enabled` ainda desligada
   (a suspensão é criada independente da flag de enforcement).
3. **Enforcement bloqueia:** ligue `safety_suspension_gate_v1_enabled`.
   Confirme que o motorista do passo 2 não consegue mais ficar online
   (`driver_can_go_online()` devolve `false` via SQL direto).
4. **Denúncia normal não suspende:** registre uma denúncia com categoria
   `other` ou `discrimination`. Confirme que **nenhuma** linha nova aparece
   em `driver_suspensions`.
5. **Levantar suspensão:** como admin, chame
   `lift_driver_suspension(<id>, 'revisado, sem evidência')`. Confirme
   `lifted_at`/`lifted_by`/`lift_notes` preenchidos e que o motorista volta
   a conseguir ficar online. Tente chamar de novo com o mesmo `id` —
   confirme erro `'suspensão já foi levantada'`.
6. **Confirmação de embarque (passageiro):** com
   `driver_confirmation_required = true`, abra a tela de corrida ativa do
   passageiro assim que o motorista aceitar — confirme que o prompt de
   foto+placa aparece. Toque em confirmar; confirme
   `rides.passenger_confirmed_driver_at` preenchido no banco.
7. **Aviso não bloqueante (motorista):** sem confirmar do lado do
   passageiro, no app do motorista avance para o próximo estágio até a
   transição para `'in_progress'`. Confirme que aparece o alerta de aviso
   (não travamento) e que, ao tocar "OK", a corrida segue normalmente para
   `in_progress`/`boarded_at` gravado.
8. **Recibo eletrônico:** conclua a corrida de teste. Com
   `receipt_passenger_v1_enabled = true` e a config do waybill (P4) já
   configurada para a jurisdição, abra `TripDetailsScreen` e toque em
   baixar recibo — confirme que o PDF é gerado/compartilhado com o nome do
   passageiro. Desligue só a flag do P4 (mantendo esta ligada) e confirme
   que o erro é engolido silenciosamente (sem `Alert` de falha).
9. **Rollback:** desligue as 4 flags. Confirme que tudo volta ao
   comportamento do passo 1 imediatamente (config dinâmica, sem redeploy).

## Riscos e rollback

- **Rollback do bloco:** cada uma das 4 flags desliga sua própria frente
  independentemente, sem redeploy. `safety_suspension_gate_v1_enabled = false`
  interrompe o bloqueio de motoristas suspensos imediatamente; as outras 3
  flags controlam apenas visibilidade de UI (sem risco de dados — nada é
  perdido ao desligar, só deixa de aparecer).
- **Sem mudança de contrato para blocos anteriores:** `driver_can_go_online()`
  preserva byte a byte a lógica do Bloco 3 (0059); `stamp_ride_period_timestamps`
  (Bloco 1) não é tocada; nenhuma tabela do Bloco 2 (telemetria) é alterada.
- **Auditoria de denúncias nunca para:** mesmo com todas as flags
  desligadas, `driver_safety_reports` e `driver_suspensions` continuam
  sendo alimentadas normalmente por qualquer inserção (ex.: futuro canal
  de admin/suporte) — o histórico de compliance não depende de nenhuma
  flag deste bloco.
- **Pendente antes de fechar o Bloco 4:** aplicar (`supabase db push`) a
  migration 0060 no ambiente remoto, e commitar as mudanças — aguardando
  autorização explícita do usuário para ambas as ações, por protocolo.
