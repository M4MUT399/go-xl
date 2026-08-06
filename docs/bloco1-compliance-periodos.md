# Go XL — Bloco 1: máquina de estados P0–P3 (compliance TNC, F.S. 627.748)

Primeiro dos 4 blocos do COMANDO de compliance da lei de TNC da Flórida.
Escopo do Bloco 1: **telemetria pura de períodos legais** — máquina de
estados, milhagem por período, persistência server-side imutável. Log
auditável/relatórios (retenção, export ao underwriter, claims-lookup) ficam
no **Bloco 2**; gates de onboarding no **Bloco 3**; tolerância zero + recibo
no **Bloco 4** — todos separados, ainda não iniciados.

## O requisito

F.S. 627.748 (e os underwriters do seguro comercial) exigem que o app
distinga, a qualquer instante, em qual dos 4 períodos legais o motorista está:

| Período | Definição | Cobertura |
|---|---|---|
| **P0** OFFLINE | Fora da rede (logout/app fechado) | Nenhuma (TNC) |
| **P1** AVAILABLE | Online, sem corrida aceita | 50/100/25 |
| **P2** ENROUTE | Corrida aceita, a caminho do embarque | US$1M |
| **P3** ONTRIP | Passageiro a bordo, até o último desembarque | US$1M |

"Prearranged ride" (a lei) = P2 ∪ P3. Cada transição de período precisa ser
registrada com timestamp de **servidor**, coordenada GPS e milhagem
acumulada — para responder consultas de sinistro (claims-lookup, Bloco 2) em
minutos, não dias.

## A implementação

### Camada pura (testável, sem React/Supabase)

| Módulo | Responsabilidade |
|---|---|
| `src/lib/driverPeriodMachine.ts` | Máquina de estados determinística. Eventos `WENT_ONLINE / WENT_OFFLINE / TRIP_ACCEPTED / TRIP_BOARDED / TRIP_COMPLETED / TRIP_CANCELLED`, todos com `atMs` de servidor. Idempotente a replay fora de ordem/duplicado (eventos que não fazem sentido no estado atual são no-op). |
| `src/lib/driverPeriodMileage.ts` | Acumulador de milhas por período a partir de pares de leituras GPS, com os mesmos filtros anti-drift do tracker de jornada existente (`dutyMovement.ts`): descarta jitter (`< 8 m`) e sinaliza saltos implausíveis (`> 110 mph` implícito) para interpolação. |

Cobrem, na própria máquina, os casos de borda do comando:

- **Corrida encadeada:** se uma 2ª corrida é aceita enquanto o motorista
  ainda está em P2/P3 da 1ª, ela fica **enfileirada** (`queuedNextTripId`);
  ao concluir/cancelar a 1ª, entra **direto em P2 da 2ª — pulando P1**
  (`reason: 'chained'`), porque o motorista já tinha aceite ativo.
- **Perda de sinal:** salto de GPS implausível não é descartado nem conta
  como linha reta sem aviso — é creditado pela distância em linha reta como
  piso conservador, mas **marcado `estimated=true`** (nunca "perde" milhagem;
  ver limitação abaixo sobre rota real).
- **Reconstrução pós app-kill:** a máquina é serializável
  (`serializeDriverPeriod`/`deserializeDriverPeriod`) e idempotente — o
  wiring (abaixo) sempre reaplica a verdade atual do servidor por cima do
  estado restaurado ao (re)montar.
- **Múltiplos embarques/paradas:** P2→P3 é o evento único "Passei buscar o
  passageiro" já existente (`DriverNavigateScreen.handleNextPhase` →
  `status='in_progress'`) — reaproveitado sem nova UI (decisão de produto
  registrada no cabeçalho de `driverPeriodMachine.ts`). Múltiplas paradas
  dentro da mesma corrida não mudam de período (o passageiro segue a bordo).

### Camada de wiring (impura — `src/hooks/useDriverPeriodTracker.ts`)

Diferente de `useDutyMovementTracker` (amostragem periódica de velocidade),
este hook é **event-driven a partir do servidor**, não do relógio do cliente
nem do estado de UI local — descobrimos que `activeRide` (de `useDriverRide`)
colapsa `completed` e `cancelled` no mesmo `null`, o que não basta para
distinguir o motivo da transição. Por isso o hook assina **sua própria**
subscription realtime:

- `driver_locations` (INSERT/UPDATE, filtro `driver_id`) → `WENT_ONLINE`/
  `WENT_OFFLINE`, lidos de `is_online_changed_at` (novo, server-side —
  carimbado só quando `is_online` de fato muda, não a cada ping de GPS).
