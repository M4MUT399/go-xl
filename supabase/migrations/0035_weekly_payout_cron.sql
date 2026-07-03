-- Repasse semanal automático — agendamento no Postgres (pg_cron + pg_net).
--
-- Por quê:
--   Além do botão "Solicitar repasse" (Edge Function request-payout), o fundador
--   quer o repasse automático UMA VEZ POR SEMANA: toda segunda-feira após o
--   meio-dia no horário de Orlando/ET. Este agendamento chama a Edge Function
--   `run-weekly-payouts`, que varre todos os motoristas com conta Express e
--   saldo pendente e cria um transfer por motorista.
--
-- Fuso horário:
--   pg_cron roda em UTC. 17:00 UTC = 12:00 EST (inverno) / 13:00 EDT (verão) —
--   ou seja, sempre a partir do meio-dia em Orlando, atendendo "após as 12:00h".
--   Para mudar o horário, ajuste a expressão cron '0 17 * * 1' (min hora * * dia;
--   1 = segunda-feira).
--
-- Autenticação da chamada:
--   A função exige Authorization: Bearer <service_role_key>. A URL do projeto é
--   pública (já consta no app), então só a chave é lida do Vault — nada secreto
--   é versionado aqui. Pré-requisito (feito uma única vez no painel):
--     insert into vault.secrets (name, secret)
--     values ('service_role_key', '<SUA_SERVICE_ROLE_KEY>');
--
-- Segurança:
--   Reaplicar esta migration é idempotente (desagenda a versão anterior antes de
--   reagendar). O histórico de execuções fica em cron.job_run_details.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Remove versão anterior do job (permite reagendar sem duplicar).
select cron.unschedule('weekly-driver-payouts')
where exists (select 1 from cron.job where jobname = 'weekly-driver-payouts');

-- Toda segunda-feira 17:00 UTC (12:00 EST / 13:00 EDT em Orlando).
select cron.schedule(
  'weekly-driver-payouts',
  '0 17 * * 1',
  $$
    select net.http_post(
      url     := 'https://zukydkodafdmhaulhxeh.supabase.co/functions/v1/run-weekly-payouts',
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
