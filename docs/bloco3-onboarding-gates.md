# Go XL — Bloco 3: onboarding e gestão de motoristas (gates legais, TNC F.S. 627.748)

Terceiro dos 4 blocos do COMANDO de compliance da lei de TNC da Flórida.
Escopo do Bloco 3: **gates de onboarding** que decidem se o motorista pode
ficar online — verificação de identidade (já existia), **background check**
(abstração já existia via P7; o que faltava era a **regra de desqualificação**
e o **recheck periódico**), e o **aceite do disclosure legal**. Log auditável
+ relatórios ficaram no Bloco 2; tolerância zero + recibo eletrônico ficam no
Bloco 4 — ainda não iniciado.

## O requisito

O COMANDO pede, sobre a base já construída no Bloco 1 (máquina P0-P3) e no
P7 (background check abstrato):

1. **Regras de desqualificação** — achados de background check que impedem o
   motorista de dirigir, com categorias de bane vitalício e categorias de
   limiar configurável (contagem numa janela de anos).
2. **Recheck periódico** ("trienal") do background check, independente da
   validade operacional já existente.
3. **Aceite do disclosure legal** rastreado (quem aceitou, quando, qual
   versão do texto).
4. Tudo isso unificado num único gate de "pode ficar online", testado, com
   feature flag própria e espelhado no servidor (o cliente nunca é a
   autoridade final).

## Decisões de design

### 1. `evaluateOnboardingGate` como fonte única da regra (TS e SQL concordam)

Antes deste bloco cada gate era checado num `if` separado dentro de
`DriverHomeScreen.handleOnlineChange` — bom para UX (dá o aviso certo), ruim
como fonte única de verdade da regra. `src/lib/driverOnboardingGate.ts`
unifica TODOS os gates numa função pura (`evaluateOnboardingGate`), usada em
dois lugares:

1. pelo hook do motorista (`useDriverOnboardingGate`), para decidir qual
   aviso mostrar;
2. como especificação de referência para `driver_can_go_online()` (SQL,
   migration 0059) que o Postgres aplica de verdade via trigger em
   `driver_locations` — o client nunca é a autoridade final.

As duas implementações precisam concordar na mesma ordem/regra; qualquer
mudança de regra em uma precisa ser espelhada na outra (documentado no
cabeçalho de ambas).

### 2. Veredito de desqualificação persistido, não recomputado em dois lugares

`evaluateDisqualification` (`src/lib/disqualificationRules.ts`) é uma função
pura que recebe achados categorizados (`DisqualificationFindings`) e devolve
`{ disqualified, reasons }`. Reimplementar essa lógica de janela/contagem em
PL/pgSQL criaria **duas cópias divergentes** de uma regra de interpretação
legal sensível. A solução adotada: quem computa o veredito (hoje, nenhum
processo automatizado — ver limitação conhecida abaixo; no futuro, um fluxo
de revisão admin) **persiste** o resultado em
`driver_background_checks.disqualified`/`disqualification_reasons`, e:

- o SQL (`driver_can_go_online()`) só **lê** essas colunas, nunca reavalia
  achados;
- o cliente (`useDriverOnboardingGate` → `evaluateOnboardingGate`) também só
  **lê** o veredito persistido, via o novo parâmetro opcional
  `backgroundCheckDisqualified: boolean` — quando informado, tem prioridade
  sobre `disqualificationFindings` (que continua existindo no tipo, para uso
  por quem efetivamente COMPUTA o veredito a partir dos achados brutos).

### 3. Dois relógios independentes para o background check

`background_check_valid_days` (P7, já existente, default 365) é a validade
**operacional**: quando vence, `status='clear'` deixa de contar como válido
e o motorista já cai fora até renovar. `background_check_recheck_years`
(Bloco 3, novo, default 3) é um **teto independente e mais longo**: mesmo
que a validade operacional configurada seja mais longa que 3 anos (ou sem
expiração), o motorista ainda precisa refazer o check a cada N anos. As duas
regras são computadas ao vivo (sem estado sincronizado por cron) e
acumulam-se — a mais restritiva prevalece porque `evaluateOnboardingGate`
soma todos os motivos aplicáveis, não para no primeiro.

## A implementação

### Camada pura (`src/lib/disqualificationRules.ts`, `src/lib/driverOnboardingGate.ts`)

