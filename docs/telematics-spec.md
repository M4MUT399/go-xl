# Go XL — Bloco 2: log auditável + relatórios de compliance (TNC, F.S. 627.748)

Segundo dos 4 blocos do COMANDO de compliance da lei de TNC da Flórida.
Escopo do Bloco 2: **retenção configurável sobre a trilha imutável do Bloco
1**, **claims lookup administrativo** (<5s) e **export mensal para a
seguradora/underwriter**. Onboarding/gates ficam no Bloco 3; tolerância zero
+ recibo no Bloco 4 — ainda não iniciados.

## O requisito

A trilha de transições `driver_period_transitions` (Bloco 1) já é
append-only por desenho — nenhuma linha pode ser alterada/apagada. O COMANDO
pede, em cima disso:

1. **Retenção configurável**, mínimo 1 ano, **default 5 anos** — sem abrir
   mão da imutabilidade linha a linha.
2. **Claims lookup administrativo** em **<5s**: dado um motorista e um
   instante (ou uma corrida), responder qual período P0–P3 estava vigente.
3. **Export mensal** de milhagem por período para a seguradora, sem PII do
   motorista além do `driver_id` pseudonimizado.
4. `docs/telematics-spec.md` (este documento) — especificação para o broker
   de seguro entender a garantia de dados por trás do produto.

## A tensão resolvida: append-only rígido × retenção configurável

Documentada como pendência explícita no cabeçalho da migration 0056: não dá
para simplesmente permitir `DELETE` de linhas vencidas — isso quebraria a
garantia de imutabilidade que sustenta o valor probatório da trilha para a
seguradora. A resposta implementada é **particionamento por mês**
(`PARTITION BY RANGE (created_at)`):

- Os triggers de rejeição de `UPDATE`/`DELETE` (e agora também `TRUNCATE` —
  ver hardening abaixo) são definidos na tabela-mãe **particionada** e o
  Postgres os propaga automaticamente para **toda partição, existente ou
  futura** — nenhuma DML de mutação passa em nenhuma partição, nem via
  `service_role`.
- Retenção vencida vira `DROP TABLE` de uma partição inteira — é **DDL**, não
  **DML**, então não é bloqueado pelos triggers de linha. É exatamente a
  operação "purgar dado antigo" pedida pelo comando, sem contradizer
  "impossível alterar/apagar uma linha individual" enquanto ela existir.
- Cada criação/purge de partição fica registrada em
  `driver_period_transitions_maintenance_log` — quem/quando uma faixa de
  dados entrou ou saiu do banco.

### Hardening encontrado nesta revisão (documentado para review)

A migration 0056 rejeitava `UPDATE`/`DELETE` via **trigger de linha**, mas
**não** `TRUNCATE` — triggers de linha não disparam em `TRUNCATE`, é preciso
um trigger de **ESTATEMENT** dedicado. Sem essa correção, qualquer role com
privilégio de `TRUNCATE` (ex.: `service_role`) apagaria a tabela inteira de
uma vez, contornando a garantia de imutabilidade. Fechado na migration 0057
com `trg_reject_driver_period_transitions_truncate` (`BEFORE TRUNCATE ...
FOR EACH STATEMENT`).

## A implementação

### Camada pura, cross-runtime (`supabase/functions/_shared/telematicsExport.ts`)

Módulo TypeScript **sem nenhum import de Deno nem de supabase-js** — só
string/array/date puros — para poder ser importado tanto pela Edge Function
(runtime Deno, no deploy real) quanto pelo harness de teste Node/jest deste
repo. Uma fonte de verdade só, testada uma vez:

| Função | Responsabilidade |
|---|---|
| `resolveExportMonth(now, requestedMonth?)` | Resolve o mês-alvo do export: sem parâmetro, o mês **anterior completo** a `now` (uso do cron); com `'YYYY-MM'`, exatamente esse mês (reexport sob demanda pelo admin). Trata corretamente virada de ano nos dois sentidos. |
| `buildDailyMileageCsv(rows)` | Monta o CSV do export a partir dos rollups diários — arredonda para 2 casas, soma `total_miles`. |
| `findActivePeriodAtTimestamp(transitions, atMs)` | O núcleo do claims lookup: entre transições de UM motorista (qualquer ordem de entrada), acha a de maior `at_ms` que ainda seja `<= atMs` (limite **inclusivo**). Sem transição anterior → `null`, o chamador **nunca presume P0** silenciosamente. |

