-- Item 9 (admin/backend), sub-item 1: rate limit nas Edge Functions admin.
--
-- Escopo (decisão do usuário): só as 3 funções administrativas —
-- admin-driver-verification, admin-commission-tiers, admin-waybills.
-- Não se aplica a funções operacionais do app (request-payout, track-trip,
-- etc.) nem ao restante da API pública.
--
-- Por que uma tabela + função SQL, e não contador em memória na Edge
-- Function: Edge Functions rodam em instâncias efêmeras/paralelas (Deno
-- Deploy), então um contador em memória não é confiável entre invocações.
-- Usamos um "bucket" fixo por janela de tempo em Postgres (upsert atômico
-- via ON CONFLICT), suficiente para o volume de uso de um painel admin
-- interno — não é uma solução para tráfego de borda em larga escala.

create table if not exists public.admin_rate_limits (
  admin_id       uuid        not null,
  function_name  text        not null,
  window_start   timestamptz not null,
  request_count  integer     not null default 1,
  primary key (admin_id, function_name, window_start)
);

comment on table public.admin_rate_limits is
  'Buckets de rate limit por (admin, função, janela de tempo) — usado só pelas Edge Functions admin via service_role. Ver migration 0051.';

alter table public.admin_rate_limits enable row level security;

-- Só service_role toca nesta tabela — nenhum client/admin do painel lê ou
-- escreve diretamente (evita um admin "resetar" o próprio limite via REST).
drop policy if exists admin_rate_limits_service_all on public.admin_rate_limits;
create policy admin_rate_limits_service_all
  on public.admin_rate_limits for all
  to service_role
  using (true)
  with check (true);

-- check_admin_rate_limit: incrementa atomicamente o bucket da janela atual e
-- devolve true se AINDA dentro do limite (request_count <= p_max_requests),
-- false se estourou. security definer porque é chamada com o client
-- service_role da Edge Function (que já ignora RLS) — o definer aqui só
-- evita depender de grants adicionais na tabela.
create or replace function public.check_admin_rate_limit(
  p_admin_id       uuid,
  p_function_name  text,
  p_max_requests   integer,
  p_window_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_start timestamptz;
  v_count        integer;
begin
  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into public.admin_rate_limits (admin_id, function_name, window_start, request_count)
  values (p_admin_id, p_function_name, v_window_start, 1)
  on conflict (admin_id, function_name, window_start)
  do update set request_count = admin_rate_limits.request_count + 1
  returning request_count into v_count;

  return v_count <= p_max_requests;
end;
$$;

revoke all on function public.check_admin_rate_limit(uuid, text, integer, integer) from public;
grant execute on function public.check_admin_rate_limit(uuid, text, integer, integer) to service_role;