| Módulo | Responsabilidade |
|---|---|
| `disqualificationRules.ts` | `evaluateDisqualification(findings, thresholds, now)` — bane vitalício (crime violento, ofensa sexual, tráfico humano/exploração, predador sexual registrado, CNH suspensa/cassada — sempre desqualificam, sem janela) + categorias de limiar configurável (felony, DUI, violação grave de trânsito — cada uma com `lookbackYears`/`maxCount`). Devolve TODOS os motivos aplicáveis. |
| `driverOnboardingGate.ts` | `evaluateOnboardingGate(input)` — soma verificação de identidade, background check (válido + recheck em dia + não desqualificado), Stripe Connect, disclosure legal. `isBackgroundCheckRecheckDue(record, years, now)` — auxiliar exportada separadamente (testada isoladamente). |

Ambos recebem só booleans/contagens/datas categorizadas — **nunca** o laudo
bruto do provider (mesmo princípio de privacidade já em vigor desde o P7:
`driver_background_checks.result` guarda só um resumo não sensível).

### Camada de persistência (`supabase/migrations/0059_onboarding_gates_bloco3.sql`)

1. `driver_background_checks` ganha `disqualified boolean default false` +
   `disqualification_reasons text[] default '{}'` — o veredito persistido
   (ver Decisão 2 acima).
2. `driver_disclosure_acceptances` — nova tabela **append-only** (mesmo
   padrão de `driver_period_transitions`, Bloco 1/2): `driver_id`,
   `disclosure_key`, `version`, `accepted_at`, `unique(driver_id,
   disclosure_key, version)`. Trigger `BEFORE UPDATE`/`BEFORE DELETE`
   rejeita qualquer mutação — histórico de aceite nunca é apagado nem
   sobrescrito, mesmo quando a versão do texto muda.
3. RPC `accept_driver_disclosure(p_disclosure_key, p_version)` —
   `security invoker`, insere `(auth.uid(), ...)` com `on conflict ... do
   nothing` (idempotente ao reaceitar a mesma versão). Só `authenticated`.
4. `resolve_config_bool`/`resolve_config_numeric` — funções SQL que
   replicam a resolução "jurisdição específica → global → default" já
   implementada em `systemConfig.ts` (TS) e `adminConfigFlag.ts` (Deno),
   agora nativa em Postgres para o trigger de gating não precisar de round-
   trip a uma Edge Function. `service_role` apenas.
5. `driver_can_go_online(p_driver_id)` — a função de referência SQL: se
   `onboarding_gates_v1_enabled` está OFF para a jurisdição, devolve `true`
   sempre (comportamento inalterado). Ligada: checa verificação de
   identidade → background check (existe, `status='clear'`, não expirado,
   `disqualified=false`, `checked_at` dentro do recheck trienal) →
   disclosure aceito (se exigido). **Não** checa Stripe — isso já é feito
   incondicionalmente pelo trigger existente (ver item 6).
6. `enforce_driver_online_gating()` (migration 0038) — **estendida**, não
   substituída: o corpo é recriado via `create or replace function`
   preservando byte a byte a checagem incondicional de Stripe Connect já
   existente, e ao final chama `driver_can_go_online()`. O trigger
   `trg_driver_online_gating` (0038) não precisa ser redefinido — só o
   corpo da função mudou.
7. Seeds idempotentes em `system_config`: `onboarding_gates_v1_enabled`
   (`false`), `background_check_recheck_years` (`3`),
   `driver_disclosure_required` (`false`), `driver_disclosure_version`
   (`'1'`) — todas jurisdição `'global'`.

### Camada de wiring (cliente)

| Arquivo | Papel |
|---|---|
| `src/hooks/useDriverOnboardingGate.ts` | Compõe `useBackgroundCheck` (P7) + leitura de `disqualified` + config resolvida por jurisdição + existência de aceite em `driver_disclosure_acceptances`, chama `evaluateOnboardingGate`, expõe `reasons`/`canGoOnline`/`acceptDisclosure()`. Realtime nas duas tabelas novas relevantes. |
| `src/screens/driver/DriverDisclosureScreen.tsx` | Mesmos moldes visuais da `DriverInsuranceScreen` (Bloco 1): explica em linguagem simples os 4 pontos do disclosure (background check periódico + bane vitalício, cobertura de seguro por período, tolerância zero, uso de dados) e tem um botão de aceite que chama `acceptDisclosure()`. |
| `src/screens/driver/DriverHomeScreen.tsx` (`handleOnlineChange`) | 3 novos `if` inseridos na cadeia já existente (verificação → background check → **[novo] desqualificado → [novo] recheck devido** → Stripe → **[novo] disclosure** → descanso obrigatório), preservando a ordem/estilo atual em vez de refatorar tudo para `evaluateOnboardingGate` de uma vez — minimiza o diff/risco. Os motivos já cobertos por `if`s existentes (`verification_pending`, `background_check_required`, `payout_setup_incomplete`) não são duplicados pelo hook novo. |
| `src/navigation/AppNavigator.tsx`, `src/types/index.ts` | Nova rota `Disclosure` no stack do motorista, mesmo padrão `getComponent` lazy da rota `Insurance`. |