**14 testes unitários**, cobrindo viradas de mês (janeiro↔dezembro),
mês explícito vs. default, formato/rango inválidos, CSV vazio/arredondamento/
múltiplas linhas, e os casos de borda do claims lookup (lista vazia, instante
antes de tudo, entrada fora de ordem, limite inclusivo exato, instante depois
de tudo).

### Camada de persistência (`supabase/migrations/0057_period_audit_retention.sql`, `0058_telematics_export_cron.sql`)

1. **Conversão one-time** de `driver_period_transitions` em tabela
   particionada por mês (`RANGE (created_at)`), guardada por checagem de
   idempotência (`relkind = 'p'`) — reaplicar a migration é seguro. A chave
   primária passa a ser `(id, created_at)` (exigência do Postgres para
   partição por range, não escolha de design — `id` sozinho, uuid v4, já
   garante unicidade prática). Dado pré-existente (se houver — a flag
   `period_tracking_v1_enabled` está OFF em toda jurisdição até agora, então
   a tabela deve estar vazia na prática) é realocado para a(s) partição(ões)
   mensal(is) corretas calculadas a partir do próprio `created_at`; nenhuma
   linha é descartada. Uma partição `..._default` funciona como rede de
   segurança para qualquer linha fora do range mensal explícito.
2. `ensure_driver_period_transitions_partition(month)` — cria a partição do
   mês se não existir (idempotente, `SECURITY DEFINER`, só `service_role`
   executa), loga em `driver_period_transitions_maintenance_log`.
3. `purge_expired_driver_period_transitions()` — lê `period_retention_years`
   de `system_config` (piso técnico de 1 ano aplicado **na própria função**,
   não só na validação do app), identifica partições mensais vencidas via
   `pg_inherits`/`pg_class` e faz `DROP TABLE` de cada uma, logando o purge.
4. `driver_period_transitions_maintenance_log` — id, `action`
   (`partition_created` | `partition_purged`), nome da partição, limites
   `[boundary_from, boundary_to)`, `created_at`. RLS: admin lê, só
   `service_role` escreve.
5. **pg_cron mensal** (`period-transitions-maintenance`, dia 1 06:15 UTC):
   pré-cria os 2 meses seguintes (folga contra o cron falhar uma vez) + roda
   o purge. Roda **sempre**, independente da flag `period_audit_v1_enabled`
   — é manutenção de infraestrutura invisível ao usuário, mesmo raciocínio
   já usado nos triggers de timestamp do Bloco 1.
6. Bucket de storage **privado** `telematics-exports` (mesmo padrão do
   bucket `driver-verification`, migration 0019: sem policy de
   `storage.objects` para `authenticated` — acesso só via Edge Function com
   `service_role`, que ignora RLS/policy de storage).
7. `telematics_export_runs` — id, `month` (1º dia do mês exportado),
   `triggered_by` (`cron` | `admin`), `admin_id` (nulo se cron),
   `row_count`, `storage_path`, `created_at`. RLS: admin lê, só
   `service_role` escreve.
8. **pg_cron mensal do export** (`telematics-monthly-export`, dia 1 06:30
   UTC — 15 min depois da manutenção de partição, migration 0058): chama a
   Edge Function `admin-telematics-export` via `net.http_post` com a
   `service_role_key` do Vault, mesmo padrão de `run-weekly-payouts`
   (migration 0035).
9. Seeds `system_config`: `period_retention_years` (`5`, público) e
   `period_audit_v1_enabled` (`false`, não público).

### Camada de API — Edge Functions administrativas

Ambas seguem o padrão RBAC já estabelecido em `admin-waybills`: autentica
via cliente anon + `auth.getUser()`, confirma `profiles.is_admin` via
cliente `service_role`, aplica `checkAdminRateLimit`, registra em
`admin_audit_log`.

#### `admin-telematics-claims`

Responde a pergunta central de um sinistro: "que cobertura valia no momento
do acidente?". Duas ações:

- `lookupByTimestamp` (`driverId`, `atMs`): busca as até 10 transições mais
  recentes com `at_ms <= atMs` pelo índice
  `driver_period_transitions_claims_lookup_idx (driver_id, at_ms)` — um
  index scan direto, não uma varredura, cumprindo o requisito de **<5s** — e
  delega a decisão final de "qual estava vigente" para
  `findActivePeriodAtTimestamp` (mesma função pura testada), em vez de
  confiar cegamente no `ORDER BY ... LIMIT` do banco para a regra de
  negócio.
