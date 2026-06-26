-- Informações de pagamento Stripe por passageiro.
-- stripe_customer_id       → ID do Customer no Stripe (criado na 1ª configuração de cartão)
-- stripe_payment_method_id → ID do PaymentMethod padrão salvo
-- card_last4 / card_brand  → Exibição local sem chamar a API do Stripe
alter table public.profiles
  add column if not exists stripe_customer_id      text,
  add column if not exists stripe_payment_method_id text,
  add column if not exists card_last4              text,
  add column if not exists card_brand              text;
