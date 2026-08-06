-- Adiciona coluna de gorjeta à tabela de corridas.
alter table public.rides
  add column if not exists tip_amount numeric;