- `rides` (UPDATE, filtro `driver_id`) → `TRIP_ACCEPTED`/`TRIP_BOARDED`/
  `TRIP_COMPLETED`/`TRIP_CANCELLED`, lidos de `accepted_at`/`boarded_at`/
  `completed_at`/`cancelled_at` (novos/corrigidos, server-side).

Cada evento aplicado à máquina carrega a **última posição GPS conhecida**
(`locationRef`, mesmo stream de localização do resto do app), para que
`driver_period_transitions.lat/lng` nunca fique vazio quando há fix de GPS
disponível.

Toda transição de período (não todo evento bruto) é gravada
*fire-and-forget* em `driver_period_transitions` (append-only). Toda leitura
de GPS válida credita milhas ao bucket do período atual via a RPC atômica
`increment_driver_period_mileage` em `driver_period_daily_mileage` (rollup
mutável por motorista/dia — o que os relatórios do Bloco 2 vão consultar).

### Camada de persistência (`supabase/migrations/0056_driver_period_compliance.sql`)

1. **Fecha uma lacuna de compliance pré-existente:** `rides.accepted_at` e
   `rides.completed_at` eram carimbados pelo **relógio do cliente**
   (`new Date().toISOString()`). Novo trigger `stamp_ride_period_timestamps`
   (BEFORE UPDATE) sobrescreve **sempre** com `now()` do Postgres na primeira
   transição para o status correspondente — o valor enviado pelo cliente é
   ignorado. Acrescenta `rides.boarded_at` (marco P2→P3, não existia) e
   `rides.cancelled_at`. Auditado antes de escrever a migração: todo call
   site relê a linha via `.select()` na mesma operação ou numa query de
   acompanhamento — nenhum código usava o valor client-side sem reler, então
   a mudança é transparente para a UI existente.
2. Mesma lacuna em `driver_locations`: novo `is_online_changed_at`,
   carimbado só quando `is_online` muda (não a cada ~5s de ping de GPS).
3. `driver_period_transitions` — tabela **append-only de verdade**: UPDATE e
   DELETE são **rejeitados pelo banco** (`RAISE EXCEPTION`), inclusive para
   `service_role`. Corrigir um registro errado exige um evento
   compensatório novo, nunca reescrever o antigo. Índice dedicado
   `(driver_id, at_ms)` para o claims-lookup do Bloco 2 (critério: <5s).
4. `driver_period_daily_mileage` — rollup mutável por motorista/dia
   (`p1_miles/p2_miles/p3_miles/estimated_miles`), incrementado
   atomicamente pela RPC `increment_driver_period_mileage`
   (`insert ... on conflict do update set x = x + delta`, mesmo princípio de
   compare-and-set de `accept_trip_offer`, migration 0054) — evita tanto
   sobrescrita por upsert simples quanto corrida entre pings de GPS
   próximos no cliente.

## Interpretações registradas para revisão (comportamento ambíguo do comando)

- **"Odômetro" por transição** (`cumulative_miles_at_transition`): o app não
  tem integração com hardware do veículo (sem OBD-II). Interpretamos como a
  milhagem acumulada por GPS na sessão de tracking até aquele instante — a
  leitura mais direta possível do requisito, dado que não existe sensor
  físico de odômetro. Documentado no cabeçalho da migration 0056 para review.
- **Retenção de 5 anos vs. append-only rígido** (tensão real): a resposta
  correta não é permitir DELETE em `driver_period_transitions` (quebraria a
  garantia de imutabilidade). Ficou documentado como trabalho do **Bloco 2**:
  particionar a tabela por mês/ano e **DROPar partições inteiras** vencidas
  — não implementado nesta migração.

## Feature flag (rollout gradual + rollback)

`src/lib/systemConfig.ts` → `CONFIG_DEFAULTS`:

```
period_tracking_v1_enabled: false   // DESLIGADA por padrão
```

- **OFF (padrão):** o hook é totalmente no-op — não assina realtime, não lê
  nem escreve nada em `driver_period_transitions`/`driver_period_daily_mileage`.
  Os triggers de timestamp em `rides`/`driver_locations` ficam ativos desde
  já (são inertes por natureza — só carimbam horário, não mudam
  comportamento visível) e não dependem da flag.
- **ON:** liga a máquina de período + acumulador de milhagem para a
  jurisdição. Habilitar por jurisdição só após validação em campo.

## Parâmetros configuráveis

| Chave (`system_config`) | Default | O que controla |
|---|---|---|
| `period_tracking_v1_enabled` | `false` | Liga a máquina de período P0-P3 + acumulador de milhagem (Bloco 1). Off = nada é escrito nas tabelas novas. |

