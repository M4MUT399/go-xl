-- ═════════════════════════════════════════════════════════════════════════════
-- 0093 — "tem motorista disponível perto deste embarque?"
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Medido em 01/11/2026: pedido imediato às 00:55, nenhum motorista em serviço, e
-- o passageiro ficou 34 min na tela de busca até a varredura cancelar. O app
-- passa a perguntar ANTES de criar a corrida e, sem motorista, oferece agendar.
--
-- A resposta usa a MESMA regra do leque do push (send-ride-push e
-- _shared/driverFreshness.ts): online, último fix em 12 h, até 50 milhas do
-- embarque. Motorista já em corrida não conta: para quem está na calçada, ele
-- não está disponível. O aviso não bloqueia nada — o passageiro pode pedir mesmo
-- assim, e quem decide a oferta continua sendo o send-ride-push.
--
-- POR QUE O CENTRO É ARREDONDADO. A posição do motorista é protegida desde a
-- 0069. Um "sim/não" com centro livre seria um oráculo: varrendo centros até a
-- resposta virar, dá para traçar a borda do círculo e achar o motorista. Por
-- isso o centro é arredondado para 0,1° (~11 km) e a chamada tem limite de taxa.
-- A folga de 8 km no raio cobre o deslocamento máximo do arredondamento: erra
-- para o lado de "tem motorista", nunca avisa "não tem" para quem está no raio.
-- ═════════════════════════════════════════════════════════════════════════════

set lock_timeout = '3s';

create or replace function public.driver_available_near(p_lat double precision, p_lng double precision)
returns boolean
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  c_radius_km constant double precision := 50 * 1.609344 + 8;
  v_uid    uuid := auth.uid();
  v_bucket text;
  v_lat    double precision;
  v_lng    double precision;
begin
  if v_uid is null then
    raise exception 'driver_available_near: sessão obrigatória' using errcode = '42501';
  end if;
  if p_lat is null or p_lng is null or abs(p_lat) > 85 or abs(p_lng) > 180 then
    raise exception 'driver_available_near: coordenada inválida' using errcode = '22023';
  end if;

  v_bucket := md5('goxl:available:' || v_uid::text);
  if not public.check_public_lookup_rate_limit(v_bucket, 'driver_available_near:short', 20, 60, 250000)
     or not public.check_public_lookup_rate_limit(v_bucket, 'driver_available_near:long', 120, 3600, 250000)
  then
    raise exception 'driver_available_near: rate limit excedido' using errcode = '53400';
  end if;

  v_lat := round(p_lat::numeric, 1)::double precision;
  v_lng := round(p_lng::numeric, 1)::double precision;

  return exists (
    select 1
      from public.driver_locations d
     where d.is_online
       and d.updated_at > now() - interval '12 hours'
       and d.lat is not null
       and d.lng is not null
       and 2 * 6371 * asin(least(1, sqrt(
             power(sin(radians(d.lat - v_lat) / 2), 2)
           + cos(radians(v_lat)) * cos(radians(d.lat))
           * power(sin(radians(d.lng - v_lng) / 2), 2)))) <= c_radius_km
       and not exists (
         select 1 from public.rides r
          where r.driver_id = d.driver_id
            and r.status in ('accepted', 'driver_en_route', 'in_progress')
       )
  );
end;
$$;

revoke all on function public.driver_available_near(double precision, double precision) from public, anon;
grant execute on function public.driver_available_near(double precision, double precision) to authenticated;

comment on function public.driver_available_near(double precision, double precision) is
  'Há motorista disponível (online, fix em 12 h, livre) a até 50 mi do embarque? Só sim/não, com centro arredondado e limite de taxa — ver o cabeçalho da 0093. Usado pelo aviso do RequestRideScreen.';
