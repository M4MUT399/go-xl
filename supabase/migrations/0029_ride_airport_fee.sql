-- P6: taxa regulatória de aeroporto/porto por corrida.
-- Coluna opcional em rides. NULL/0 = sem taxa (comportamento atual). O valor é
-- preenchido no momento da solicitação/agendamento quando a origem/destino cai
-- em um geofence configurado (ver src/lib/airportFees.ts). Recolhida pela
-- plataforma para repasse à autoridade do aeroporto/porto.
alter table public.rides
  add column if not exists airport_port_fee numeric(8,2) default 0;
