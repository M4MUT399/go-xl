-- Item 9 (admin/backend), sub-item 2: retenção/TTL para tabelas de auditoria.
--
-- Escopo (decisão do usuário): só admin_audit_log e ride_offer_events.
-- Explicitamente NÃO inclui `waybills` — é documento fiscal (recibo de
-- corrida), precisa de retenção mais longa que uma trilha de log técnico;
-- fica de fora deste job.
--
-- Janela: 180 dias. Depois disso os eventos já perderam a utilidade
-- operacional (suporte/compliance de curto prazo) que justifica mantê-los
-- na tabela quente; nenhuma tela do produto lê linhas fora dessa janela.
--
-- Mecanismo: pg_cron com DELETE direto em SQL (não uma Edge Function via
-- net.http_post como em 0035_weekly_payout_cron.sql) — aqui não há lógica de
-- negócio nenhuma para justificar sair do banco, é só uma limpeza por data;
-- um round-trip HTTP só adicionaria uma dependência de rede sem benefício.

create extension if not exists pg_cron;

select cron.unschedule('purge-old-audit-logs')
where exists (select 1 from cron.job where jobname = 'purge-old-audit-logs');

select cron.schedule(
  'purge-old-audit-logs',
  '30 6 * * *',  -- 06:30 UTC diariamente, fora do horário de pico do app
  $$
    delete from public.admin_audit_log where created_at < now() - interval '180 days';
    delete from public.ride_offer_events where created_at < now() - interval '180 days';
  $$
);
