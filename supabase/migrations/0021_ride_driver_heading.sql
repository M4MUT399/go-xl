-- Sentido (heading, em graus, 0-360) do motorista, gravado junto com a
-- telemetria de posição da corrida — permite ao passageiro ver a seta de
-- direção do veículo no mapa, não só a posição.
alter table public.rides
  add column if not exists driver_heading double precision;
