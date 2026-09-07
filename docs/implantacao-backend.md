# Go XL — Implantação do backend (Edge Functions, migrations, cron)

Procedimento e **conferência** de tudo que roda no Supabase. O foco não é
publicar — `supabase functions deploy` é uma linha —, é **provar que o que está
no ar é o que está no repositório**, porque a distância entre as duas coisas foi
a causa comum de quase todo defeito de pagamento encontrado em 06/09/2026.

## Por que este documento existe

Levantamento feito em 06/09/2026, com `supabase functions list` contra
produção. O banco estava em dia (migrations 0001–0083 aplicadas); as **funções**
é que estavam paradas:

| função | publicada em | código no repo |
|---|---|---|
| `sync-card` | 23/06 | 26/08 |
| `list-cards`, `remove-card` | 03/07 | 26/08 |
| `stripe-webhook` | 17/08 | 26/08 |
| `tip-ride` | 19/08 | 26/08 |
| `charge-ride` | 25/08 | 26/08 |
| `sweep-stale-requesting` | **nunca publicada** | 26/08 |
| `directions` | **nunca publicada** | 10/08 |

O estrago que isso produziu, todo medido e não suposto:

- **A gorjeta nunca funcionou.** Em toda a história do app existe UM
  PaymentIntent com `metadata.type = 'tip'`. A versão publicada da `tip-ride`
  era anterior ao conserto e trancava a corrida no primeiro valor tentado.
- **Corrida agendada rodava de graça.** 5 de 5 agendadas concluídas desde 17/08
  ficaram sem cobrança; 4 foram salvas à mão.
- **O `sweep-stale-requesting` bateu num 404 por dois meses.** A migration 0068
  agenda um cron a cada 10 minutos contra uma função que nunca subiu — 32
  respostas `404` em `net._http_response` só no dia do levantamento. A varredura
  de estorno nunca rodou uma vez.
- **A forma de pagamento ficava invisível.** As colunas `payment_method_type` /
  `payment_method_label` da 0078 nasciam nulas porque o `stripe-webhook` que as
  grava não estava publicado.

Nenhum desses aparece lendo o repositório. Todos aparecem em três comandos.

## Ordem de implantação

1. **Segredos primeiro.** `supabase secrets list`. Uma função publicada sem o
   segredo dela troca um fallback silencioso por um erro duro — foi por isso que
   a `directions` continua sem publicar (falta `GOOGLE_DIRECTIONS_API_KEY`).
2. **Funções depois.** Publicar ANTES da migration que as agenda: ao contrário,
   o primeiro disparo do cron bate num 404.
3. **Migrations por último.** `supabase db push`.
4. **Conferir** (a seção seguinte). Publicar não é implantar.

### `verify_jwt` é por função e precisa ser PRESERVADO

`supabase functions deploy <nome>` publica com `verify_jwt = true` a menos que
receba `--no-verify-jwt`. Republicar sem a flag muda o comportamento do
endpoint em silêncio. Antes de qualquer republicação em lote, leia o estado
atual e reproduza-o:

```
npx supabase functions list
```

Publicadas com `--no-verify-jwt` (estado em 06/09/2026): `tip-ride`,
`stripe-webhook`, `refund-ride`, `run-weekly-payouts`, `setup-card`,
`create-checkout`, `connect-onboard-driver`, `resolve-driver-code`,
`send-ride-push`, `dispatch-engine`, `track-trip`. As demais, sem a flag.

## Conferência — os quatro comandos que fecham o buraco

### 1. O que está no ar é o que está aqui?

```
npx supabase functions list
```

Compare `updated_at` de cada função com a data do último commit que tocou a
pasta dela **ou qualquer `_shared/*.ts` que ela importe** — um módulo
compartilhado entra no bundle no momento do deploy, então mexer nele deixa
velha toda função que o importa.

Prova mais forte, quando houver dúvida sobre uma função específica: baixe o que
está publicado e compare com o fonte.

```
npx supabase functions download <nome>
```

### 2. As migrations foram aplicadas?

