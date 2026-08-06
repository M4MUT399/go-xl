-- Comissão em faixas por motorista (parceria) — modelo "Separate Charges & Transfers".
--
-- Regra de negócio:
--   Os 100 primeiros motoristas a CONCLUÍREM o onboarding (charges_enabled=true)
--   recebem 85% (plataforma 15%). Do 101º em diante, 80% (plataforma 20%).
--   A faixa é FIXADA no instante da conclusão do onboarding e NUNCA é recalculada
--   retroativamente — cada motorista carrega sua fatia para sempre.
--
-- Por que campos por motorista (e não uma constante global):
--   Hoje src/lib/split.ts usa 80/20 fixo global. Para diferenciar por motorista
--   sem recalcular o passado, guardamos a fatia decidida no onboarding em
--   profiles.driver_share_percent e aplicamos essa fatia na ACEITAÇÃO da corrida
--   (quando o driver_id passa a existir — no pedido o motorista é desconhecido).
--
-- Campos novos em profiles:
--   driver_share_percent   → fatia do motorista (0.850 ou 0.800). NULL = ainda não
--                            concluiu onboarding / faixa não atribuída.
--   driver_onboarded_seq   → ordem de conclusão do onboarding (1,2,3,...). Auditoria:
--                            permite saber a partir de qual motorista começou a faixa
--                            de 20% (seq >= 101).
--   stripe_charges_enabled → espelha account.charges_enabled do Stripe. As migrações
--                            anteriores só espelhavam onboarding_complete + payouts.
--                            O gating de "ficar online" exige charges + payouts.

alter table public.profiles
  add column if not exists driver_share_percent   numeric(4,3),
  add column if not exists driver_onboarded_seq    integer,
  add column if not exists stripe_charges_enabled  boolean not null default false;

-- Sequência global de conclusão de onboarding — concorrência-segura por natureza.
create sequence if not exists public.driver_onboard_seq;

-- Índice para o endpoint de auditoria (contagem por faixa / ordenação por seq).
create index if not exists idx_profiles_driver_onboarded_seq
  on public.profiles (driver_onboarded_seq)
  where driver_onboarded_seq is not null;

-- ── assign_driver_tier ────────────────────────────────────────────────────────
-- Atribui, uma única vez, a faixa de comissão do motorista no momento em que ele
-- conclui o onboarding. Idempotente: se já houver fatia, apenas a retorna sem
-- consumir a sequência (não "queima" número de ordem em chamadas repetidas).
--
-- Concorrência: SELECT ... FOR UPDATE serializa chamadas para o MESMO motorista.
-- nextval() é atômico entre motoristas distintos, garantindo ordem consistente.
--
-- SECURITY DEFINER + acesso restrito ao service_role: a atribuição só pode ser
-- disparada pelo backend (edge functions com service key), depois de o Stripe
-- confirmar charges_enabled=true. Um usuário autenticado NÃO pode se auto-atribuir
-- uma faixa antecipada.
create or replace function public.assign_driver_tier(p_driver uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share numeric(4,3);
  v_seq   integer;
begin
  select driver_share_percent
    into v_share
    from public.profiles
   where id = p_driver
   for update;

  -- Já atribuída — nunca recalcula.
  if v_share is not null then
    return v_share;
  end if;

  v_seq   := nextval('public.driver_onboard_seq');
  v_share := case when v_seq <= 100 then 0.850 else 0.800 end;

  update public.profiles
     set driver_onboarded_seq = v_seq,
         driver_share_percent = v_share
   where id = p_driver;

  return v_share;
end;
$$;

-- Somente o backend (service_role) pode disparar a atribuição.
revoke all on function public.assign_driver_tier(uuid) from public;
revoke all on function public.assign_driver_tier(uuid) from anon;
revoke all on function public.assign_driver_tier(uuid) from authenticated;
grant execute on function public.assign_driver_tier(uuid) to service_role;
