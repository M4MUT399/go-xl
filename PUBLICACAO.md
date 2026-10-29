# Roteiro de publicação — GoXL

Data: 2026-08-21 · Estado de partida: **nada do trabalho recente está no ar.**

Este arquivo existe porque a ordem importa mais que o conteúdo. Há três
acoplamentos que, invertidos, quebram o app em produção — e nenhum deles é
visível olhando um passo de cada vez.

---

## 1. O que está pendente

| | quantidade | observação |
|---|---|---|
| Migrations nunca aplicadas | **14** | 0064 a 0077. A **0078 já foi aplicada à mão** em 2026-08-21. A **0079** (taxa do MCO) é só dado em `system_config`, não depende deste lote e vale para a build que já está na loja — aplique-a à mão também |
| Edge Functions modificadas | **15** | inclusive `charge-ride`, que é a que destrava os dois consertos de pagamento |
| Edge Functions novas | **2** | `resolve-driver-code`, `sweep-stale-requesting` |
| Módulos `_shared` novos | **8** | vão junto com as funções que os importam |
| Build do app | **1.0.5** | o último bump é 6 commits ANTES do conserto do agendamento |

O app na loja está na **faixa de teste interno** (`eas.json` → `submit.interno`,
track `internal`). Isso é uma vantagem grande: a base é pequena e controlada, e
dá para exigir atualização em vez de esperar adoção.

---

## 2. Os três acoplamentos

### A. `anon` × cadastro por QR — o que quebra se você inverter

As migrations **0067, 0069, 0073 e 0075** revogam o acesso de `anon`. A build
**1.0.5, que está na loja**, lê `profiles_public` DIRETO, antes do login:

```
src/screens/passenger/ExpressRegisterScreen.tsx:55   .from('profiles_public')
```

A substituta — `src/lib/driverCode.ts`, que chama a Edge Function
`resolve-driver-code` — **não existe no HEAD**. É código novo.

**Consequência:** aplicar essas migrations antes de a build nova estar em campo
faz todo cadastro por QR falhar. O passageiro escaneia o adesivo do motorista,
digita o código, e recebe "código inválido".

### B. `charge-ride` × build do app

Os dois consertos de pagamento — `fc17578` (agendamento) e `a200400` (gorjeta)
— têm **metade no app e metade na Edge Function**. Publicar só um lado não
resolve nenhum dos dois:

- só a função → o `activate()` da build antiga continua sem chamar a cobrança;
- só o app → a build nova chama uma função que ainda tem o defeito da gorjeta
  quitando a tarifa.

### C. `dispatch_engine_v2` × migration 0076

A flag está `false` e **precisa continuar assim** até a 0076 ser aplicada. Sem
ela, as policies de `trip_requests` e `ride_offers` se chamam em círculo e toda
leitura autenticada morre com `42P17` — e o app **descarta esse erro**
(`const { data: tr } = ...`, sem `error`), então o sintoma é "nada acontece".

---

## 3. Fase 0 — staging (recomendada) ou o risco que você aceita

Nada deste lote jamais rodou contra um Supabase de verdade. O que existe é um
Postgres local com dublês (`supabase/localdb/`): ele prova o SQL, não prova
GoTrue, Storage, `pg_cron`, `pg_net` nem PostgREST.

**Com staging:** criar um projeto Supabase novo, `db push` das 15, publicar as
funções, e rodar lá `98_rls_comportamento.sql` e `99_verificacao.sql`.

**Sem staging:** você descobre em produção. O maior risco não é a 0072 (ela
falha alto e reverte, de propósito, sem `cascade`) — é a 0071/0068, que
registram agendamentos de `pg_cron`, e nada no repositório sabe se a extensão
instalada aceita a cadência `'10 seconds'`.

---

## 4. Fase 1 — publicar o que não quebra nada

Função **nova** não quebra ninguém: ninguém a chama ainda.

```bash
cd /Users/mamute99/go-xl
npx supabase functions deploy resolve-driver-code
```

`resolve-driver-code` tem `verify_jwt = false` (é a página pública do QR) e usa
`SUPABASE_SERVICE_ROLE_KEY` por dentro — não depende de `anon`. Publicá-la agora
é o que torna a Fase 3 possível depois.

**Conferir:** a função responde a um código válido. Não siga sem isso — ela é a
única saída do acoplamento A.

`sweep-stale-requesting` só faz sentido com a 0068 aplicada (é ela que agenda o
cron), então fica para a Fase 2.

---

## 5. Fase 2 — migrations

```bash
npx supabase db push
```

Isso aplica **0064 a 0077**. A 0078 já está no banco e é idempotente.

