-- Adiciona token de push notification ao perfil
-- Rode no SQL Editor do Supabase se o banco já existir sem essa coluna
alter table public.profiles add column if not exists push_token text;