- `lookupByTrip` (`tripId`): devolve a sequência completa de transições
  registradas para uma corrida específica (dispatch → embarque →
  desembarque), pelo índice `driver_period_transitions_trip_idx`.

Gate: exige `period_audit_v1_enabled` ligada para a jurisdição — flag
desligada responde `403` mesmo para admin autenticado (o endpoint não fica
exposto antes do rollout ser aprovado).

#### `admin-telematics-export`

Gera o CSV mensal de milhagem por período (`driver_id, day, p1_miles,
p2_miles, p3_miles, estimated_miles, total_miles`) a partir do rollup
`driver_period_daily_mileage` — **nunca** somando a trilha de transições
inteira (decisão já registrada na migration 0056: "é o que os relatórios do
Bloco 2 vão consultar"). Duas vias de chamada:

- **Admin sob demanda** (JWT de usuário, `profiles.is_admin=true`): body
  opcional `{ month: 'YYYY-MM' }` para reexportar um mês específico
  (auditoria/correção). Rate-limited, registrado em `admin_audit_log`.
- **Cron mensal** (service-role key no header `Authorization`, sem usuário —
  mesma técnica `isServiceRole` de `run-weekly-payouts`): sem `month` no
  body → usa o mês anterior completo via `resolveExportMonth`.

Em ambos os casos: lê o rollup do intervalo `[start, end)`, monta o CSV,
sobe para o bucket privado `telematics-exports` em
`{label}/daily_mileage_{label}.csv` (upsert — reexportar o mesmo mês
substitui o arquivo), registra a corrida em `telematics_export_runs`.

Gate: mesma flag `period_audit_v1_enabled`. Para a via **admin**, flag
desligada responde `403`. Para a via **cron**, flag desligada **não é
erro** — a função responde `200 { skipped: true }` e não escreve nada; a
manutenção de partição/purge continua rodando de qualquer forma (job
separado, não depende desta flag).

**Privacidade:** o CSV **não inclui** nome/telefone/e-mail do motorista, só
`driver_id` (uuid pseudonimizado) — a seguradora consegue cruzar isso com o
`driver_id` de uma reivindicação específica sem que o arquivo em si carregue
PII direta. Combinado com o bucket privado (sem acesso direto de usuário
comum), atende ao requisito geral do COMANDO de minimizar exposição de PII.

## Interpretações registradas para revisão (comportamento ambíguo do comando)

- **Realocação de dado pré-existente na conversão para tabela particionada**:
  como a flag `period_tracking_v1_enabled` está OFF em toda jurisdição até
  agora, a tabela deve estar vazia na prática — mas caso não esteja (ex.:
  teste manual já rodado), a migration realoca cada linha para a partição
  mensal calculada a partir do próprio `created_at`, sem descartar nada.
  Registrado no cabeçalho da migration 0057.
- **Claims lookup por corrida (`lookupByTrip`) além do lookup por instante**:
  o comando pede "consultas de sinistro em minutos, não dias" mas não
  especifica a forma exata da consulta. Interpretamos que um fluxo real de
  seguradora frequentemente já sabe QUAL corrida está associada ao sinistro
  (não só o instante) — por isso a segunda ação, devolvendo a sequência
  completa de períodos daquela corrida. Se o broker de seguro preferir só a
  consulta por instante, `lookupByTrip` pode ser removida sem afetar o
  restante do bloco.

## Feature flags (rollout gradual + rollback)

`src/lib/systemConfig.ts` → `CONFIG_DEFAULTS`:

```
period_retention_years: 5           // anos de retenção antes do purge
period_audit_v1_enabled: false      // DESLIGADA por padrão
```

- **Retenção/particionamento**: NÃO é flag-gated — roda sempre, é
  infraestrutura invisível ao usuário (mesmo raciocínio dos triggers de
  timestamp do Bloco 1: "inertes por natureza", seguro ligar desde já).
- **`period_audit_v1_enabled` OFF (padrão)**: as duas Edge Functions
  administrativas (`admin-telematics-claims`, `admin-telematics-export`)
  respondem `403` (via admin) ou pulam silenciosamente (via cron). Nenhum
  dado novo é exposto ou exportado.
- **`period_audit_v1_enabled` ON**: libera claims lookup e export para a
  jurisdição. Habilitar só após validação (ex.: rodar o roteiro de teste
  manual abaixo num ambiente de teste).

## Parâmetros configuráveis

| Chave (`system_config`) | Default | O que controla |
|---|---|---|
| `period_retention_years` | `5` | Anos de retenção de `driver_period_transitions` antes de a partição mensal correspondente ser purgada. Piso técnico de 1 ano sempre aplicado na função de purge, mesmo que configurado abaixo disso. |
| `period_audit_v1_enabled` | `false` | Liga `admin-telematics-claims` e `admin-telematics-export`. NÃO afeta manutenção de partição/retenção, que roda sempre. |

## Limitações conhecidas (fast-follow, não bloqueiam o Bloco 2)

- **Migration 0057 não pôde ser dry-run** contra um Postgres real neste
  ambiente (sem Docker/`psql`/`postgres` disponíveis) — validada por
  revisão manual cuidadosa (semântica de particionamento PG11+, herança de
  triggers/RLS/índices, exigência de PK composta, `EXECUTE` para DDL
  dinâmico dentro de `plpgsql`), não por execução real. Recomenda-se rodar
  `supabase db push` primeiro num ambiente de teste antes de produção.
- **`lookupByTimestamp` busca até 10 candidatas** (não 1) antes de aplicar
  `findActivePeriodAtTimestamp`, como proteção contra timestamps de
  dispositivo empatados/fora de ordem — número arbitrário, suficiente para
  o padrão observado de transições (uma por evento de período), mas pode
  ser ajustado se algum motorista acumular rajadas de transições muito
  densas no mesmo instante.
- **Sem paginação em `admin-telematics-claims`**: `lookupByTrip` devolve
  todas as transições da corrida sem limite — aceitável porque uma corrida
  tipicamente gera poucas transições (dispatch/embarque/desembarque/
  encadeamento), mas não tem teto explícito hoje.

## Arquivos

| Arquivo | Mudança |
|---|---|
| `supabase/functions/_shared/telematicsExport.ts` | **novo** — núcleo puro cross-runtime (resolução de mês, CSV, claims lookup). |
| `supabase/functions/_shared/__tests__/telematicsExport.test.ts` | **novo** — 14 testes unitários. |
| `supabase/functions/_shared/adminConfigFlag.ts` | **novo** — helper Deno-only de leitura de flag booleana em `system_config` (jurisdição específica → global), compartilhado pelas duas Edge Functions novas. |
| `supabase/functions/admin-telematics-claims/index.ts` | **novo** — Edge Function de claims lookup (`lookupByTimestamp`, `lookupByTrip`). |
| `supabase/functions/admin-telematics-export/index.ts` | **novo** — Edge Function de export mensal (admin sob demanda + cron). |
| `supabase/migrations/0057_period_audit_retention.sql` | **novo** — particionamento, hardening TRUNCATE, funções de partição/purge, log de manutenção, bucket + tabela de export, seeds de config. |
| `supabase/migrations/0058_telematics_export_cron.sql` | **novo** — agendamento mensal do export via `pg_cron`/`pg_net`. |
| `src/lib/systemConfig.ts` | flags `period_retention_years: 5`, `period_audit_v1_enabled: false`. |
| `docs/telematics-spec.md` | **novo** — este documento. |

## Cobertura de testes

Módulo puro — **14 passam, 0 falham**. Validação via esbuild + node com o
mesmo shim de jest do Bloco 1:

```
npx esbuild supabase/functions/_shared/__tests__/telematicsExport.test.ts \
  --bundle --platform=node --format=cjs \
  --inject:/tmp/jestshim.js --define:__DEV__=false \
  --outfile=/tmp/telematics.cjs
node /tmp/telematics.cjs

npx tsc --noEmit
```

Resultado atual: `14 passed, 0 failed`.

## Roteiro de teste manual (ambiente de teste, jurisdição isolada)

Pré-condições: migration 0057/0058 aplicadas; `period_audit_v1_enabled =
true` na jurisdição de teste; ao menos um motorista com transições
gravadas (Bloco 1 com `period_tracking_v1_enabled = true` rodando há
alguns dias, ou inseridas manualmente para o teste).

1. **Partição do mês corrente existe:** `select * from pg_inherits ...`
   (ou `\d+ driver_period_transitions` no psql) confirma uma partição
   `driver_period_transitions_yYYYY_mMM` para o mês atual e o seguinte.
2. **Imutabilidade sobrevive à conversão:** repita o teste do Bloco 1 (tentar
   `UPDATE`/`DELETE` via SQL direto, mesmo como `service_role`) — confirma
   que ainda é rejeitado na tabela particionada.
3. **Hardening TRUNCATE:** tente `TRUNCATE driver_period_transitions` como
   `service_role`. Confirme que é **rejeitado** com a mesma exceção
   (`... é append-only`) — este é o gap corrigido nesta revisão.
4. **Claims lookup por instante:** chame `admin-telematics-claims` com
   `{ action: 'lookupByTimestamp', driverId, atMs }` usando um `atMs` que
   caia dentro de uma corrida conhecida. Confirme que `activePeriod.to_period`
   bate com o período esperado (ex.: `P3_ONTRIP` se o instante é durante a
   corrida). Confirme resposta em bem menos de 5s.
5. **Claims lookup por corrida:** chame com `{ action: 'lookupByTrip',
   tripId }`. Confirme que devolve a sequência completa de transições
   daquela corrida, em ordem cronológica.
6. **Gate da flag:** com `period_audit_v1_enabled = false` na jurisdição,
   repita 4 e 5 — confirme `403` nas duas ações.
7. **Export sob demanda:** chame `admin-telematics-export` com `{ month:
   'YYYY-MM' }` (mês com dado conhecido). Confirme `200`, `rowCount > 0`,
   e que o arquivo aparece no bucket `telematics-exports` em
   `{month}/daily_mileage_{month}.csv` com o conteúdo esperado (cabeçalho +
   uma linha por `driver_id`/dia, `total_miles` = soma das 3 fases).
   Confirme uma linha nova em `telematics_export_runs` (`triggered_by =
   'admin'`).
8. **Export via cron:** aguarde (ou dispare manualmente) o job
   `telematics-monthly-export`. Confirme nova linha em
   `telematics_export_runs` com `triggered_by = 'cron'`, `admin_id = null`,
   referente ao mês anterior completo.
9. **Purge de retenção:** com `period_retention_years` temporariamente
   baixado (nunca abaixo de 1, o piso é aplicado pela função) para testar,
   chame `select public.purge_expired_driver_period_transitions()`
   manualmente. Confirme que só partições realmente vencidas são
   dropadas, e que cada purge gera uma linha em
   `driver_period_transitions_maintenance_log`.
10. **Rollback:** ponha `period_audit_v1_enabled = false`. Confirme que as
    duas Edge Functions voltam a barrar (passo 6) — sem afetar a
    manutenção de partição/purge, que continua rodando via cron
    independente da flag.

## Riscos e rollback

- **Rollback do bloco:** `period_audit_v1_enabled = false` interrompe
  imediatamente o acesso às duas Edge Functions administrativas (config
  dinâmica, sem redeploy) — a trilha continua sendo gravada normalmente pelo
  Bloco 1 (que tem sua própria flag, `period_tracking_v1_enabled`,
  independente desta).
- **Retenção/particionamento não tem "flag off"** por design — é
  infraestrutura de dados, não uma feature visível ao usuário; desligar
  equivaleria a acumular a tabela indefinidamente, o oposto do requisito de
  compliance. Se necessário pausar a manutenção automática, o job pg_cron
  pode ser desagendado manualmente (`select cron.unschedule(...)`) sem
  afetar a imutabilidade em si.
- **Operação irreversível na migration 0057:** a conversão da tabela em
  particionada envolve `RENAME`/`CREATE`/`INSERT`/`DROP` da tabela original
  — revisada manualmente com cuidado (idempotência via checagem de
  `relkind='p'`, nenhuma linha descartada), mas **não foi possível dry-run
  contra um Postgres real neste ambiente**. Recomenda-se aplicar primeiro
  num ambiente de teste/staging antes de produção.
- **Sem mudança de contrato para o Bloco 1:** nenhuma tabela/coluna/função
  do Bloco 1 teve sua interface pública alterada — a conversão para
  particionada é transparente para quem já lê/escreve
  `driver_period_transitions` via RLS normal.
- **Pendente antes de fechar o Bloco 2:** aplicar (`supabase db push`) as
  migrations 0057/0058 e o deploy das duas novas Edge Functions no ambiente
  remoto, e commitar as mudanças — aguardando autorização explícita do
  usuário para ambas as ações, por protocolo. Também pendente: cadastrar
  `service_role_key` no Vault se ainda não estiver (pré-requisito
  compartilhado com a migration 0035, provavelmente já feito).
