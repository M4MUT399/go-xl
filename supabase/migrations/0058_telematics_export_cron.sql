-- Bloco 2 (compliance F.S. 627.748) — agendamento do export mensal para a
-- seguradora/underwriter via pg_cron + pg_net, chamando a Edge Function
-- admin-telematics-export (mesmo padrão de weekly-driver-payouts, migration
-- 0035: service_role_key lida do Vault, nunca versionada em texto puro).
--
-- Por que uma migration separada da 0057: a Edge Function chamada aqui só
-- passou a existir depois da 0057 (que cuida só de partição/retenção/tabelas
-- de apoio) — mantém cada migration com um número de deploy exigível de
-- artefato pronto (não agenda a chamada de uma função que ainda não existe).
--
-- Horário: dia 1 de cada mês, 06:30 UTC — 15 minutos DEPOIS do job
-- 'period-transitions-maintenance' (06:15 UTC, migration 0057), para rodar
-- só depois que a partição do mês corrente já foi garantida (o export em si
-- lê driver_period_daily_mileage, não a trilha particionada, mas manter a
-- ordem evita qualquer corrida entre as duas manutenções mensais).
--
-- A função já trata sozinha o caso da flag period_audit_v1_enabled estar
-- desligada (responde 200 { skipped: true } em vez de erro) — então este job
-- pode ficar agendado sempre, mesmo antes do rollout da flag em produção.
--
-- Pré-requisito (já deve existir da migration 0035 — reaproveitado aqui):
--   insert into vault.secrets (name, secret) values ('service_role_key', '<SUA_SERVICE_ROLE_KEY>');

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.unschedule('telematics-monthly-export')
where exists (select 1 from cron.job where jobname = 'telematics-monthly-export');

select cron.schedule(
  'telematics-monthly-export',
  '30 6 1 * *',
  $$
    select net.http_post(
      url     := 'https://zukydkodafdmhaulhxeh.supabase.co/functions/v1/admin-telematics-export',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
        )
      ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 30000
    );
  $$
);
