-- ride_offer_events — trilha de auditoria de cada chamada de corrida enviada a
-- um motorista (P1). Registra o ciclo de vida da oferta: recebida, aceita,
-- recusada, expirada, falha, ou "levada por outro motorista". Serve para:
--   • suporte/compliance ("o motorista recebeu a chamada?"),
--   • métricas de aceite/recusa/tempo de resposta,
--   • investigar corridas perdidas.
--
-- No modelo atual o dispatch é client-driven: o app do motorista registra os
-- eventos que observa. As policies garantem que um motorista só escreve/le os
-- próprios eventos; admin e Edge Functions (service_role) enxergam tudo.
create table if not exists public.ride_offer_events (
  id         uuid        primary key default gen_random_uuid(),
  ride_id    uuid        not null references public.rides(id) on delete cascade,
  driver_id  uuid        not null references public.profiles(id) on delete cascade,
  event      text        not null,
  reason     text,
  metadata   jsonb,
  created_at timestamptz not null default now(),
  constraint ride_offer_events_event_check
    check (event in ('received', 'accepted', 'rejected', 'expired', 'failed', 'taken_by_other'))
);

create index if not exists ride_offer_events_ride_idx   on public.ride_offer_events (ride_id);
create index if not exists ride_offer_events_driver_idx on public.ride_offer_events (driver_id, created_at desc);

alter table public.ride_offer_events enable row level security;

-- Inserção: o motorista só pode registrar eventos em nome de si mesmo.
drop policy if exists ride_offer_events_insert_own on public.ride_offer_events;
create policy ride_offer_events_insert_own
  on public.ride_offer_events for insert
  to authenticated
  with check (auth.uid() = driver_id);

-- Leitura: o próprio motorista lê seus eventos; admins leem todos.
drop policy if exists ride_offer_events_select_own_or_admin on public.ride_offer_events;
create policy ride_offer_events_select_own_or_admin
  on public.ride_offer_events for select
  to authenticated
  using (
    auth.uid() = driver_id
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_admin = true
    )
  );

-- Escrita administrativa completa via service_role (Edge Functions/admin).
drop policy if exists ride_offer_events_service_all on public.ride_offer_events;
create policy ride_offer_events_service_all
  on public.ride_offer_events for all
  to service_role
  using (true)
  with check (true);
