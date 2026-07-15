-- Bloco 1 (compliance F.S. 627.748) — persistência da máquina de períodos
-- P0-P3 (src/lib/driverPeriodMachine.ts) + acumulador de milhagem por período
-- (src/lib/driverPeriodMileage.ts). Companion direto desses dois módulos
-- puros; ver o cabeçalho de cada um para a lógica de negócio completa.
--
-- Esta migração faz três coisas:
--
--   1) Fecha uma lacuna de compliance pré-existente: `rides.accepted_at` e
--      `rides.completed_at` hoje são carimbados pelo RELÓGIO DO CLIENTE
--      (`new Date().toISOString()` em src/hooks/useRide.ts). A lei exige que
--      as fronteiras de período usem o horário do SERVIDOR. Acrescenta
--      `rides.boarded_at` (marco P2→P3, hoje inexistente) e um trigger que
--      SEMPRE sobrescreve os três timestamps com `now()` do Postgres na
--      primeira transição para o status correspondente — o valor que o
--      cliente mandar é ignorado. Auditoria feita antes de escrever esta
--      migração (ver changelog do Bloco 1) confirmou que todo call site já
--      relê a linha via `.select()`/`.select().single()` na mesma operação
--      OU numa query de acompanhamento — nenhum código usa o valor
--      client-side sem reler; a mudança é transparente para a UI existente.
--
--   2) Mesma lacuna em `driver_locations`: acrescenta `is_online_changed_at`,
--      carimbado só quando `is_online` de fato muda (não a cada ping de GPS,
--      que reescreve a linha a cada ~5s enquanto online). É o timestamp que
--      a camada de wiring (próxima etapa do Bloco 1, ainda não escrita) usará
--      como fonte dos eventos WENT_ONLINE/WENT_OFFLINE da máquina de período.
--
--   3) Cria as duas tabelas novas do Bloco 1:
--        driver_period_transitions — trilha IMUTÁVEL (append-only de
--          verdade: UPDATE/DELETE são REJEITADOS pelo banco, sem exceção,
--          nem para service_role — corrigir um registro errado exige um
--          evento compensatório novo, nunca reescrever o antigo; ver nota de
--          retenção/partição abaixo). Uma linha por transição de período,
--          com driver_id, trip_id, from/to, motivo, timestamp epoch (fonte
--          de verdade — igual ao padrão de driver_duty_movement_events),
--          coordenada GPS do evento, e uma leitura de "odômetro" — como este
--          app não tem integração com o hardware do veículo (sem OBD-II),
--          interpretamos "odômetro" do comando como a milhagem ACUMULADA por
--          GPS na sessão de tracking até aquele instante (calculada pelo
--          acumulador puro de driverPeriodMileage.ts). Documentando essa
--          interpretação aqui para review — é a leitura mais direta possível
--          do requisito dado que não existe sensor físico de odômetro.
--        driver_period_daily_mileage — rollup MUTÁVEL (não passa pelo
--          trigger de imutabilidade) por motorista/dia, com os buckets
--          p1/p2/p3 + estimatedMiles espelhando exatamente
--          DriverPeriodMileage de driverPeriodMileage.ts. É o que os
--          relatórios/exports do Bloco 2 vão consultar em vez de somar a
--          trilha de transições inteira a cada leitura.
--
--   Nota de retenção (Bloco 2, não resolvido aqui): "append-only" +
--   "retenção configurável de 5 anos" parecem tensionar — a resposta correta
--   não é permitir DELETE nesta tabela (quebraria a garantia de imutabilidade
--   que o comando pede), e sim particionar driver_period_transitions por mês
--   /ano mais adiante e DROPar partições inteiras vencidas. Fica registrado
--   como trabalho futuro do Bloco 2; esta migração não particiona ainda.
--
-- Feature flag: `period_tracking_v1_enabled` (system_config, seed abaixo,
-- default false/global). Enquanto OFF, nada escreve nas tabelas novas — os
-- triggers de rides/driver_locations são inertes por natureza (só carimbam
-- timestamp, não mudam comportamento visível) e podem ficar ativos desde já
-- sem esperar o rollout da flag.

