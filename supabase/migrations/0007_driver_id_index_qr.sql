-- Índice para o filtro realtime driver_id=eq.{driverId}
-- Necessário para postgres_changes funcionar com filtro em driver_id
create index if not exists rides_driver_id_idx on public.rides (driver_id);

-- Garantir que driver_code também está indexado (usado no deep link QR)
create index if not exists profiles_driver_code_idx on public.profiles (driver_code);