**Antes de rodar**, saiba que a 0072 derruba e recria `rides_with_locations`
**sem `cascade`**: se existir em produção um dependente que o repositório não
conhece, ela falha e reverte inteira, mostrando o nome dele. É o desfecho
desejado — falhar alto é recuperável.

**Imediatamente depois**, e antes de qualquer outra coisa:

```sql
-- O acoplamento A, neutralizado por uma janela.
-- A build 1.0.5 ainda precisa disto para o QR funcionar. REMOVER na Fase 5.
grant select on public.profiles_public to anon;
```

Isso reabre, de propósito e temporariamente, a leitura anônima do diretório —
que é **exatamente o estado de hoje**, não uma piora. A diferença é que agora
tem data para acabar.

**Conferir depois do push:**

```sql
select count(*) from supabase_migrations.schema_migrations where version >= '0064';
-- esperado: 14
```

---

## 6. Fase 3 — publicar as funções modificadas

```bash
npx supabase functions deploy charge-ride
npx supabase functions deploy tip-ride
npx supabase functions deploy setup-card
npx supabase functions deploy sync-card
npx supabase functions deploy stripe-webhook
npx supabase functions deploy remove-card
npx supabase functions deploy list-cards
npx supabase functions deploy refund-ride
npx supabase functions deploy dispatch-engine
npx supabase functions deploy send-ride-push
npx supabase functions deploy sweep-stale-requesting
npx supabase functions deploy admin-telematics-export
npx supabase functions deploy connect-account-status
npx supabase functions deploy request-payout
npx supabase functions deploy run-weekly-payouts
npx supabase functions deploy places-search
```

**`charge-ride` é a que importa mais** — sem ela, os consertos de pagamento não
existem, mesmo com a build nova.

**Conferir:** faça uma corrida de ponta a ponta com cartão real. `paid = true` e
`stripe_payment_intent_id` preenchido é o único sinal que vale.

---

## 7. Fase 4 — build e envio

O `eas.json` usa `appVersionSource: "remote"` e `autoIncrement: true` no perfil
de produção, então o número de build sobe sozinho. Mas a **versão visível** está
fixa em `1.0.5` no `app.config.js:28` e não sobe sozinha — suba à mão, senão a
faixa interna recebe outra 1.0.5 e ninguém sabe o que está rodando.

```bash
# 1. bump em app.config.js: version: '1.0.6'
# 2. commit de tudo o que está pendente
# 3. build
npx eas build --platform android --profile production

# 4. envio para a faixa interna
npx eas submit --platform android --profile interno
```

O perfil `interno` usa `./google-service-account.json` e o track `internal`.
Existe também `producao-sem-revisao` (`changesNotSentForReview: true`) — **não é
o que você quer aqui**: ele publica no track de produção pulando a revisão.

**Antes do build**, o repositório precisa estar commitado. Hoje há 15 migrations
e dezenas de arquivos como `??` ou ` M`, incluindo os arquivos que estavam sob
sua edição.

---

## 8. Fase 5 — fechar a janela do `anon`

Só depois de confirmar que a faixa interna atualizou:

```sql
revoke all on public.profiles_public from anon;

-- conferência: tem de voltar ZERO linhas
select grantee, privilege_type
  from information_schema.role_table_grants
 where table_schema = 'public' and table_name = 'profiles_public' and grantee = 'anon';
```

Esqueça este passo e o diretório de usuários fica legível com a anon key
embutida no binário — nome, foto, nota e tipo de todo mundo. Foi o P0.b da
auditoria, e ele volta inteiro.

---

## 9. O que NÃO fazer nesta rodada

**Não ligue `dispatch_engine_v2`.** A 0076 conserta a recursão, mas o motor v2
nunca rodou contra um Supabase de verdade. Ligar merece rodada própria, com o
`service_role_key` provisionado no Vault e a cadência do `pg_cron` confirmada —
os dois itens do §7 da auditoria.

**Não cobre as 14 contas** que perderam forma de pagamento. Elas precisam
recadastrar, e o cadastro só passa a gravar tipo/rótulo corretamente depois da
Fase 3.

---

## 10. Como voltar atrás

| fase | reverter |
|---|---|
| 1 | nada a fazer — função nova não é chamada por ninguém |
| 2 | **não há rollback automático.** As 14 são aditivas ou substituem policies; a única destrutiva é a 0072, que reverte sozinha se falhar. Um snapshot do banco antes do push é a rede |
| 3 | `npx supabase functions deploy <nome>` a partir de um commit anterior |
| 4 | despromover a build na faixa interna pelo Play Console |
| 5 | `grant select on public.profiles_public to anon` de volta |

O ponto sem retorno é a Fase 2. **Tire o snapshot do banco antes dela.**
