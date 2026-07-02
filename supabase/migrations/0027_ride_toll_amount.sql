-- P5: pedágio por corrida.
-- Coluna opcional em rides. NULL/0 = sem pedágio (comportamento atual). O valor
-- é preenchido no momento da solicitação/agendamento a partir do provider de
-- pedágio (ver src/lib/tolls.ts), somente quando a flag `tolls_enabled` estiver
-- ligada para a jurisdição.
alter table public.rides
  add column if not exists toll_amount numeric(8,2) default 0;