-- ─── 1) Timestamps server-side em rides ─────────────────────────────────────

alter table public.rides
  add column if not exists boarded_at timestamptz;

-- `cancelled_at` não existia antes desta migração — sem ele o wiring da
-- máquina de período (useDriverPeriodTracker, próxima etapa) não teria de
-- onde tirar um timestamp de SERVIDOR para o evento TRIP_CANCELLED (só
-- restaria o relógio do cliente, voltando à mesma lacuna de compliance que
-- esta migração existe para fechar).
alter table public.rides
  add column if not exists cancelled_at timestamptz;

create or replace function public.stamp_ride_period_timestamps()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Carimba SEMPRE com o relógio do servidor, ignorando qualquer valor que o
  -- cliente tenha mandado no mesmo UPDATE. Só na primeira vez (coluna ainda
  -- nula) — evita reescrever um marco já registrado num UPDATE posterior não
  -- relacionado à mesma linha (ex.: pagamento marcado depois de completed).
  if new.status = 'accepted' and old.accepted_at is null then
    new.accepted_at := now();
  end if;

  if new.status = 'in_progress' and old.boarded_at is null then
    new.boarded_at := now();
  end if;

  if new.status = 'completed' and old.completed_at is null then
    new.completed_at := now();
  end if;

  if new.status = 'cancelled' and old.cancelled_at is null then
    new.cancelled_at := now();
  end if;

  return new;
end;
$$;

drop trigger if exists trg_stamp_ride_period_timestamps on public.rides;
create trigger trg_stamp_ride_period_timestamps
  before update on public.rides
  for each row execute function public.stamp_ride_period_timestamps();

-- ─── 2) is_online_changed_at em driver_locations ────────────────────────────

alter table public.driver_locations
  add column if not exists is_online_changed_at timestamptz;

create or replace function public.stamp_driver_online_changed_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    new.is_online_changed_at := now();
  elsif new.is_online is distinct from old.is_online then
    new.is_online_changed_at := now();
  else
    -- Sem mudança de is_online (ex.: só lat/lng do ping de GPS) — preserva o
    -- valor existente independente do que o payload do upsert incluiu.
    new.is_online_changed_at := old.is_online_changed_at;
  end if;
  return new;
end;
$$;

-- Nome escolhido para ordenar DEPOIS de trg_driver_online_gating (0038) na
-- execução alfabética de triggers do mesmo evento/timing — precisa observar
-- o valor de is_online já coagido pelo gate de Stripe Connect, não o bruto.
drop trigger if exists trg_driver_online_stamp_changed_at on public.driver_locations;
create trigger trg_driver_online_stamp_changed_at
  before insert or update on public.driver_locations
  for each row execute function public.stamp_driver_online_changed_at();

-- ─── 3a) driver_period_transitions (append-only, imutável de verdade) ──────

create table if not exists public.driver_period_transitions (
  id                          uuid        primary key default gen_random_uuid(),
  driver_id                   uuid        not null references public.profiles(id) on delete cascade,
  trip_id                     uuid        references public.rides(id) on delete set null,

  from_period                 text        not null check (from_period in ('P0_OFFLINE','P1_AVAILABLE','P2_ENROUTE','P3_ONTRIP')),
  to_period                   text        not null check (to_period   in ('P0_OFFLINE','P1_AVAILABLE','P2_ENROUTE','P3_ONTRIP')),
  -- went_online | went_offline | accepted | boarded | completed | cancelled | chained
  reason                      text        not null,

  -- Epoch (ms, UTC) do evento de SERVIDOR que causou a transição — fonte de
  -- verdade, independente de quando o insert físico chegou ao banco (mesmo
  -- princípio de driver_duty_movement_events / driverPeriodMachine.ts).
  at_ms                       bigint      not null,

  lat                         double precision,
  lng                         double precision,

  -- "Odômetro" (ver nota no cabeçalho): milhagem acumulada por GPS na sessão
  -- de tracking até este instante. Null quando a camada de wiring ainda não
  -- tinha leitura de GPS suficiente para calcular (ex.: primeiro WENT_ONLINE
  -- do dia, antes de qualquer ping).
  cumulative_miles_at_transition numeric,

  -- Proveniência: mesma marcação de driverPeriodMileage.ts — true quando a
  -- milhagem acumulada acima inclui algum trecho estimado por interpolação
  -- de rota (perda de sinal), não só medição direta por GPS.
  mileage_estimated           boolean     not null default false,

  created_at                  timestamptz not null default now()
);

