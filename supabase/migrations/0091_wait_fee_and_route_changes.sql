-- ═════════════════════════════════════════════════════════════════════════════
-- 0091 — espera paga no embarque + mudança de rota em curso
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Pedido do Edson (29/10/2026):
--   • o motorista chega ao embarque e espera até 5 min de graça; dali em diante,
--     US$ 0,75 por minuto parado sem iniciar a corrida;
--   • o passageiro pode, com a corrida em andamento, trocar o destino ou incluir
--     paradas.
--
-- As duas coisas são DINHEIRO e nascem depois da cobrança (que acontece no
-- aceite, charge-ride). Por isso nenhuma delas é escrita pelo app:
--   • quem calcula e cobra a espera é a Edge Function `charge-wait-fee`, com o
--     relógio do servidor: driver_arrived_at (gravado aqui, por RPC) até
--     boarded_at (carimbado pelo trigger de 0039 quando vira in_progress);
--   • quem recalcula a tarifa e cobra/devolve a diferença da rota nova é a Edge
--     Function `update-ride-route`.
--
-- O GUARDA. A policy de UPDATE de rides deixa passageiro e motorista mexerem na
-- própria linha. Sem o trigger abaixo, o passageiro gravaria paradas/destino
-- sem pagar e o motorista anteciparia a própria chegada. Mesmo desenho de 0065:
-- cliente autenticado não escreve estas colunas; as RPCs passam por uma válvula
-- (GUC com o ID DA CORRIDA, não um booleano); service_role e SQL direto passam.
-- ═════════════════════════════════════════════════════════════════════════════

set lock_timeout = '3s';

alter table public.rides
  add column if not exists driver_arrived_at          timestamptz,
  add column if not exists wait_fee_minutes           integer,
  add column if not exists wait_fee_amount            numeric(8,2),
  add column if not exists wait_fee_payment_intent_id text,
  add column if not exists stops                      jsonb not null default '[]'::jsonb,
  add column if not exists route_change_count         integer not null default 0,
  add column if not exists fare_adjustment_amount     numeric(8,2) not null default 0;

comment on column public.rides.driver_arrived_at is
  'Quando o motorista tocou "Cheguei" no embarque (relógio do servidor, RPC mark_driver_arrived). Início da contagem da espera — 5 min grátis, depois US$ 0,75/min (src/lib/fare.ts waitFeeFor).';
comment on column public.rides.wait_fee_amount is
  'Taxa de espera cobrada à parte (charge-wait-fee). A fatia do motorista já está somada em driver_amount e a da plataforma em platform_fee.';
comment on column public.rides.stops is
  'Paradas intermediárias pedidas pelo passageiro: [{lat,lng,address,done_at}]. Escrito só por update-ride-route; done_at pela RPC mark_stop_done.';
comment on column public.rides.fare_adjustment_amount is
  'Soma das diferenças de tarifa por mudança de rota (positivo = cobrado a mais; negativo = devolvido). Já incluída em price.';

alter table public.rides
  drop constraint if exists rides_wait_fee_amount_range,
  add constraint rides_wait_fee_amount_range
    check (wait_fee_amount is null or (wait_fee_amount >= 0 and wait_fee_amount <= 100)),
  drop constraint if exists rides_stops_is_array,
  add constraint rides_stops_is_array
    check (jsonb_typeof(stops) = 'array' and jsonb_array_length(stops) <= 5);

-- A fatia do motorista sobre a espera entra em driver_amount (é o que o repasse
-- soma). O teto de 0065 (driver_amount <= price + gorjeta) passa a contar a
-- espera: numa corrida de US$ 15, 5 min de espera já estouravam o teto antigo.
alter table public.rides
  drop constraint if exists rides_driver_amount_sane,
  add constraint rides_driver_amount_sane
    check (driver_amount is null or (driver_amount >= 0 and driver_amount <=
      coalesce(price, 0) + coalesce(tip_amount, 0) + coalesce(wait_fee_amount, 0)));

-- ── Guarda ───────────────────────────────────────────────────────────────────
create or replace function public.guard_ride_route_fields()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_role    text := auth.role();
  v_allowed text;
begin
  if v_role is null or v_role = 'service_role' then
    return new;
  end if;

  v_allowed := current_setting('app.ride_route_write', true);
  if v_allowed is not null and v_allowed = new.id::text then
    return new;
  end if;

  new.driver_arrived_at          := old.driver_arrived_at;
  new.wait_fee_minutes           := old.wait_fee_minutes;
  new.wait_fee_amount            := old.wait_fee_amount;
  new.wait_fee_payment_intent_id := old.wait_fee_payment_intent_id;
  new.stops                      := old.stops;
  new.route_change_count         := old.route_change_count;
  new.fare_adjustment_amount     := old.fare_adjustment_amount;

  -- Destino: livre enquanto o pedido não tem motorista (o passageiro ainda está
  -- montando a corrida). Depois do aceite a tarifa já foi cobrada sobre ESTE
  -- destino — trocar só por update-ride-route, que recalcula e cobra.
  if old.status not in ('requesting', 'scheduled') then
    new.destination_lat     := old.destination_lat;
    new.destination_lng     := old.destination_lng;
    new.destination_address := old.destination_address;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_ride_route_fields on public.rides;
create trigger trg_guard_ride_route_fields
  before update on public.rides
  for each row execute function public.guard_ride_route_fields();

