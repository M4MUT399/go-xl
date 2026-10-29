-- 0064 — a gorjeta passa a ser dinheiro do MOTORISTA.
--
-- Situação até aqui: `tip-ride` cobrava a gorjeta do passageiro, gravava
-- rides.tip_amount e parava por aí. Os dois caminhos de repasse
-- (request-payout e run-weekly-payouts) somam EXCLUSIVAMENTE driver_amount,
-- e driver_amount é calculado em useRide.applyDriverSplit como
--
--     (price - toll - venueFee) * share + toll
--
-- ou seja, a gorjeta nunca entrou. O pedágio alguém lembrou de repassar; a
-- gorjeta ficava retida na plataforma por omissão. Reter gorjeta de motorista
-- é problema jurídico, não só bug.
--
-- Duas colunas novas:
--
--   tip_payment_intent_id — o PaymentIntent DA GORJETA. Não dá para reaproveitar
--     stripe_payment_intent_id (esse é o da tarifa): são cobranças separadas,
--     `charge_<id>` e `tip_<id>`. Precisamos do id da gorjeta porque o transfer
--     é sacado da cobrança de origem via `source_transaction`, e o Stripe
--     REJEITA transfer maior que a cobrança que o lastreia. Somar a gorjeta ao
--     transfer da tarifa estouraria esse teto sempre que
--     (tarifa * share) + gorjeta > tarifa — que é o caso comum: na corrida do
--     Jeff seriam $39.82 + $10.00 = $49.82 contra uma cobrança de $49.77.
--     Por isso a gorjeta vira um transfer PRÓPRIO.
--
--   tip_payout_id — em qual repasse a gorjeta saiu. Coluna separada de
--     payout_id de propósito: a gorjeta é cobrada DEPOIS da corrida, e um
--     repasse pode acontecer no intervalo entre o fim da viagem e o passageiro
--     resolver dar gorjeta. Se a gorjeta dependesse de payout_id, toda gorjeta
--     dada após o repasse da corrida ficaria presa para sempre.

alter table public.rides
  add column if not exists tip_payment_intent_id text,
  add column if not exists tip_payout_id uuid references public.payouts(id) on delete set null;

comment on column public.rides.tip_payment_intent_id is
  'PaymentIntent da GORJETA (distinto de stripe_payment_intent_id, que é o da tarifa). Lastreia o transfer da gorjeta via source_transaction.';
comment on column public.rides.tip_payout_id is
  'Repasse em que a gorjeta foi transferida ao motorista. Independente de payout_id: a gorjeta pode chegar depois do repasse da corrida.';

-- Busca do saldo de gorjeta pendente: gorjetas com valor, ainda não repassadas.
create index if not exists idx_rides_tip_pendente
  on public.rides (driver_id)
  where tip_amount > 0 and tip_payout_id is null;
