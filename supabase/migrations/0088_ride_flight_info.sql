-- ═════════════════════════════════════════════════════════════════════════════
-- 0088 — voo e terminal da corrida para o aeroporto
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Regra de produto (20/10/2026): sempre que o destino for um aeroporto, o
-- passageiro TEM de informar o número do voo e o terminal antes de pedir ou
-- agendar. O app passa a exigir isso na RequestRideScreen (ver
-- src/lib/airportTrip.ts) e grava aqui, para o motorista ver na chamada, na
-- navegação e no card do agendamento.
--
-- ── COMPATIBILIDADE ────────────────────────────────────────────────────────
--
-- Aditiva e nula por padrão. O app só manda estas colunas quando a corrida é
-- para aeroporto (`flightColumns` em src/hooks/useRide.ts) — corrida comum não
-- toca nelas. MAS: build nova contra banco SEM esta migração faz o pedido para
-- aeroporto falhar no insert (coluna desconhecida). Aplicar ANTES de publicar.
--
-- A view rides_with_locations NÃO é recriada: nada no app nem nas Edge
-- Functions a consulta (ver 0072), e a 0086 seguiu o mesmo critério.
-- ═════════════════════════════════════════════════════════════════════════════

set lock_timeout = '3s';

alter table public.rides
  add column if not exists flight_number    text,
  add column if not exists airport_terminal text;

-- Tetos de tamanho: o valor vem do cliente e aparece na tela do motorista.
alter table public.rides
  drop constraint if exists rides_flight_number_len,
  add constraint rides_flight_number_len
    check (flight_number is null or char_length(flight_number) between 2 and 12);

alter table public.rides
  drop constraint if exists rides_airport_terminal_len,
  add constraint rides_airport_terminal_len
    check (airport_terminal is null or char_length(airport_terminal) between 1 and 60);

comment on column public.rides.flight_number is
  'Corrida para aeroporto: número do voo informado pelo passageiro, normalizado (ex.: AA1234). Nulo nas demais.';
comment on column public.rides.airport_terminal is
  'Corrida para aeroporto: terminal escolhido pelo passageiro (ex.: Terminal B). Nulo nas demais.';
