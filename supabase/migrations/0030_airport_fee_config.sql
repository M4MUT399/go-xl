-- Seed de configuração das taxas de aeroporto/porto (P6). Idempotente.
--
-- Valor: LISTA (jsonb) de zonas de geofence. Semeado VAZIO no 'global' → nenhuma
-- taxa é cobrada e o preço não muda até o admin configurar. A configuração é por
-- jurisdição (ex.: jurisdiction='US-FL' sobrescreve a 'global').
--
-- Formato de cada zona (ver src/lib/airportFees.ts):
--   {
--     "id": "mco",                 -- slug estável
--     "name": "Orlando Intl (MCO)",
--     "lat": 28.4312, "lng": -81.3081,
--     "radiusKm": 3,               -- raio do geofence
--     "pickupFee": 0,              -- USD quando a ORIGEM está dentro
--     "dropoffFee": 0              -- USD quando o DESTINO está dentro
--   }
--
-- IMPORTANTE: os valores de taxa NÃO são embutidos aqui de propósito — devem ser
-- definidos pelo admin conforme a regulação vigente de cada aeroporto/porto.
insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'airport_port_fees',
  'global',
  '[]'::jsonb,
  'Lista de geofences (aeroporto/porto) e suas taxas de pickup/dropoff, por jurisdição.',
  true
)
on conflict (key, jurisdiction) do nothing;