```
npx supabase migration list
```

### 3. O cron está mesmo chamando alguém? (a pergunta que ninguém fazia)

`cron.job_run_details.status = 'succeeded'` **não** quer dizer que a função
rodou. Quer dizer que o `pg_net` conseguiu ENFILEIRAR a requisição. A resposta
HTTP mora em outro lugar:

```
npx supabase db query "select status_code, count(*), max(created) from net._http_response group by status_code" --linked
```

Qualquer coisa fora de `200` aqui é um job que não está fazendo nada:

- **404** → a função não foi publicada.
- **401** → a chave que o cron apresenta não é aceita (ver a armadilha abaixo).

E para ver quais jobs existem:

```
npx supabase db query "select jobname, schedule, active from cron.job order by jobid" --linked
```

### 4. O dinheiro faz sentido?

```
curl -s -X POST "$SUPABASE_URL/functions/v1/run-weekly-payouts" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H 'Content-Type: application/json' -d '{"dry_run":true}'
```

`dry_run` apura quem receberia e quanto **sem mover dinheiro**. Se o total
surpreender, ele está errado: em 06/09 o dry_run acusou US$ 2.681,47, dos quais
US$ 2.379,36 eram corrida e gorjeta de teste que nunca foram cobradas de
ninguém.

## Armadilhas conhecidas

### O segredo do Vault e o formato da chave

Os jobs de cron autenticam com `vault.secrets.service_role_key`, e as funções
comparam esse token com a env `SUPABASE_SERVICE_ROLE_KEY`. **Quando o projeto
rotaciona as chaves, o Vault não acompanha.** Em 04/09/2026 a service-role key
passou do formato JWT (`eyJ…`, 219 caracteres) para o novo (`sb_secret_…`, 41);
o Vault ficou com a antiga e todo cron passou a levar 401 — em silêncio, porque
o `pg_net` descarta a resposta.

Conferir sem imprimir o segredo:

```
npx supabase db query "select name, length(decrypted_secret), left(decrypted_secret,4) from vault.decrypted_secrets" --linked
```

O início e o tamanho precisam bater com a chave em uso. Se não baterem, o
segredo precisa ser atualizado para a chave nova — e essa é uma escrita de
credencial, feita pelo dono, nunca por automação.

### `paid = true` não quer dizer que o dinheiro entrou

Cobrança de modo de teste grava um `stripe_payment_intent_id` que não existe na
conta de produção. Em 06/09, de 127 corridas com `paid = true` somando
US$ 9.939,46, apenas 10 (US$ 350,67) tinham cobrança que existia de fato — 96%
do volume "pago" era do período de teste. Como o repasse seleciona por
`paid = true` e não pergunta ao Stripe, isso vira transferência real.

Os dois scripts que limpam isso, ambos com ensaio por padrão e auditoria com
desfazer: `supabase/scripts/clean_phantom_fares.ts` e
`supabase/scripts/clean_phantom_tips.ts`.

### NÃO rode `deno run --node-modules-dir=auto` a partir da raiz do repo

O Deno remonta o `node_modules` no layout dele e o jest para de transformar os
arquivos do React Native — a suíte inteira passa a falhar com
`Cannot use import statement outside a module`, sem que arquivo nenhum do
projeto tenha mudado. Aconteceu em 06/09; o conserto é `npm ci`.

Use `--node-modules-dir=none` nos scripts de `supabase/scripts/`, que é o que
os cabeçalhos deles já mandam.

## Checklist de release

- [ ] `npx supabase secrets list` — todo segredo que as funções novas exigem existe
- [ ] `npx supabase functions list` — anotar o `verify_jwt` atual de cada uma
- [ ] publicar as funções, preservando o `verify_jwt` de cada uma
- [ ] `npx supabase db push`
- [ ] `npx supabase functions list` — as datas subiram
- [ ] `net._http_response` — sem `404` nem `401` no ciclo seguinte
- [ ] `dry_run` do repasse — o total faz sentido
- [ ] `stripe_reconciliation where needs_attention` — nada novo e inesperado