## Interpretações registradas para revisão (comportamento ambíguo do comando)

- **Lista de ofensas desqualificantes e limiares**: a F.S. 627.748 é focada
  em SEGURO, não define uma lista de ofensas desqualificantes. As categorias
  e limiares em `DEFAULT_DISQUALIFICATION_THRESHOLDS` são uma
  **interpretação razoável** modelada nos padrões usuais do setor de TNC
  (Uber/Lyft-style): bane vitalício para crime violento/sexual/tráfico
  humano/predador sexual registrado/CNH suspensa-cassada; limiar de
  contagem (felony e DUI: qualquer ocorrência em 7 anos desqualifica;
  violação grave de trânsito: tolera até 2 em 3 anos, a 3ª desqualifica)
  para as demais. **Não é citação de uma subseção específica do estatuto —
  precisa de revisão jurídica antes de habilitar em produção**
  (`onboarding_gates_v1_enabled`, default OFF). Configurável por
  jurisdição via `system_config` (thresholds ainda não expostos via
  `system_config` — só os 4 parâmetros novos deste bloco estão; os limiares
  de `DisqualificationThresholds` hoje só têm o default do código — ver
  limitação conhecida abaixo).
- **Recheck trienal × validade operacional**: ver Decisão de design #3
  acima — as duas regras são independentes por design, a mais restritiva
  prevalece.
- **Veredito de desqualificação persistido vs. recomputado**: ver Decisão
  de design #2 — escolhido para não duplicar lógica sensível em duas
  linguagens/runtimes.

## Feature flags (rollout gradual + rollback)

`src/lib/systemConfig.ts` → `CONFIG_DEFAULTS`:

```
onboarding_gates_v1_enabled: false     // DESLIGADA por padrão
background_check_recheck_years: 3
driver_disclosure_required: false      // DESLIGADA por padrão
driver_disclosure_version: '1'
```

- **`onboarding_gates_v1_enabled` OFF (padrão)**: `driver_can_go_online()`
  sempre devolve `true` — o gate de disponibilidade no servidor fica
  exatamente como estava antes do Bloco 3 (só verificação de identidade +
  Stripe Connect, migration 0038). No cliente, `useDriverOnboardingGate`
  continua computando `reasons` normalmente (é só leitura, sem custo de
  segurança deixá-lo ligado), mas o SERVIDOR é quem decide de fato — se o
  cliente e o servidor discordarem, o servidor vence (linha nunca é gravada
  com `is_online=true` fora da regra).
- **`onboarding_gates_v1_enabled` ON**: liga os 3 gates novos (desqualificação,
  recheck, disclosure) para a jurisdição. Habilitar só após revisão jurídica
  dos limiares de desqualificação e validação em ambiente de teste.
- **`driver_disclosure_required` ON**: adiciona o gate de aceite do
  disclosure, independente de `onboarding_gates_v1_enabled` estar ligada no
  SQL — no SQL as duas flags são checadas juntas (`onboarding_gates_v1_enabled`
  precisa estar ON para `driver_can_go_online` considerar QUALQUER gate novo,
  incluindo disclosure).

## Parâmetros configuráveis

| Chave (`system_config`) | Default | O que controla |
|---|---|---|
| `onboarding_gates_v1_enabled` | `false` | Liga os gates novos do Bloco 3 (desqualificação, recheck, disclosure) em `driver_can_go_online()`. Não afeta a checagem de Stripe Connect (incondicional desde o Bloco 0/migration 0038). |
| `background_check_recheck_years` | `3` | Anos entre reapurações obrigatórias do background check, independente da validade operacional (`background_check_valid_days`, P7). |
| `driver_disclosure_required` | `false` | Exige aceite do disclosure legal (`driver_disclosure_acceptances`) para ficar online. |
| `driver_disclosure_version` | `'1'` | Versão vigente do texto do disclosure. Trocar por jurisdição faz o motorista precisar aceitar de novo; aceites de versões antigas continuam no histórico (append-only). |