Nenhum outro parâmetro numérico é exposto neste bloco — os limiares
anti-drift de GPS (`minDeltaMiles=0.005mi`, `maxImpliedMph=110`) são
constantes de código (`DEFAULT_MILEAGE_SAMPLE` em `driverPeriodMileage.ts`),
deliberadamente não movidos para `system_config`: são parâmetros de precisão
de sensor, não de regra de negócio por jurisdição.

## Limitações conhecidas (fast-follow, não bloqueiam o Bloco 1)

- **Interpolação por rota real:** saltos de GPS implausíveis (perda de
  sinal) hoje caem no piso conservador de distância em linha reta,
  `estimated=true`. A integração com `src/lib/routing.ts` para pedir a
  distância de ROTA real entre os dois pontos (mais precisa em curva/serra)
  fica para um fast-follow do Bloco 1 — documentado no próprio código
  (`useDriverPeriodTracker.ts` e `driverPeriodMileage.ts`).
- **`docs/telematics-spec.md`** (especificação completa para o broker de
  seguro) é entregável do **Bloco 2**, não deste PR — o cabeçalho de
  `driverPeriodMachine.ts` já referencia o caminho para quando existir.

## Arquivos

| Arquivo | Mudança |
|---|---|
| `src/lib/driverPeriodMachine.ts` | **novo** — máquina de estados pura P0-P3. |
| `src/lib/driverPeriodMileage.ts` | **novo** — acumulador puro de milhas por período. |
| `src/lib/__tests__/driverPeriodMachine.test.ts` | **novo** — 13 testes unitários. |
| `src/lib/__tests__/driverPeriodMileage.test.ts` | **novo** — 14 testes unitários. |
| `src/hooks/useDriverPeriodTracker.ts` | **novo** — camada de wiring impura (realtime + AsyncStorage + RPC). |
| `supabase/migrations/0056_driver_period_compliance.sql` | **novo** — timestamps server-side em `rides`/`driver_locations`, tabelas `driver_period_transitions`/`driver_period_daily_mileage`, RPC de incremento, seed da flag. |
| `src/lib/systemConfig.ts` | flag `period_tracking_v1_enabled: false`. |
| `src/types/index.ts` | `Ride.boarded_at`, `Ride.cancelled_at`, rota `Insurance` no `RootStackParamList`. |
| `src/contexts/DriverRideContext.tsx` | expõe `driverPeriod`/`driverPeriodEnabled` no contexto global do motorista. |
| `src/screens/driver/DriverInsuranceScreen.tsx` | **novo** — tela de "Seguro & cobertura" (ver seção seguinte). |
| `src/screens/ProfileScreen.tsx` | item de menu "Seguro & cobertura" (`driverOnly`), navega para `Insurance`. |
| `src/navigation/AppNavigator.tsx` | registra `<Stack.Screen name="Insurance">` no branch do motorista. |
| `src/i18n/translations.ts` | namespace `insurance.*` (título, badge ao vivo, 4 seções P0-P3, base legal) + `profile.insurance`, nos 3 idiomas (en/es/pt). |

## Tela "Seguro & cobertura" (transparência ao motorista)

Além da telemetria server-side, o comando pede que essas informações fiquem
**acessíveis ao motorista dentro do app** — nos mesmos moldes da tela
"Insurance" do app do motorista da Uber (Account → Insurance). Implementado:

- **Onde:** Perfil do motorista → item de menu "Seguro & cobertura"
  (`driverOnly`, não aparece para passageiro) → `DriverInsuranceScreen`.
- **Badge de status ao vivo:** mostra "Você está agora em: [período]" no
  topo, com uma cor por período (cinza=P0, âmbar=P1, dourado=P2,
  verde=P3). **Não depende** da flag `period_tracking_v1_enabled` — quando
  a flag está OFF (rollout ainda não chegou à jurisdição), o badge aproxima
  o período a partir do mesmo estado que já dirige a UI hoje (`isOnline` +
  `activeRide.status`), para que o motorista sempre veja um resumo correto
  mesmo antes do rollout da telemetria de auditoria.
- **4 cartões (P0-P3):** cada um com título, faixa de cobertura (valores em
  USD) e uma frase explicando quando aquele período se aplica. O cartão do
  período atual é destacado com borda colorida.
- **Rodapé:** aviso de que é um resumo informativo (não substitui a
  apólice) + referência explícita ao Estatuto da Flórida 627.748.
- **Trilíngue** (pt/en/es), seguindo o mesmo padrão de `TermsScreen`/
  `SupportScreen` (`SafeAreaView` + `ScrollView` + botão de voltar manual).

## Cobertura de testes

