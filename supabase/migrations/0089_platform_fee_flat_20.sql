-- ═════════════════════════════════════════════════════════════════════════════
-- 0089 — comissão da plataforma única: 20% para todo motorista
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Decisão do Edson (26/10/2026): o valor repassado à plataforma passa a ser 20%
-- da corrida, para todos. Acaba a faixa de lançamento da 0037 (85% para os 100
-- primeiros motoristas, plataforma 15%).
--
-- O que muda:
--   1. assign_driver_tier passa a atribuir SEMPRE 0.800. A posição na fila
--      (driver_onboarded_seq) continua sendo gravada — é auditoria, não preço.
--   2. Quem já estava em 0.850 desce para 0.800. Como o split é calculado no
--      ACEITE (trigger de 0065 A.2 lê profiles.driver_share_percent), toda
--      corrida aceita depois desta migração já sai 80/20.
--
-- O que NÃO muda: corridas já aceitas. driver_amount/platform_fee de corrida
-- aceita sob a faixa de 85% ficam como estão — inclusive as ainda não
-- repassadas. Rebaixar o repasse de uma corrida que o motorista já rodou sob a
-- regra antiga é decisão de negócio separada; se for tomada, é um UPDATE
-- pontual com compute_ride_split(price, toll, venue, 0.800) nas linhas com
-- payout_id is null.
--
-- Rodar como migração (auth.role() nulo): os guardas de 0065 deixam passar.
-- ═════════════════════════════════════════════════════════════════════════════

set lock_timeout = '3s';

create or replace function public.assign_driver_tier(p_driver uuid)
returns numeric
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_share numeric(4,3);
  v_seq   integer;
  v_ride  record;
  v_split record;
  v_check numeric(8,2);
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

  -- Posição na fila: mesma derivação de 0065 (max+1 sob advisory lock). Não
  -- decide mais a faixa, só fica para auditoria.
  perform pg_advisory_xact_lock(hashtext('public.assign_driver_tier'));

  select coalesce(max(driver_onboarded_seq), 0) + 1
    into v_seq
    from public.profiles;

  -- 0089: faixa única. Plataforma fica com 20% de toda corrida.
  v_share := 0.800;

  perform set_config('app.profile_money_write', p_driver::text, true);
  update public.profiles
     set driver_onboarded_seq = v_seq,
         driver_share_percent = v_share
   where id = p_driver;
  perform set_config('app.profile_money_write', '', true);

  -- Reaplica a fatia às corridas dele ainda não repassadas (mesmo filtro e
  -- mesma válvula de 0065 — ver os comentários de lá). Com a faixa única isto
  -- só mexe em linha cujo split tenha sido gravado fora do padrão.
  for v_ride in
    select r.id, r.price, r.toll_amount, r.airport_port_fee,
           r.driver_amount, r.platform_fee
      from public.rides r
     where r.driver_id = p_driver
       and r.payout_id is null
       and r.paid
       and r.status in ('accepted', 'driver_en_route', 'in_progress', 'completed')
     order by r.id
     for update
  loop
    select * into v_split
      from public.compute_ride_split(v_ride.price, v_ride.toll_amount,
                                     v_ride.airport_port_fee, v_share);

    continue when v_split.o_driver_amount is not distinct from v_ride.driver_amount
              and v_split.o_platform_fee  is not distinct from v_ride.platform_fee;

    perform set_config('app.ride_money_write', v_ride.id::text, true);
    update public.rides
       set driver_amount = v_split.o_driver_amount,
           platform_fee  = v_split.o_platform_fee
     where id = v_ride.id;
    perform set_config('app.ride_money_write', '', true);

    select r.driver_amount into v_check from public.rides r where r.id = v_ride.id;
    if v_check is distinct from v_split.o_driver_amount then
      raise exception
        'assign_driver_tier: recálculo da corrida % foi revertido (esperado %, gravado %) — a válvula app.ride_money_write não está passando pelo trigger guard_ride_money_fields',
        v_ride.id, v_split.o_driver_amount, v_check
        using errcode = 'internal_error';
    end if;
  end loop;

  return v_share;
end;
$$;

comment on function public.assign_driver_tier(uuid) is
  'Atribui a fatia do motorista (0.800 para todos desde 0089 — plataforma 20%), uma única vez por motorista, e reaplica a fatia às corridas dele cobradas e ainda não repassadas. driver_onboarded_seq segue gravado para auditoria.';

revoke all on function public.assign_driver_tier(uuid) from public;
revoke all on function public.assign_driver_tier(uuid) from anon;
revoke all on function public.assign_driver_tier(uuid) from authenticated;
grant execute on function public.assign_driver_tier(uuid) to service_role;

-- Quem estava na faixa de lançamento desce para 80%.
update public.profiles
   set driver_share_percent = 0.800
 where driver_share_percent is distinct from 0.800
   and driver_share_percent is not null;

do $$
begin
  if exists (select 1 from public.profiles
              where driver_share_percent is not null
                and driver_share_percent <> 0.800) then
    raise exception '0089 incompleta: ainda há motorista com fatia diferente de 0.800 (o guarda de 0065 reverteu o UPDATE?)';
  end if;
end;
$$;
