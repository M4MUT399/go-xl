-- ═════════════════════════════════════════════════════════════════════════════
-- 0090 — posição ao vivo do passageiro até o embarque
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Pedido do Edson (26/10/2026), com print da Uber de referência: motorista e
-- passageiro se veem se mexendo no mapa até o embarque. O passageiro já via o
-- carro (driver_lat/lng, 0011); faltava o inverso.
--
-- O app do passageiro grava estas colunas na PRÓPRIA corrida enquanto ela está
-- em `accepted`/`driver_en_route` (src/hooks/usePassengerLocation.ts) e para no
-- embarque. Quem lê é só quem já lê a linha: a policy "Participante vê a
-- própria corrida" — o motorista DESTA corrida e o próprio passageiro. O pool
-- aberto ("Motorista vê o pool aberto") só enxerga `requesting`, e nessa fase o
-- app ainda não publica nada.
--
-- Escrita: a policy de UPDATE de rides já deixa o passageiro atualizar a
-- própria linha, e nenhum guarda (dinheiro, início de corrida) cobre estas
-- colunas. Aditiva e nula: build antiga simplesmente não grava.
-- ═════════════════════════════════════════════════════════════════════════════

set lock_timeout = '3s';

alter table public.rides
  add column if not exists passenger_lat          double precision,
  add column if not exists passenger_lng          double precision,
  add column if not exists passenger_location_at  timestamptz;

comment on column public.rides.passenger_location_at is
  'Instante em que o app do passageiro publicou passenger_lat/lng (só até o embarque). O motorista ignora posição com mais de 3 min.';
