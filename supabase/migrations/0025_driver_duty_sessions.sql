-- driver_duty_sessions — janelas de tempo "em serviço" do motorista (P3).
--
-- Fonte da verdade para o limite de direção configurável (ex.: 12h de direção
-- seguidas exigem 6h de descanso). Cada linha é uma sessão: abre quando o
-- motorista fica online e fecha (ended_at) quando fica offline. O cálculo de
-- horas acumuladas e da necessidade de descanso é feito no app a partir destas
-- sessões (ver src/lib/drivingLimits.ts) — sobrecontar em sessão aberta (app
-- morto online) só antecipa o descanso, que é o lado seguro para compliance.
create table if not exists public.driver_duty_sessions (
  id         uuid        primary key default gen_random_uuid(),
  driver_id  uuid        not null references public.profiles(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at   timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists driver_duty_sessions_driver_idx
  on public.driver_duty_sessions (driver_id, started_at desc);

-- Índice parcial para achar rápido a sessão aberta de um motorista.
create index if not exists driver_duty_sessions_open_idx
  on public.driver_duty_sessions (driver_id)
  where ended_at is null;

alter table public.driver_duty_sessions enable row level security;

-- Inserção: o motorista só abre sessão em nome de si mesmo.
drop policy if exists driver_duty_sessions_insert_own on public.driver_duty_sessions;
create policy driver_duty_sessions_insert_own
  on public.driver_duty_sessions for insert
  to authenticated
  with check (auth.uid() = driver_id);

-- Atualização: o motorista fecha (ended_at) apenas as próprias sessões.
drop policy if exists driver_duty_sessions_update_own on public.driver_duty_sessions;
create policy driver_duty_sessions_update_own
  on public.driver_duty_sessions for update
  to authenticated
  using (auth.uid() = driver_id)
  with check (auth.uid() = driver_id);

-- Leitura: o próprio motorista lê suas sessões; admins leem todas.
drop policy if exists driver_duty_sessions_select_own_or_admin on public.driver_duty_sessions;
create policy driver_duty_sessions_select_own_or_admin
  on public.driver_duty_sessions for select
  to authenticated
  using (
    auth.uid() = driver_id
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_admin = true
    )
  );

-- Acesso administrativo completo via service_role (Edge Functions/admin).
drop policy if exists driver_duty_sessions_service_all on public.driver_duty_sessions;
create policy driver_duty_sessions_service_all
  on public.driver_duty_sessions for all
  to service_role
  using (true)
  with check (true);
