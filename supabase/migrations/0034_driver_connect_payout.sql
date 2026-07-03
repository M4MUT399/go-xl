-- Stripe Connect Express — repasse real ao motorista.
--
-- Por quê:
--   Até aqui `payouts` era só um livro-razão: requestPayout() inseria uma linha
--   'pending' e vinculava as corridas, mas NENHUM dinheiro se movia. Para o
--   beta fechado o fundador quer repasse real. O modelo escolhido é
--   "separate charges & transfers": a plataforma cobra o passageiro
--   (charge-ride, já existe) e, quando o motorista toca "Solicitar repasse",
--   o servidor cria um transfer do saldo da plataforma para a conta conectada
--   (Express) do motorista.
--
-- Campos novos:
--   profiles.stripe_account_id        → id da conta conectada Express (acct_…)
--   profiles.stripe_onboarding_complete → espelha account.details_submitted
--   profiles.stripe_payouts_enabled     → espelha account.payouts_enabled
--                                         (só quando true o transfer é possível)
--   payouts.stripe_transfer_id        → id do transfer criado (tr_…)
--   payouts.failure_reason            → motivo quando status = 'failed'

alter table public.profiles
  add column if not exists stripe_account_id          text,
  add column if not exists stripe_onboarding_complete boolean not null default false,
  add column if not exists stripe_payouts_enabled     boolean not null default false;

alter table public.payouts
  add column if not exists stripe_transfer_id text,
  add column if not exists failure_reason     text;