create index if not exists driver_period_transitions_driver_idx
  on public.driver_period_transitions (driver_id, at_ms desc);
create index if not exists driver_period_transitions_trip_idx
  on public.driver_period_transitions (trip_id);
create index if not exists driver_period_transitions_created_idx
  on public.driver_period_transitions (created_at desc);

-- Índice de apoio à consulta de "claims lookup" do Bloco 2 (critério de
-- aceite: driver_id + janela de timestamp → login/logout ±12h + período
-- ativo, resposta em <5s).
create index if not exists driver_period_transitions_claims_lookup_idx
  on public.driver_period_transitions (driver_id, at_ms);

alter table public.driver_period_transitions enable row level security;

drop policy if exists driver_period_transitions_insert_own on public.driver_period_transitions;
create policy driver_period_transitions_insert_own
  on public.driver_period_transitions for insert
  to authenticated
  with check (auth.uid() = driver_id);

drop policy if exists driver_period_transitions_select_own_or_admin on public.driver_period_transitions;
create policy driver_period_transitions_select_own_or_admin
  on public.driver_period_transitions for select
  to authenticated
  using (
    auth.uid() = driver_id
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_admin = true
    )
  );

drop policy if exists driver_period_transitions_service_all on public.driver_period_transitions;
create policy driver_period_transitions_service_all
  on public.driver_period_transitions for all
  to service_role
  using (true)
  with check (true);

-- IMUTABILIDADE DURA: nenhuma linha desta tabela pode ser alterada ou
-- apagada, por NINGUÉM — nem admin, nem service_role, nem migração futura
-- via DML comum. Isso é deliberadamente mais forte que o padrão do resto do
-- código (que só se apoia na ausência de policy de UPDATE/DELETE no RLS,
-- contornável por service_role). O critério de aceite do Bloco 2 exige que
-- UPDATE/DELETE sejam REJEITADOS pelo log de auditoria, não apenas "não
-- oferecidos pela UI". Correção de erro = novo evento compensatório inserido
-- (nunca reescrever o antigo). Ver nota de retenção/particionamento no
-- cabeçalho desta migração para como isso convive com purge de 5 anos.
create or replace function public.reject_driver_period_transitions_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'driver_period_transitions é append-only: % não é permitido (registre um evento compensatório em vez de alterar/apagar)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists trg_reject_driver_period_transitions_update on public.driver_period_transitions;
create trigger trg_reject_driver_period_transitions_update
  before update on public.driver_period_transitions
  for each row execute function public.reject_driver_period_transitions_mutation();

drop trigger if exists trg_reject_driver_period_transitions_delete on public.driver_period_transitions;
create trigger trg_reject_driver_period_transitions_delete
  before delete on public.driver_period_transitions
  for each row execute function public.reject_driver_period_transitions_mutation();

-- ─── 3b) driver_period_daily_mileage (rollup mutável, por motorista/dia) ───

create table if not exists public.driver_period_daily_mileage (
  driver_id       uuid        not null references public.profiles(id) on delete cascade,
  -- Data (UTC) do dia de apuração — simples e sem ambiguidade de fuso;
  -- relatórios que precisarem de fuso local convertem na leitura.
  day             date        not null,

  p1_miles        numeric     not null default 0,
  p2_miles        numeric     not null default 0,
  p3_miles        numeric     not null default 0,
  estimated_miles numeric     not null default 0,

  updated_at      timestamptz not null default now(),

  primary key (driver_id, day)
);

create index if not exists driver_period_daily_mileage_day_idx
  on public.driver_period_daily_mileage (day);

alter table public.driver_period_daily_mileage enable row level security;

