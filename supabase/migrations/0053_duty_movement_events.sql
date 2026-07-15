-- driver_duty_movement_events — trilha de AUDITORIA das transições da máquina de
-- estados da "jornada por movimento" (Bloco 2). Cada linha é uma transição
-- (MOVING→STOPPED_TOLERANCE, →PAUSED, reset, resume, gps_lost, etc.) decidida no
-- app do motorista a partir de timestamps epoch UTC persistidos.
--
-- Por quê persistir no backend: o acumulador roda no cliente (sobrevive a
-- kill/reboot via AsyncStorage), mas a fiscalização/compliance exige uma trilha
-- imutável no servidor de QUANDO cada mudança de estado ocorreu. O app só INSERE
-- (append-only); nunca atualiza/apaga.
--
-- RLS segue o padrão de ride_offer_events/waybills (0023/0047): o motorista só
-- insere/lê os próprios eventos; admin lê tudo; service_role acesso completo.
create table if not exists public.driver_duty_movement_events (
  id            uuid        primary key default gen_random_uuid(),
  driver_id     uuid        not null references public.profiles(id) on delete cascade,

  -- Transição de estado (ver DutyTransition em src/lib/dutyMovement.ts).
  from_state    text        not null,
  to_state      text        not null,
  reason        text        not null,

  -- Epoch (ms, UTC) do sample que causou a transição — fonte de verdade do
  -- cálculo, independente do relógio/fuso do dispositivo no momento do insert.
  at_ms         bigint      not null,

  -- Minutos de trabalho acumulados no instante da transição (para conciliação).
  worked_minutes numeric,

  created_at    timestamptz not null default now()
);

create index if not exists duty_movement_events_driver_idx
  on public.driver_duty_movement_events (driver_id, at_ms desc);
create index if not exists duty_movement_events_created_idx
  on public.driver_duty_movement_events (created_at desc);

alter table public.driver_duty_movement_events enable row level security;

-- Inserção: o motorista só registra os próprios eventos (emitidos pelo app dele).
drop policy if exists duty_movement_events_insert_own on public.driver_duty_movement_events;
create policy duty_movement_events_insert_own
  on public.driver_duty_movement_events for insert
  to authenticated
  with check (auth.uid() = driver_id);

-- Leitura: o próprio motorista lê os seus; admins leem todos.
drop policy if exists duty_movement_events_select_own_or_admin on public.driver_duty_movement_events;
create policy duty_movement_events_select_own_or_admin
  on public.driver_duty_movement_events for select
  to authenticated
  using (
    auth.uid() = driver_id
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_admin = true
    )
  );

-- Acesso administrativo completo via service_role (Edge Functions/admin/retenção).
drop policy if exists duty_movement_events_service_all on public.driver_duty_movement_events;
create policy duty_movement_events_service_all
  on public.driver_duty_movement_events for all
  to service_role
  using (true)
  with check (true);
