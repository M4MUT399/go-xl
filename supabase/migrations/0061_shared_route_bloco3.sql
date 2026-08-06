-- Bloco 3 (paridade Uber): ROTA ÚNICA no servidor.
-- O servidor (Edge Function compute-route, proxy do OSRM) passa a ser a ÚNICA
-- fonte da rota. Guarda a geometria como polyline codificada (Google encoded
-- polyline, precisão 5 — compacta), um contador de versão monotônico e um ETA
-- único. Motorista E passageiro leem estas colunas → veem exatamente a mesma
-- rota/ETA. Em reroute o servidor recomputa e INCREMENTA route_version.
--
-- Reaproveita as colunas de destino já existentes (destination_lat/lng) e o
-- realtime já publicado na tabela rides (schema.sql) — nenhuma tabela nova.
alter table public.rides
  add column if not exists route_polyline text,
  add column if not exists route_version integer not null default 0,
  add column if not exists route_eta_min integer,
  add column if not exists route_distance_km double precision,
  add column if not exists route_updated_at timestamptz;

comment on column public.rides.route_polyline is
  'Bloco 3: geometria da rota única (Google encoded polyline, precisão 5) calculada pelo servidor.';
comment on column public.rides.route_version is
  'Bloco 3: contador monotônico da rota; incrementado a cada recálculo (reroute) no servidor.';
comment on column public.rides.route_eta_min is
  'Bloco 3: ETA único (min) da rota do servidor — mesma fonte para motorista e passageiro.';
comment on column public.rides.route_distance_km is
  'Bloco 3: distância (km) da rota do servidor.';
comment on column public.rides.route_updated_at is
  'Bloco 3: quando a rota foi recomputada pela última vez.';

-- RPC atômico: grava a rota nova e INCREMENTA route_version numa só instrução
-- (route_version = route_version + 1), evitando corrida de leitura-escrita. Só a
-- Edge Function (service_role) chama; devolve a nova versão. SECURITY DEFINER
-- para rodar com privilégio da função independentemente do RLS do chamador.
create or replace function public.commit_ride_route(
  p_ride_id uuid,
  p_polyline text,
  p_eta_min integer,
  p_distance_km double precision
) returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_new_version integer;
begin
  update public.rides
     set route_polyline    = p_polyline,
         route_version     = route_version + 1,
         route_eta_min     = p_eta_min,
         route_distance_km = p_distance_km,
         route_updated_at  = now()
   where id = p_ride_id
   returning route_version into v_new_version;
  return v_new_version; -- null se a corrida não existir
end;
$$;

revoke all on function public.commit_ride_route(uuid, text, integer, double precision) from public, anon, authenticated;
