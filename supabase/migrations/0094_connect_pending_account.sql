-- ═════════════════════════════════════════════════════════════════════════════
-- 0094 — conta Connect de substituição fica EM ESPERA até ser aprovada
-- ═════════════════════════════════════════════════════════════════════════════
--
-- O caso (05/11/2026): o motorista ativo tocou "Set up" em Ganhos e recebeu "You
-- requested an account link for an account that is not connected to your
-- platform or does not exist". O `stripe_account_id` dele aponta para uma conta
-- que a plataforma atual não alcança, e connect-onboard-driver só cria conta
-- quando o campo está vazio. Resultado: botão sem saída e nenhum repasse.
--
-- POR QUE NÃO TROCAR O ID DIRETO. Conta nova nasce sem aprovação. O webhook
-- account.updated e o connect-account-status espelham essas flags no perfil, e
-- com elas falsas o motorista sai do ar (stripe-webhook, 0038) — por dias, se a
-- Stripe pedir documento. Consertar o repasse não pode parar quem está rodando.
--
-- O DESENHO. A conta nova fica nesta coluna. O `stripe_account_id` e as flags só
-- mudam quando a Stripe aprovar a conta nova (charges + payouts): aí ela é
-- PROMOVIDA, de uma vez. Corridas e saldo não são tocados: a fila de repasse é
-- por motorista, e passa a sair para a conta promovida.
--
-- O GUARDA. Esta coluna vira destino de dinheiro ao ser promovida. Se o cliente
-- pudesse escrevê-la, bastaria gravar a conta de outra pessoa da plataforma.
-- Mesma regra de stripe_account_id em 0065: só o backend escreve.
-- ═════════════════════════════════════════════════════════════════════════════

set lock_timeout = '3s';

alter table public.profiles
  add column if not exists stripe_pending_account_id text;

comment on column public.profiles.stripe_pending_account_id is
  'Conta Connect nova, aguardando aprovação, que substituirá um stripe_account_id inalcançável. Escrita só pelo backend; promovida por connect-account-status ou stripe-webhook.';

create unique index if not exists profiles_stripe_pending_account_uniq
  on public.profiles (stripe_pending_account_id)
  where stripe_pending_account_id is not null;

create or replace function public.guard_profile_pending_account()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_role text := auth.role();
begin
  if v_role is null or v_role = 'service_role' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.stripe_pending_account_id := null;
  else
    new.stripe_pending_account_id := old.stripe_pending_account_id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_profile_pending_account on public.profiles;
create trigger trg_guard_profile_pending_account
  before insert or update on public.profiles
  for each row execute function public.guard_profile_pending_account();
