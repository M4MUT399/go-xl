-- Marca se a corrida foi paga (pagamento via Stripe ao concluir).
-- Rode no SQL Editor do Supabase se o banco já existir sem essa coluna.
alter table public.rides add column if not exists paid boolean default false;