-- ── "Cheguei" ────────────────────────────────────────────────────────────────
-- Só o motorista DESTA corrida, antes do embarque, e uma vez só (o primeiro
-- toque vale; repetir devolve o mesmo instante). Proximidade: se a telemetria
-- dele for recente (< 3 min), ele precisa estar a até 100 m do embarque (Edson, 29/10/2026). É um
-- freio contra o toque antecipado por engano, não uma prova — o próprio
-- motorista publica driver_lat/lng.
create or replace function public.mark_driver_arrived(p_ride_id uuid)
returns timestamptz
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_ride record;
  v_dist_km double precision;
  v_at timestamptz;
begin
  select id, driver_id, status, driver_arrived_at, origin_lat, origin_lng,
         driver_lat, driver_lng, driver_telemetry_at
    into v_ride
    from public.rides
   where id = p_ride_id
   for update;

  if not found or v_ride.driver_id is distinct from auth.uid() then
    raise exception 'mark_driver_arrived: not the driver of ride %', p_ride_id
      using errcode = '42501';
  end if;
  if v_ride.status not in ('accepted', 'driver_en_route') then
    raise exception 'mark_driver_arrived: ride % is %', p_ride_id, v_ride.status
      using errcode = '22023';
  end if;
  if v_ride.driver_arrived_at is not null then
    return v_ride.driver_arrived_at;
  end if;

  if v_ride.driver_lat is not null and v_ride.driver_lng is not null
     and v_ride.origin_lat is not null and v_ride.origin_lng is not null
     and v_ride.driver_telemetry_at > now() - interval '3 minutes' then
    v_dist_km := 2 * 6371 * asin(least(1, sqrt(
        power(sin(radians(v_ride.origin_lat - v_ride.driver_lat) / 2), 2)
      + cos(radians(v_ride.driver_lat)) * cos(radians(v_ride.origin_lat))
      * power(sin(radians(v_ride.origin_lng - v_ride.driver_lng) / 2), 2))));
    if v_dist_km > 0.1 then
      raise exception 'mark_driver_arrived: driver is % km from pickup', round(v_dist_km::numeric, 2)
        using errcode = 'P0001', hint = 'too_far';
    end if;
  end if;

  v_at := now();
  perform set_config('app.ride_route_write', p_ride_id::text, true);
  update public.rides set driver_arrived_at = v_at where id = p_ride_id;
  perform set_config('app.ride_route_write', '', true);
  return v_at;
end;
$$;

revoke all on function public.mark_driver_arrived(uuid) from public, anon;
grant execute on function public.mark_driver_arrived(uuid) to authenticated;

-- ── Parada concluída ─────────────────────────────────────────────────────────
create or replace function public.mark_stop_done(p_ride_id uuid, p_index integer)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_ride record;
  v_stops jsonb;
begin
  select id, driver_id, status, stops into v_ride
    from public.rides where id = p_ride_id for update;

  if not found or v_ride.driver_id is distinct from auth.uid() then
    raise exception 'mark_stop_done: not the driver of ride %', p_ride_id using errcode = '42501';
  end if;
  if v_ride.status <> 'in_progress' then
    raise exception 'mark_stop_done: ride % is %', p_ride_id, v_ride.status using errcode = '22023';
  end if;
  if p_index < 0 or p_index >= jsonb_array_length(v_ride.stops) then
    raise exception 'mark_stop_done: no stop % in ride %', p_index, p_ride_id using errcode = '22023';
  end if;
  if (v_ride.stops -> p_index ->> 'done_at') is not null then
    return v_ride.stops;
  end if;

  v_stops := jsonb_set(v_ride.stops, array[p_index::text, 'done_at'], to_jsonb(now()));
  perform set_config('app.ride_route_write', p_ride_id::text, true);
  update public.rides set stops = v_stops where id = p_ride_id;
  perform set_config('app.ride_route_write', '', true);
  return v_stops;
end;
$$;

revoke all on function public.mark_stop_done(uuid, integer) from public, anon;
grant execute on function public.mark_stop_done(uuid, integer) to authenticated;

-- ── Ligar para a outra parte da corrida (29/10/2026) ─────────────────────────
-- O motorista precisa poder ligar para o passageiro para avisar que está
-- esperando (e o passageiro para o motorista). `profiles_public` não expõe
-- telefone, e não deve: o número só sai para quem é PARTE de uma corrida ATIVA
-- com o dono dele, enquanto ela está ativa.
create or replace function public.ride_contact_phone(p_ride_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_catalog
as $$
declare
  v_ride record;
  v_other uuid;
  v_phone text;
begin
  select passenger_id, driver_id, status into v_ride from public.rides where id = p_ride_id;
  if not found or v_ride.status not in ('accepted', 'driver_en_route', 'in_progress') then
    return null;
  end if;
  if auth.uid() = v_ride.driver_id then
    v_other := v_ride.passenger_id;
  elsif auth.uid() = v_ride.passenger_id then
    v_other := v_ride.driver_id;
  else
    raise exception 'ride_contact_phone: not a party to ride %', p_ride_id using errcode = '42501';
  end if;
  select nullif(trim(phone), '') into v_phone from public.profiles where id = v_other;
  return v_phone;
end;
$$;

revoke all on function public.ride_contact_phone(uuid) from public, anon;
grant execute on function public.ride_contact_phone(uuid) to authenticated;
