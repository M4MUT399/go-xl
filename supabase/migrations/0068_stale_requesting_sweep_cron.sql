-- Varredura de corridas COBRADAS E ABANDONADAS — agendamento (pg_cron + pg_net).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- O QUE ISTO VARRE
-- ─────────────────────────────────────────────────────────────────────────────
-- Corridas paradas em `status = 'requesting'` com `paid = true`: o passageiro
-- foi cobrado, nenhum motorista foi designado e a viagem não vai acontecer.
-- Acontece quando a cobrança de `acceptRide` sai (useRide.ts:1624) e o UPDATE
-- seguinte falha (useRide.ts:1668-1690): o cliente devolve a corrida ao leque
-- sem estornar, e o único estorno desse caminho era uma rede de segurança do
-- lado do CLIENTE (useRide.ts:759-770) — que não roda se o app fechar, mudar de
-- tela ou perder a rede.
--
-- Sem esta varredura o dinheiro ficava com a plataforma por OMISSÃO, e nem
-- aparecia no repasse: a elegibilidade exige `driver_id` e `driver_amount` não
-- nulos (run-weekly-payouts/index.ts:268-273) e uma corrida `requesting` não tem
-- nenhum dos dois.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- POR QUE UM JOB PRÓPRIO A CADA 10 MINUTOS
-- ─────────────────────────────────────────────────────────────────────────────
-- Os agendamentos que já existiam eram todos inadequados: `weekly-driver-payouts`
-- (0035) roda uma vez por SEMANA e por MOTORISTA — devolveria em até 7 dias um
-- dinheiro perdido em 30 minutos, e estas corridas por definição não têm
-- motorista; os jobs de retenção (0052, 0057) e de telemetria (0058, 0063) não
-- tocam em dinheiro nem têm chave do Stripe. O `tick` do dispatch não tem cron —
-- é disparado pelo cliente, exatamente o que não existe no cenário do defeito.
--
-- 10 min é o intervalo de VARREDURA; a idade mínima para estornar é 30 min e
-- mora na Edge Function (MIN_AGE_MS). São coisas diferentes de propósito: o
-- passageiro espera no máximo ~40 min pelo dinheiro de volta, e nenhuma corrida
-- corre risco de ser estornada com o motorista a caminho.
--
-- Custo do caso normal: uma consulta indexada que devolve ZERO linha. Nada é
-- chamado no Stripe quando não há candidata.
--
-- Idempotência: garantida na Edge Function em três camadas (filtro `paid = true`
-- + chave de idempotência `refund_<payment_intent>` COMPARTILHADA com o
-- refund-ride + upsert por `event_id`). Duas execuções sobrepostas não geram
-- dois estornos. Ver o cabeçalho de supabase/functions/sweep-stale-requesting.
--
-- Autenticação da chamada:
--   A função exige Authorization: Bearer <service_role_key> (isServiceRole).
--   Mesma leitura do Vault que 0035 — nada secreto é versionado aqui.
--   Pré-requisito (uma única vez, já feito para o 0035):
--     insert into vault.secrets (name, secret)
--     values ('service_role_key', '<SUA_SERVICE_ROLE_KEY>');
--
-- Reaplicar esta migration é idempotente (desagenda antes de reagendar).
-- O histórico de execuções fica em cron.job_run_details.

-- PRIMEIRA INSTRUÇÃO DO ARQUIVO, mesmo motivo da 0066: `set` (de sessão, sem
-- `local`) cobre TODAS as instruções abaixo em qualquer modo de aplicação —
-- `supabase db push`, `psql -f` e o editor SQL do painel — enquanto um
-- `set local` só valeria dentro de uma transação que este arquivo não abre.
-- O `create index` abaixo pega ACCESS EXCLUSIVE em `public.rides`: sem timeout,
-- uma corrida em andamento segurando a tabela põe a migração numa fila que
-- bloqueia TODA leitura/escrita de `rides` atrás dela. Com timeout, a migração
-- desiste em 3s e o operador tenta de novo num momento calmo.
set lock_timeout = '3s';

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Índice parcial que sustenta a consulta da varredura
-- (`status = 'requesting' and paid = true` ordenado por `created_at`).
-- Parcial de propósito: no caso normal ele tem ZERO linha, então é minúsculo e
-- não pesa em nenhuma escrita de `rides` fora desse estado — a construção é
-- praticamente instantânea, e é por isso que ela cabe num `lock_timeout` de 3s.
--
-- Sem `concurrently` DE PROPÓSITO, mesma escolha da 0066: `create index
-- concurrently` é ILEGAL dentro de um bloco de transação, e `supabase db push`
-- pode envolver a migração numa. Um índice parcial vazio não justifica um
-- arquivo que só aplica em um dos modos.
create index if not exists rides_stale_requesting_idx
  on public.rides (created_at)
  where status = 'requesting' and paid = true;

-- Remove versão anterior do job (permite reagendar sem duplicar).
select cron.unschedule('stale-requesting-sweep')
where exists (select 1 from cron.job where jobname = 'stale-requesting-sweep');

-- A cada 10 minutos.
--
-- SOBRE O `timeout_milliseconds` ABAIXO — o que ele realmente faz.
-- ─────────────────────────────────────────────────────────────────────────────
-- Ele NÃO cancela nada do outro lado. Passados 60s o `pg_net` abandona a
-- RESPOSTA; a função continua rodando no Deno até terminar, estornando. Ou
-- seja: o timeout não é um limite de trabalho, é um limite de paciência — e o
-- que ele produz, quando estoura, é trabalho feito que ninguém registrou.
--
-- A versão anterior emparelhava estes 60s com um laço SEQUENCIAL de até
-- MAX_PER_RUN = 100 estornos. Cada estorno é ao menos uma ida ao Stripe; 100
-- idas em série não cabem em 60s em nenhum cenário realista, então o corte era
-- a REGRA, não a exceção — e invisível, porque a linha do `cron.job_run_details`
-- só registrava o abandono da resposta.
--
-- O que mudou, do lado da função (sweep-stale-requesting/index.ts):
--
--   1. MAX_PER_RUN caiu para 15. A cada 10 min, 15 estornos comportam 90/hora —
--      folgado para um backlog que, no caso normal, tem zero linha.
--   2. RUN_BUDGET_MS = 45s: o laço confere o relógio ANTES de cada corrida e
--      para por conta própria com margem sobre estes 60s. Uma corrida não
--      processada continua `requesting` + `paid = true` e é pega na rodada
--      seguinte — o critério de seleção é o próprio estado, não uma fila.
--   3. Toda rodada grava uma linha de resumo em `stripe_reconciliation`
--      (`code = 'run_summary'`), com `needs_attention = true` quando o lote
--      encheu ou o orçamento estourou. É isso que torna o corte DETECTÁVEL sem
--      depender da resposta HTTP que o pg_net pode ter jogado fora.
--
-- Os 60s ficam como estão: com o orçamento de 45s do lado de lá, é a margem, e
-- não mais o limite operativo. NÃO MEDIDO: a latência real do Stripe por
-- estorno não foi medida neste ambiente (sem acesso à API). O número 15 é
-- conservador por escolha, e a linha de resumo existe justamente porque ele é
-- uma estimativa e não uma medição.
select cron.schedule(
  'stale-requesting-sweep',
  '*/10 * * * *',
  $$
    select net.http_post(
      url     := 'https://zukydkodafdmhaulhxeh.supabase.co/functions/v1/sweep-stale-requesting',
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
