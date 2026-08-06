-- Corridas agendadas: nova coluna scheduled_for e status 'scheduled'.
-- Rode no SQL Editor do Supabase se o banco já existir.
alter table public.rides add column if not exists scheduled_for timestamptz;

alter table public.rides drop constraint if exists rides_status_check;
alter table public.rides add constraint rides_status_check check (
  status in ('scheduled','requesting','accepted','driver_en_route','in_progress','completed','cancelled')
);
