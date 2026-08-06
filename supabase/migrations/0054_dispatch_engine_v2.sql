-- Dispatch Engine v2 (PR-b) — SERVIDOR como fonte da verdade da distribuição de
-- corridas estilo Uber. Introduz duas tabelas + um log de auditoria + uma RPC de
-- aceite ATÔMICO. NÃO altera o fluxo legado: a tabela `rides` continua sendo a
-- entidade de tarifa/pagamento; estas tabelas modelam a MÁQUINA DE DISTRIBUIÇÃO
-- em torno dela. Enquanto a flag `dispatch_engine_v2` estiver OFF, nada escreve
-- aqui — a migração é inerte até o rollout.
--
-- Espelha a lógica pura de src/lib/dispatchEngine.ts:
--   trip_requests  = uma máquina de estados por pedido (REQUESTED→…→ACCEPTED).
--   ride_offers    = uma oferta (trip_request × motorista); trava "1 oferta
--                    pendente por motorista" e fonte para reconstrução do card
--                    quando o app do motorista reabre (critério 5).
--   dispatch_events = trilha imutável (append-only) com trip_request_id +
--                    driver_id + timestamp de cada transição (critério de
--                    observabilidade).
--
-- RLS segue o padrão de ride_offer_events/duty_movement_events (0023/0053).

-- ─── trip_requests ───────────────────────────────────────────────────────────
create table if not exists public.trip_requests (
  id                  uuid        primary key default gen_random_uuid(),
  ride_id             uuid        references public.rides(id) on delete cascade,
  passenger_id        uuid        not null references public.profiles(id) on delete cascade,

  pickup_lat          double precision not null,
  pickup_lng          double precision not null,
  destination_lat     double precision,
  destination_lng     double precision,
  destination_address text,

  -- REQUESTED | MATCHING | OFFERING | ACCEPTED | ONGOING | CANCELLED | NO_DRIVERS
  status              text        not null default 'REQUESTED',
  -- sequential (padrão) | broadcast
  dispatch_mode       text        not null default 'sequential',
  radius_km           numeric     not null default 3,

  -- Vencedor do aceite atômico (null enquanto não aceito).
  accepted_by         uuid        references public.profiles(id),

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  constraint trip_requests_status_chk check (status in
    ('REQUESTED','MATCHING','OFFERING','ACCEPTED','ONGOING','CANCELLED','NO_DRIVERS')),
  constraint trip_requests_mode_chk check (dispatch_mode in ('sequential','broadcast'))
);

create index if not exists trip_requests_status_idx
  on public.trip_requests (status, created_at);
create index if not exists trip_requests_passenger_idx
  on public.trip_requests (passenger_id, created_at desc);
create index if not exists trip_requests_ride_idx
  on public.trip_requests (ride_id);

-- ─── ride_offers ─────────────────────────────────────────────────────────────
create table if not exists public.ride_offers (
  id               uuid        primary key default gen_random_uuid(),
  trip_request_id  uuid        not null references public.trip_requests(id) on delete cascade,
  driver_id        uuid        not null references public.profiles(id) on delete cascade,

  -- PENDING | ACCEPTED | REJECTED | EXPIRED | REVOKED
  status           text        not null default 'PENDING',
  eta_min          numeric,
  distance_km      numeric,

  offered_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  resolved_at      timestamptz,

  constraint ride_offers_status_chk check (status in
    ('PENDING','ACCEPTED','REJECTED','EXPIRED','REVOKED'))
);

-- Uma oferta por (pedido, motorista): reenvio/push duplicado não duplica card.
create unique index if not exists ride_offers_unique_pair
  on public.ride_offers (trip_request_id, driver_id);

-- TRAVA "um motorista = no máximo UMA oferta PENDENTE" — impede o motor de
-- oferecer dois pedidos ao mesmo motorista (invariante testada no núcleo puro).
create unique index if not exists ride_offers_one_pending_per_driver
  on public.ride_offers (driver_id)
  where status = 'PENDING';

-- No máximo UM vencedor por pedido (aceite único).
create unique index if not exists ride_offers_one_accepted_per_trip
  on public.ride_offers (trip_request_id)
  where status = 'ACCEPTED';

create index if not exists ride_offers_driver_pending_idx
  on public.ride_offers (driver_id, status);
create index if not exists ride_offers_trip_idx
  on public.ride_offers (trip_request_id, status);

-- ─── dispatch_events (append-only) ───────────────────────────────────────────
create table if not exists public.dispatch_events (
  id               uuid        primary key default gen_random_uuid(),
  trip_request_id  uuid        not null references public.trip_requests(id) on delete cascade,
  driver_id        uuid        references public.profiles(id) on delete set null,
  -- REQUESTED|MATCHING|OFFERED|ACCEPTED|REJECTED|EXPIRED|REVOKED|NO_DRIVERS|REDISPATCH|CANCELLED
  event            text        not null,
  meta             jsonb       not null default '{}'::jsonb,
  at               timestamptz not null default now()
);

create index if not exists dispatch_events_trip_idx
  on public.dispatch_events (trip_request_id, at);
create index if not exists dispatch_events_driver_idx
  on public.dispatch_events (driver_id, at desc);

-- ─── updated_at automático em trip_requests ──────────────────────────────────
create or replace function public.touch_trip_requests_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_trip_requests on public.trip_requests;
create trigger trg_touch_trip_requests
  before update on public.trip_requests
  for each row execute function public.touch_trip_requests_updated_at();

