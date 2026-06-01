-- Necessário para que os eventos realtime de UPDATE em driver_locations
-- incluam os valores de todas as colunas (lat, lng, heading, is_online)
-- em payload.new — sem isso apenas o driver_id chega no cliente.
alter table public.driver_locations replica identity full;

-- Índice auxiliar para o filtro realtime (caso venha a ser usado)
create index if not exists driver_locations_is_online_idx on public.driver_locations (is_online);
