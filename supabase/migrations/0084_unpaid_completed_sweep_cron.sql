-- ═════════════════════════════════════════════════════════════════════════════
-- 0084 — varredura de corridas CONCLUÍDAS E NÃO COBRADAS (pg_cron + pg_net)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- A simétrica da 0068: aquela agenda a varredura que DEVOLVE dinheiro cobrado
-- que não virou viagem; esta agenda a que COBRA viagem que aconteceu e não virou
-- dinheiro.
--
-- ── O BURACO, MEDIDO E NÃO SUPOSTO (05/09/2026) ─────────────────────────────
--
-- Levantamento das 128 corridas concluídas desde 01/07, contra o banco e a conta
-- Stripe de produção:
--
--   • até 30/07 — ~120 corridas, quase todas IMEDIATAS: todas cobradas pelo app.
--   • de 17/08 em diante — 5 corridas, TODAS AGENDADAS: nenhuma cobrada pelo app.
--
-- Quatro foram salvas à mão (os PaymentIntents delas têm
-- `metadata.retroativo = "true"`, do `supabase/scripts/charge_unpaid_ride.ts`) e
-- a quinta ficou um dia parada sem que nada percebesse. Corrida imediata cobra;
-- corrida agendada não cobra — 5 em 5.
--
-- A causa é que todas as portas de cobrança de uma agendada vivem num celular, a
-- última delas num `void (async () => …)` que dispara e esquece no aparelho do
-- motorista. Nada no servidor olhava `status = 'completed' and paid = false` — o
-- `sweep-stale-requesting` só enxerga `requesting`. O diagnóstico inteiro está
-- em `supabase/functions/_shared/unpaidRideSweep.ts`.
--
-- ── PRÉ-REQUISITO, O MESMO DA 0068 ──────────────────────────────────────────
--
-- A Edge Function exige `Authorization: Bearer <service_role_key>` comparado com
-- a própria chave (`_shared/serviceAuth.ts`). O cron lê essa chave do Vault. Se
-- o segredo `service_role_key` NÃO existir, o job roda, leva 401 e não varre
-- nada — em silêncio, porque o `pg_net` descarta a resposta. Conferir com:
--
--     select name from vault.secrets where name = 'service_role_key';
--
-- e, se faltar (a 0068 já o exige, então normalmente ele existe):
--
--     insert into vault.secrets (name, secret)
--     values ('service_role_key', '<SUA_SERVICE_ROLE_KEY>');
--
-- ── ORDEM DE IMPLANTAÇÃO ────────────────────────────────────────────────────
--
-- Publicar a função ANTES de aplicar esta migração:
--
--     npx supabase functions deploy sweep-unpaid-completed
--
-- Ao contrário, o primeiro disparo do cron bate num 404 e a varredura só começa
-- de fato no ciclo seguinte à publicação. Não estraga nada — só atrasa.
-- ═════════════════════════════════════════════════════════════════════════════

-- Mesmo motivo da 0068: o `create index` abaixo pega ACCESS EXCLUSIVE em
-- `public.rides`. Sem timeout, uma corrida em andamento segurando a tabela põe a
-- migração numa fila que bloqueia toda leitura/escrita de `rides` atrás dela.
set lock_timeout = '3s';

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Índice parcial que sustenta a consulta da varredura
-- (`status = 'completed' and paid = false` ordenado por `completed_at`).
--
-- Parcial de propósito: no estado saudável ele tem ZERO linha — é minúsculo, não
-- pesa em nenhuma escrita de `rides` fora desse estado, e a construção é
-- praticamente instantânea, que é o que faz caber no `lock_timeout` de 3s.
--
-- Sem `concurrently` DE PROPÓSITO, mesma escolha da 0066 e da 0068: `create
-- index concurrently` é ILEGAL dentro de um bloco de transação, e o
-- `supabase db push` pode envolver a migração numa.
create index if not exists rides_unpaid_completed_idx
  on public.rides (completed_at)
  where status = 'completed' and paid = false;

-- Remove versão anterior do job (permite reagendar sem duplicar).
select cron.unschedule('unpaid-completed-sweep')
where exists (select 1 from cron.job where jobname = 'unpaid-completed-sweep');

-- A cada 30 minutos — e não a cada 10, como a 0068.
--
-- POR QUE MENOS FREQUENTE QUE A OUTRA. Lá o relógio corre contra a plataforma:
-- há dinheiro de passageiro retido que precisa voltar, e cada ciclo é mais tempo
-- com o dinheiro de outra pessoa. Aqui não há urgência simétrica — a viagem já
-- aconteceu, o valor está registrado, e a função ainda espera 20 min de carência
-- por corrida para não correr contra a rede de segurança do app. Meia hora é
-- frequente o bastante para que nenhuma corrida passe um dia parada (foi o que
-- aconteceu em 05/09) e raro o bastante para não gastar chamada à toa num
-- estado que, com o app saudável, é vazio.
--
-- SOBRE O `timeout_milliseconds`: o `pg_net` ABANDONA a resposta passados os
-- 60s, mas NÃO cancela nada do outro lado — a função segue rodando até o fim.
-- Por isso ela tem orçamento próprio de 45s e grava a linha-resumo em
-- `stripe_reconciliation` pelo próprio Deno: é a única coisa que sobrevive ao
-- abandono da resposta HTTP.
select cron.schedule(
  'unpaid-completed-sweep',
  '*/30 * * * *',
  $$
    select net.http_post(
      url     := 'https://zukydkodafdmhaulhxeh.supabase.co/functions/v1/sweep-unpaid-completed',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
        )
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 60000
    );
  $$
);