-- ─── RPC: aceite ATÔMICO (compare-and-set) ───────────────────────────────────
-- Vence apenas se o pedido está em OFFERING, ainda sem accepted_by, e o
-- motorista tem uma oferta PENDING viva. O UPDATE condicional + o bloqueio de
-- linha do Postgres garantem UM único vencedor entre aceites simultâneos
-- (critério 3). Idempotente: reenvio do mesmo vencedor → 'ACCEPTED'. Perdedores
-- têm a oferta marcada REVOKED e ficam livres para o próximo pedido (critério 2).
-- SECURITY DEFINER: roda com privilégios do dono para poder revogar as ofertas
-- irmãs; valida explicitamente que o chamador é o próprio motorista.
create or replace function public.accept_trip_offer(
  p_trip_request_id uuid,
  p_driver_id       uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int;
  v_existing text;
begin
  if auth.uid() is not null and auth.uid() <> p_driver_id then
    raise exception 'não autorizado: só o próprio motorista pode aceitar'
      using errcode = 'insufficient_privilege';
  end if;

  -- Idempotência: se este motorista já venceu, reconfirma sem efeitos colaterais.
  select status into v_existing
    from public.ride_offers
   where trip_request_id = p_trip_request_id and driver_id = p_driver_id;
  if v_existing = 'ACCEPTED' then
    return 'ACCEPTED';
  end if;

  -- Compare-and-set atômico no pedido: só o primeiro casa a condição.
  update public.trip_requests
     set status = 'ACCEPTED', accepted_by = p_driver_id
   where id = p_trip_request_id
     and status = 'OFFERING'
     and accepted_by is null
     and exists (
       select 1 from public.ride_offers o
        where o.trip_request_id = p_trip_request_id
          and o.driver_id = p_driver_id
          and o.status = 'PENDING'
     );
  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    return 'TRIP_NO_LONGER_AVAILABLE';
  end if;

  -- Vencedor: marca a própria oferta.
  update public.ride_offers
     set status = 'ACCEPTED', resolved_at = now()
   where trip_request_id = p_trip_request_id and driver_id = p_driver_id;

  -- Perdedores (leque/broadcast): revoga as demais ofertas pendentes do pedido.
  update public.ride_offers
     set status = 'REVOKED', resolved_at = now()
   where trip_request_id = p_trip_request_id
     and driver_id <> p_driver_id
     and status = 'PENDING';

  insert into public.dispatch_events (trip_request_id, driver_id, event, meta)
  values (p_trip_request_id, p_driver_id, 'ACCEPTED', '{}'::jsonb);

  return 'ACCEPTED';
end;
$$;

revoke all on function public.accept_trip_offer(uuid, uuid) from public;
grant execute on function public.accept_trip_offer(uuid, uuid) to authenticated, service_role;

-- ─── RLS ─────────────────────────────────────────────────────────────────────
alter table public.trip_requests  enable row level security;
alter table public.ride_offers    enable row level security;
alter table public.dispatch_events enable row level security;

-- trip_requests: o passageiro dono lê o seu; o motorista com oferta lê os que o
-- envolvem; admin lê tudo; service_role acesso completo (Edge Function).
drop policy if exists trip_requests_select on public.trip_requests;
create policy trip_requests_select on public.trip_requests for select to authenticated
  using (
    auth.uid() = passenger_id
    or auth.uid() = accepted_by
    or exists (select 1 from public.ride_offers o
                where o.trip_request_id = id and o.driver_id = auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
  );

drop policy if exists trip_requests_service_all on public.trip_requests;
create policy trip_requests_service_all on public.trip_requests for all to service_role
  using (true) with check (true);

-- ride_offers: o motorista só lê/atualiza (recusa) as SUAS ofertas; admin lê;
-- service_role acesso completo. O aceite vencedor passa pela RPC (definer).
drop policy if exists ride_offers_select_own on public.ride_offers;
create policy ride_offers_select_own on public.ride_offers for select to authenticated
  using (
    auth.uid() = driver_id
    or exists (select 1 from public.trip_requests t
                where t.id = trip_request_id and t.passenger_id = auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
  );

-- Motorista pode marcar a PRÓPRIA oferta como REJECTED (recusa) — nunca ACEITAR
-- direto (isso só via RPC atômica), nem tocar em oferta de outro.
drop policy if exists ride_offers_reject_own on public.ride_offers;
create policy ride_offers_reject_own on public.ride_offers for update to authenticated
  using (auth.uid() = driver_id)
  with check (auth.uid() = driver_id and status in ('REJECTED'));

drop policy if exists ride_offers_service_all on public.ride_offers;
create policy ride_offers_service_all on public.ride_offers for all to service_role
  using (true) with check (true);

-- dispatch_events: leitura para envolvidos/admin; escrita só service_role/RPC.
drop policy if exists dispatch_events_select on public.dispatch_events;
create policy dispatch_events_select on public.dispatch_events for select to authenticated
  using (
    auth.uid() = driver_id
    or exists (select 1 from public.trip_requests t
                where t.id = trip_request_id and t.passenger_id = auth.uid())
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
  );

drop policy if exists dispatch_events_service_all on public.dispatch_events;
create policy dispatch_events_service_all on public.dispatch_events for all to service_role
  using (true) with check (true);