drop policy if exists driver_period_daily_mileage_upsert_own on public.driver_period_daily_mileage;
create policy driver_period_daily_mileage_upsert_own
  on public.driver_period_daily_mileage for insert
  to authenticated
  with check (auth.uid() = driver_id);

drop policy if exists driver_period_daily_mileage_update_own on public.driver_period_daily_mileage;
create policy driver_period_daily_mileage_update_own
  on public.driver_period_daily_mileage for update
  to authenticated
  using (auth.uid() = driver_id)
  with check (auth.uid() = driver_id);

drop policy if exists driver_period_daily_mileage_select_own_or_admin on public.driver_period_daily_mileage;
create policy driver_period_daily_mileage_select_own_or_admin
  on public.driver_period_daily_mileage for select
  to authenticated
  using (
    auth.uid() = driver_id
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_admin = true
    )
  );

drop policy if exists driver_period_daily_mileage_service_all on public.driver_period_daily_mileage;
create policy driver_period_daily_mileage_service_all
  on public.driver_period_daily_mileage for all
  to service_role
  using (true)
  with check (true);

create or replace function public.touch_driver_period_daily_mileage_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_touch_driver_period_daily_mileage on public.driver_period_daily_mileage;
create trigger trg_touch_driver_period_daily_mileage
  before update on public.driver_period_daily_mileage
  for each row execute function public.touch_driver_period_daily_mileage_updated_at();

-- ─── RPC: incremento atômico do rollup diário ──────────────────────────────
-- A camada de wiring (useDriverPeriodTracker, cliente) recebe um ping de GPS
-- a cada poucos segundos enquanto online; um .upsert() comum sobrescreveria o
-- total em vez de somar, e um padrão ler→somar→gravar no cliente teria corrida
-- entre pings próximos. Esta RPC faz o incremento ATÔMICO no próprio banco
-- (insert ... on conflict do update set x = x + delta), inspirada no mesmo
-- princípio de compare-and-set de accept_trip_offer (migration 0054).
-- SECURITY DEFINER para poder gravar em driver_period_daily_mileage mesmo
-- sob RLS restrito; valida explicitamente que o chamador é o próprio
-- motorista (auth.uid() = p_driver_id), igual ao padrão de accept_trip_offer.
create or replace function public.increment_driver_period_mileage(
  p_driver_id uuid,
  p_day date,
  p_p1_delta numeric,
  p_p2_delta numeric,
  p_p3_delta numeric,
  p_estimated_delta numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and auth.uid() <> p_driver_id then
    raise exception 'não autorizado: só o próprio motorista pode incrementar sua milhagem'
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.driver_period_daily_mileage (driver_id, day, p1_miles, p2_miles, p3_miles, estimated_miles)
  values (
    p_driver_id,
    p_day,
    greatest(p_p1_delta, 0),
    greatest(p_p2_delta, 0),
    greatest(p_p3_delta, 0),
    greatest(p_estimated_delta, 0)
  )
  on conflict (driver_id, day) do update
    set p1_miles        = public.driver_period_daily_mileage.p1_miles + greatest(excluded.p1_miles, 0),
        p2_miles        = public.driver_period_daily_mileage.p2_miles + greatest(excluded.p2_miles, 0),
        p3_miles        = public.driver_period_daily_mileage.p3_miles + greatest(excluded.p3_miles, 0),
        estimated_miles = public.driver_period_daily_mileage.estimated_miles + greatest(excluded.estimated_miles, 0);
end;
$$;

revoke all on function public.increment_driver_period_mileage(uuid, date, numeric, numeric, numeric, numeric) from public;
grant execute on function public.increment_driver_period_mileage(uuid, date, numeric, numeric, numeric, numeric) to authenticated, service_role;

-- ─── Feature flag (seed, idempotente) ──────────────────────────────────────

insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'period_tracking_v1_enabled',
  'global',
  'false'::jsonb,
  'Bloco 1 (compliance TNC F.S. 627.748): liga a máquina de estados P0-P3 e o acumulador de milhagem por período. Desligado por padrão — não muda nenhum comportamento visível até o rollout por jurisdição.',
  true
)
on conflict (key, jurisdiction) do nothing;
