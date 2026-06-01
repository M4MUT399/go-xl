-- A view rides_with_locations foi definida com `select r.*`. O Postgres expande
-- esse `*` para a lista de colunas EXISTENTES no momento da criação da view, e
-- NÃO acompanha colunas adicionadas depois. Como a migration 0011 adicionou
-- driver_lat / driver_lng / driver_eta_min / driver_eta_km DEPOIS, a view não
-- as expõe. Recriar a view re-expande o `r.*` e passa a incluir as colunas novas.
create or replace view public.rides_with_locations as
select
  r.*,
  json_build_object('lat', r.origin_lat, 'lng', r.origin_lng, 'address', r.origin_address) as origin,
  json_build_object('lat', r.destination_lat, 'lng', r.destination_lng, 'address', r.destination_address) as destination
from public.rides r;