## Limitações conhecidas (fast-follow, não bloqueiam o Bloco 3)

- **Nenhum processo escreve em `driver_background_checks` hoje** — gap
  pré-existente do P7 (não introduzido neste bloco): `startBackgroundCheck`/
  `MockBackgroundCheckProvider.initiate()` devolve um resultado, mas nada
  persiste isso na tabela, e não há webhook/Edge Function de veredito de
  provider real implementado. Consequência prática: com
  `onboarding_gates_v1_enabled` ligada e `background_check_required`
  também ligada, todo motorista cairia em `background_check_required`
  (sem registro) até esse gap ser fechado — não é um problema NOVO deste
  bloco, mas fica mais visível assim que o gate é ligado. Fechar isso
  exigiria um fluxo de admin/webhook para computar `evaluateDisqualification`
  a partir de achados reais e persistir `disqualified`/
  `disqualification_reasons` — deliberadamente fora de escopo aqui para
  evitar scope creep (não foi pedido explicitamente pelo COMANDO do Bloco 3
  além da REGRA de desqualificação em si).
- **`DisqualificationThresholds` não é configurável via `system_config`
  ainda** — só os 4 parâmetros novos deste bloco (recheck years, disclosure
  required/version, gates flag) foram adicionados a `CONFIG_DEFAULTS`. Os
  limiares de felony/DUI/violação de trânsito usam sempre
  `DEFAULT_DISQUALIFICATION_THRESHOLDS` do código — expor isso por
  jurisdição via `system_config` (jsonb) é um fast-follow natural quando o
  fluxo de revisão admin (limitação acima) for construído.
- **`DriverHomeScreen.handleOnlineChange` não foi refatorado para usar
  `evaluateOnboardingGate` por inteiro** — os gates de verificação/Stripe já
  existentes continuam com seus próprios `if`s (comportamento idêntico ao
  pré-Bloco-3); só os 3 motivos novos (`background_check_disqualified`,
  `background_check_recheck_due`, `disclosure_not_accepted`) usam o hook
  novo. Uma refatoração completa unificaria tudo num só `if` por motivo, mas
  aumentaria o diff/risco sem ganho funcional imediato.

## Arquivos

| Arquivo | Mudança |
|---|---|
| `src/lib/disqualificationRules.ts` | **novo** — núcleo puro de desqualificação (bane vitalício + limiares configuráveis). |
| `src/lib/__tests__/disqualificationRules.test.ts` | **novo** — 14 testes. |
| `src/lib/driverOnboardingGate.ts` | **novo** — gate unificado (`evaluateOnboardingGate`, `isBackgroundCheckRecheckDue`). |
| `src/lib/__tests__/driverOnboardingGate.test.ts` | **novo** — 23 testes. |
| `supabase/migrations/0059_onboarding_gates_bloco3.sql` | **novo** — colunas de veredito, tabela `driver_disclosure_acceptances`, RPC de aceite, funções de resolução de config, `driver_can_go_online()`, extensão de `enforce_driver_online_gating()`, seeds. |
| `src/hooks/useDriverOnboardingGate.ts` | **novo** — wiring do gate unificado no cliente. |
| `src/screens/driver/DriverDisclosureScreen.tsx` | **novo** — tela de revisão/aceite do disclosure legal. |
| `src/screens/driver/DriverHomeScreen.tsx` | 3 novos `if`s em `handleOnlineChange` (desqualificado, recheck devido, disclosure não aceito). |
| `src/navigation/AppNavigator.tsx`, `src/types/index.ts` | Nova rota `Disclosure` (stack do motorista). |
| `src/i18n/translations.ts` | Novas chaves `driver.disqualified*`, `driver.recheckDue*`, `driver.disclosureRequired*`, `disclosure.*` — en/es/pt. |
| `src/lib/systemConfig.ts` | flags `onboarding_gates_v1_enabled: false`, `background_check_recheck_years: 3`, `driver_disclosure_required: false`, `driver_disclosure_version: '1'`. |
| `docs/bloco3-onboarding-gates.md` | **novo** — este documento. |

## Cobertura de testes

