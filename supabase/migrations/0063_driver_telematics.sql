-- Telemetria de direção do motorista (estilo Uber / Cambridge Mobile Telematics).
--
-- Grava uma SESSÃO por corrida (do ACEITE ao ENCERRAMENTO) com a pontuação de
-- direção e a contagem de eventos de risco (excesso de velocidade, freada,
-- aceleração e curva bruscas). O motorista acompanha o próprio desempenho na
-- tela "Painel de direção" (Perfil → Meu desempenho). O compartilhamento é
-- automático e fica registrado APENAS no histórico do próprio motorista.
--
-- Retenção: 60 dias (política do produto) — um pg_cron limpa o que passar disso.
--
-- Privacidade/segurança: RLS estrito — cada motorista só lê/grava as PRÓPRIAS
-- linhas (driver_id = auth.uid()). Sem UPDATE/DELETE pelo cliente; a limpeza é
-- feita pelo cron (roda como owner, fora do RLS).

-- ─── Sessão por corrida ──────────────────────────────────────────────────────
create table if not exists public.driver_trip_sessions (
  id                uuid primary key default gen_random_uuid(),
  driver_id         uuid not null references public.profiles(id) on delete cascade,
  ride_id           uuid references public.rides(id) on delete set null,
  started_at        timestamptz not null default now(),
  ended_at          timestamptz,
  distance_km       double precision not null default 0,
  duration_min      double precision not null default 0,
  score             integer not null default 100 check (score between 0 and 100),
  speeding_count    integer not null default 0,
  hard_brake_count  integer not null default 0,
  hard_accel_count  integer not null default 0,
  hard_corner_count integer not null default 0,
  sample_count      integer not null default 0,
  created_at        timestamptz not null default now()
);

-- Uma sessão por corrida (idempotência do fecho: upsert por ride_id).
create unique index if not exists driver_trip_sessions_ride_uidx
  on public.driver_trip_sessions (ride_id)
  where ride_id is not null;

-- Consulta principal: últimas N sessões do motorista.
create index if not exists driver_trip_sessions_driver_time_idx
  on public.driver_trip_sessions (driver_id, ended_at desc nulls last);

-- ─── Eventos de risco (granularidade fina, opcional para o mapa/detalhe) ──────
create table if not exists public.driver_telematics_events (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references public.driver_trip_sessions(id) on delete cascade,
  driver_id   uuid not null references public.profiles(id) on delete cascade,
  type        text not null check (type in ('speeding','hard_brake','hard_accel','hard_corner')),
  severity    text not null default 'normal' check (severity in ('normal','severe')),
  at_ms       bigint not null,
  lat         double precision,
  lng         double precision,
  speed_kmh   double precision,
  created_at  timestamptz not null default now()
);

create index if not exists driver_telematics_events_session_idx
  on public.driver_telematics_events (session_id);
create index if not exists driver_telematics_events_driver_time_idx
  on public.driver_telematics_events (driver_id, created_at desc);

-- ─── RLS: cada motorista só enxerga o próprio histórico ───────────────────────
alter table public.driver_trip_sessions enable row level security;
alter table public.driver_telematics_events enable row level security;

drop policy if exists driver_trip_sessions_select_own on public.driver_trip_sessions;
create policy driver_trip_sessions_select_own
  on public.driver_trip_sessions for select
  using (driver_id = auth.uid());

drop policy if exists driver_trip_sessions_insert_own on public.driver_trip_sessions;
create policy driver_trip_sessions_insert_own
  on public.driver_trip_sessions for insert
  with check (driver_id = auth.uid());

-- Permite o fecho idempotente (upsert por ride_id) atualizar a PRÓPRIA sessão.
drop policy if exists driver_trip_sessions_update_own on public.driver_trip_sessions;
create policy driver_trip_sessions_update_own
  on public.driver_trip_sessions for update
  using (driver_id = auth.uid())
  with check (driver_id = auth.uid());

drop policy if exists driver_telematics_events_select_own on public.driver_telematics_events;
create policy driver_telematics_events_select_own
  on public.driver_telematics_events for select
  using (driver_id = auth.uid());

drop policy if exists driver_telematics_events_insert_own on public.driver_telematics_events;
create policy driver_telematics_events_insert_own
  on public.driver_telematics_events for insert
  with check (driver_id = auth.uid());

-- ─── Retenção de 60 dias ──────────────────────────────────────────────────────
-- Mesmo mecanismo de 0052_audit_log_retention.sql: DELETE por data via pg_cron
-- (sem lógica de negócio → não precisa de Edge Function). Eventos caem em
-- cascata pelo fecho da sessão, mas limpamos os dois por segurança.
create extension if not exists pg_cron;

select cron.unschedule('purge-old-telematics')
where exists (select 1 from cron.job where jobname = 'purge-old-telematics');

select cron.schedule(
  'purge-old-telematics',
  '15 6 * * *',  -- 06:15 UTC diariamente, fora do horário de pico do app
  $$
    delete from public.driver_telematics_events where created_at < now() - interval '60 days';
    delete from public.driver_trip_sessions   where created_at < now() - interval '60 days';
  $$
);
