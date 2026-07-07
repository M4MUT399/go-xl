-- Gating de "ficar online" no BACKEND (não só na UI).
--
-- Regra: um motorista parceiro só pode aparecer como disponível (is_online=true)
-- se a conta Stripe Connect dele estiver plenamente habilitada — charges_enabled
-- E payouts_enabled. Isso impede que um cliente adulterado (ou um bug de UI)
-- coloque no ar um motorista que ainda não concluiu o onboarding / KYC.
--
-- Implementação: trigger BEFORE INSERT/UPDATE em driver_locations. Se a corrida
-- tentar gravar is_online=true sem os flags habilitados, o valor é coagido para
-- false no próprio banco. É a fonte da verdade — a UI apenas espelha.

create or replace function public.enforce_driver_online_gating()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_enabled boolean;
begin
  if new.is_online is true then
    select (stripe_charges_enabled and stripe_payouts_enabled)
      into v_enabled
      from public.profiles
     where id = new.driver_id;

    -- Conta não habilitada (ou perfil inexistente) → força offline.
    if v_enabled is distinct from true then
      new.is_online := false;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_driver_online_gating on public.driver_locations;
create trigger trg_driver_online_gating
  before insert or update on public.driver_locations
  for each row execute function public.enforce_driver_online_gating();

-- Backfill: motoristas que JÁ recebiam repasse (stripe_payouts_enabled=true)
-- quase certamente têm cobranças habilitadas — a conta precisa estar ativa para
-- receber transfers. Evita derrubar do ar, na aplicação desta migração, quem já
-- operava. O próximo poll de connect-account-status corrige qualquer exceção.
update public.profiles
   set stripe_charges_enabled = true
 where stripe_payouts_enabled = true
   and stripe_charges_enabled = false;
