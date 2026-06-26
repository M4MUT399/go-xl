-- Guarda o ID do PaymentIntent do Stripe na corrida para permitir extornos.
alter table public.rides
  add column if not exists stripe_payment_intent_id text;
