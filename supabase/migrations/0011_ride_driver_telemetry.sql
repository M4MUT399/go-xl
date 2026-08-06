-- Telemetria do motorista gravada na própria corrida, para o passageiro ver
-- a posição e o ETA (tempo/distância) idênticos aos do motorista, sem depender
-- da leitura de driver_locations (que pode ser bloqueada por RLS/realtime).
alter table public.rides
  add column if not exists driver_lat double precision,
  add column if not exists driver_lng double precision,
  add column if not exists driver_eta_min integer,
  add column if not exists driver_eta_km double precision;