Módulos puros — **27 passam, 0 falham** (13 máquina + 14 milhagem). Jest
local está quebrado (layout `.deno` em `node_modules`); validação via esbuild
+ node com shim de jest:

```
printf "import '/Users/mamute99/go-xl/src/lib/__tests__/driverPeriodMachine.test.ts';" > /tmp/dpm.ts
npx esbuild /tmp/dpm.ts --bundle --platform=node --format=cjs --outfile=/tmp/dpm.cjs --inject:/tmp/jestshim.js --define:__DEV__=false && node /tmp/dpm.cjs

printf "import '/Users/mamute99/go-xl/src/lib/__tests__/driverPeriodMileage.test.ts';" > /tmp/dpml.ts
npx esbuild /tmp/dpml.ts --bundle --platform=node --format=cjs --outfile=/tmp/dpml.cjs --inject:/tmp/jestshim.js --define:__DEV__=false && node /tmp/dpml.cjs

npx tsc --noEmit
```

Resultado atual: `13 passed, 0 failed`, `14 passed, 0 failed`, `tsc` EXIT 0
(limpo, sem erros).

## Roteiro de teste manual (1 motorista + 1 passageiro, jurisdição de teste)

Pré-condição: `period_tracking_v1_enabled = true` na jurisdição de teste
(via admin/`system_config`).

1. **P0→P1:** motorista offline. Fique online. Confirme no banco: nova linha
   em `driver_period_transitions` com `from_period=P0_OFFLINE,
   to_period=P1_AVAILABLE, reason=went_online`, `lat/lng` preenchidos (se
   havia GPS), `at_ms` ≈ horário real.
2. **P1→P2:** passageiro solicita, motorista aceita. Nova transição
   `reason=accepted`, `to_period=P2_ENROUTE`, `trip_id` da corrida.
3. **P2→P3:** motorista toca "Passei buscar o passageiro"
   (`DriverNavigateScreen`). Nova transição `reason=boarded`,
   `to_period=P3_ONTRIP`.
4. **P3→P1:** motorista completa a corrida. Nova transição
   `reason=completed`, `to_period=P1_AVAILABLE`. Confira
   `driver_period_daily_mileage` do dia: `p1_miles`/`p2_miles`/`p3_miles`
   > 0 condizente com o trajeto percorrido em cada fase.
5. **Cancelamento:** repita 2, mas cancele a corrida antes do embarque.
   Confirme `reason=cancelled` (não `completed`) e volta a `P1_AVAILABLE`.
6. **Corrida encadeada:** com o motorista em P3 de uma corrida A, aceite uma
   corrida B para o mesmo motorista (2 passageiros). Confirme que **nenhuma**
   transição de período ocorre no aceite de B (fica só enfileirada). Ao
   completar A, confirme transição `reason=chained` direto para
   `to_period=P2_ENROUTE` com `trip_id` de B — **sem** passar por
   `P1_AVAILABLE`.
7. **Reconstrução pós app-kill:** com o motorista em P2 ou P3, force-feche o
   app e reabra. Confirme que o período exibido (`driverPeriod` no contexto)
   bate com o estado real do servidor, sem duplicar transição no log.
8. **Imutabilidade:** tente, via SQL direto (mesmo como `service_role`),
   fazer `UPDATE`/`DELETE` numa linha de `driver_period_transitions`.
   Confirme que a operação é **rejeitada** com a exceção
   `driver_period_transitions é append-only`.
9. **Rollback:** ponha `period_tracking_v1_enabled = false`. Repita o passo 1
   → nenhuma linha nova em `driver_period_transitions` nem em
   `driver_period_daily_mileage`; o app continua funcionando normalmente
   (nada de compliance é bloqueante para operar).

## Riscos e rollback

- **Rollback:** flag OFF interrompe toda escrita nova nas tabelas do Bloco 1
  imediatamente (config dinâmica, sem redeploy). Os triggers de timestamp em
  `rides`/`driver_locations` permanecem ativos mesmo com a flag off — são
  estritamente aditivos (novas colunas, sempre null até a 1ª transição) e não
  alteram nenhum comportamento hoje lido pela UI.
- **Sem mudança de contrato:** nenhuma função/hook existente teve sua
  assinatura alterada; `driverPeriod`/`driverPeriodEnabled` são campos novos
  e opcionais no contexto do motorista.
- **Escopo contido:** este PR não expõe UI nova para o motorista nem altera
  nenhuma regra de negócio visível (preço, disponibilidade, matching) — é
  puramente telemetria em paralelo.
- **Pendente antes de fechar o Bloco 1:** aplicar (`supabase db push`) a
  migration 0056 no ambiente remoto e commitar as mudanças — aguardando
  autorização explícita do usuário para ambas as ações, por protocolo.