Núcleo puro — **37 testes passam, 0 falham** (14 de `disqualificationRules` +
23 de `driverOnboardingGate`, incluindo os 3 novos casos de precedência do
veredito persistido). Suíte completa do projeto (todos os módulos, não só
Bloco 3): **426 passam, 0 falham**. `npx tsc --noEmit` limpo.

```
npx jest src/lib/__tests__/disqualificationRules.test.ts src/lib/__tests__/driverOnboardingGate.test.ts
npx jest    # suíte completa
npx tsc --noEmit
```

## Roteiro de teste manual (ambiente de teste, jurisdição isolada)

Pré-condições: migration 0059 aplicada; `onboarding_gates_v1_enabled = true`
e `driver_disclosure_required = true` na jurisdição de teste; um motorista
de teste com `verification_status = 'approved'` e Stripe Connect habilitado.

1. **Flag OFF preserva comportamento atual:** com
   `onboarding_gates_v1_enabled = false`, confirme que o motorista fica
   online normalmente mesmo sem nenhum background check/disclosure — só a
   checagem de Stripe (já existente) se aplica.
2. **Disclosure bloqueia:** ligue `onboarding_gates_v1_enabled` e
   `driver_disclosure_required`. Tente ficar online sem ter aceitado o
   disclosure — confirme o alerta "Review required" com botão para a tela
   `Disclosure`, e que `driver_locations.is_online` não vira `true` mesmo
   que o cliente tente forçar (checagem no trigger do servidor).
3. **Aceite libera:** na tela `Disclosure`, toque em aceitar. Confirme que
   `driver_disclosure_acceptances` ganha uma linha
   (`driver_id`, `disclosure_key='tnc_driver_disclosure'`,
   `version='1'`), e que agora o motorista consegue ficar online.
4. **Append-only do aceite:** tente `UPDATE`/`DELETE` direto em
   `driver_disclosure_acceptances` via SQL (mesmo como `service_role`).
   Confirme rejeição pela trigger.
5. **Desqualificação:** insira manualmente uma linha em
   `driver_background_checks` com `status='clear'`, `expires_at` futuro,
   `disqualified=true`. Confirme que o motorista NÃO consegue ficar online
   (alerta "Account not eligible", sem botão de ação) e que
   `driver_can_go_online()` devolve `false` para esse `driver_id` via SQL
   direto.
6. **Recheck trienal:** com o mesmo motorista, ajuste
   `driver_background_checks.checked_at` para mais de
   `background_check_recheck_years` atrás, mas `expires_at` ainda no
   futuro e `disqualified=false`. Confirme o alerta "Background check
   renewal required" — e que isso é DIFERENTE do alerta de "Background
   check required" (que aparece quando não há check válido/expirado).
7. **Rollback:** ponha `onboarding_gates_v1_enabled = false`. Confirme que
   o motorista do passo 5/6 volta a conseguir ficar online (os gates novos
   somem; Stripe/verificação continuam valendo).

## Riscos e rollback

- **Rollback do bloco:** `onboarding_gates_v1_enabled = false` interrompe
  imediatamente os 3 gates novos no SERVIDOR (config dinâmica, sem
  redeploy) — a checagem de Stripe Connect (pré-existente) continua valendo
  sempre, independente desta flag.
- **Sem mudança de contrato para blocos anteriores:** `enforce_driver_online_gating()`
  preserva byte a byte a checagem de Stripe do Bloco 0 (migration 0038); o
  Bloco 1 (`driver_period_transitions`) e o Bloco 2 (retenção/export) não
  são tocados por esta migration.
- **Gap conhecido do P7 fica mais visível, não pior:** ligar
  `onboarding_gates_v1_enabled` + `background_check_required` sem um
  processo que escreva em `driver_background_checks` bloquearia todo
  motorista por falta de registro — mitigação: só ligar
  `onboarding_gates_v1_enabled` numa jurisdição depois de garantir que o
  fluxo de background check real (fora do escopo deste bloco) já está
  operacional, OU manter `background_check_required = false` nessa
  jurisdição enquanto isso não acontece (os outros gates — recheck,
  desqualificação, disclosure — não dependem de `background_check_required`
  estar ligada, exceto recheck/desqualificação que só se aplicam quando o
  bg check É exigido).
- **Pendente antes de fechar o Bloco 3:** aplicar (`supabase db push`) a
  migration 0059 no ambiente remoto, e commitar as mudanças — aguardando
  autorização explícita do usuário para ambas as ações, por protocolo.
