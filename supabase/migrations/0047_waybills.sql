-- waybills — persistência do "snapshot" de cada carta de porte/recibo (P4)
-- gerada sob demanda pelo motorista (ver src/lib/waybill.ts + waybillExport.ts).
--
-- Por quê snapshot e não "recalcular depois": os dados legais da empresa
-- (system_config) e a tarifa podem mudar com o tempo; o recibo emitido tem
-- que continuar batendo com o que foi mostrado/entregue ao passageiro/
-- motorista no momento da emissão. Por isso persistimos os campos já
-- resolvidos (buildWaybill), não apenas o ride_id.
--
-- RBAC/RLS segue o mesmo padrão de ride_offer_events (0023): o motorista só
-- insere/lê os próprios waybills; admin (profiles.is_admin) lê tudo; Edge
-- Functions administrativas (service_role) têm acesso completo.
--
-- Retenção: fora do escopo desta migration — ver item #15 do backlog
-- ("rate limit, retenção, criptografia-em-repouso, admin audit log"), que
-- cobre a política de expurgo/purge. created_at já está indexado para
-- viabilizar esse job quando for definido.
create table if not exists public.waybills (
  id                     uuid        primary key default gen_random_uuid(),
  ride_id                uuid        not null references public.rides(id) on delete cascade,
  driver_id              uuid        not null references public.profiles(id) on delete cascade,
  passenger_id           uuid        references public.profiles(id) on delete set null,

  company_legal_name     text        not null default '',
  company_license_number text        not null default '',
  company_footer_note    text        not null default '',

  origin_address         text,
  destination_address    text,
  distance_km            numeric,
  duration_min           integer,
  driver_name            text,
  vehicle_label          text,
  passenger_name         text,

  fare_lines             jsonb       not null default '[]'::jsonb,
  total                  numeric(10, 2) not null default 0,
  currency               text        not null default 'USD',

  issued_at              timestamptz not null default now(),
  created_at             timestamptz not null default now()
);

create index if not exists waybills_ride_idx     on public.waybills (ride_id);
create index if not exists waybills_driver_idx   on public.waybills (driver_id, created_at desc);
create index if not exists waybills_created_idx  on public.waybills (created_at desc);

alter table public.waybills enable row level security;

-- Inserção: o motorista só registra o próprio waybill (emitido pelo app dele).
drop policy if exists waybills_insert_own on public.waybills;
create policy waybills_insert_own
  on public.waybills for insert
  to authenticated
  with check (auth.uid() = driver_id);

-- Leitura: o próprio motorista lê os seus; admins leem todos.
drop policy if exists waybills_select_own_or_admin on public.waybills;
create policy waybills_select_own_or_admin
  on public.waybills for select
  to authenticated
  using (
    auth.uid() = driver_id
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_admin = true
    )
  );

-- Acesso administrativo completo via service_role (Edge Functions/admin).
drop policy if exists waybills_service_all on public.waybills;
create policy waybills_service_all
  on public.waybills for all
  to service_role
  using (true)
  with check (true);

-- admin_audit_log — trilha de auditoria das ações administrativas do painel
-- (go-xl-admin), começando pela busca/consulta de waybills (P4/#5). Tabela
-- dedicada nova — não reaproveita goxl_activity_log (que é ad-hoc, não
-- versionada em migration, e cobre apenas o próprio painel, sem RLS nem
-- vínculo com o RBAC is_admin já existente no app).
create table if not exists public.admin_audit_log (
  id           uuid        primary key default gen_random_uuid(),
  admin_id     uuid        not null references public.profiles(id) on delete cascade,
  action       text        not null,
  resource     text        not null,
  resource_id  text,
  metadata     jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists admin_audit_log_admin_idx    on public.admin_audit_log (admin_id, created_at desc);
create index if not exists admin_audit_log_resource_idx on public.admin_audit_log (resource, resource_id);
create index if not exists admin_audit_log_created_idx  on public.admin_audit_log (created_at desc);

alter table public.admin_audit_log enable row level security;

-- Leitura: só admins podem ver a trilha de auditoria.
drop policy if exists admin_audit_log_select_admin on public.admin_audit_log;
create policy admin_audit_log_select_admin
  on public.admin_audit_log for select
  to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_admin = true
    )
  );

-- Escrita: só via service_role (Edge Functions administrativas) — nunca
-- diretamente do cliente, para a trilha não poder ser forjada/apagada por um
-- admin comprometido a partir do painel.
drop policy if exists admin_audit_log_service_all on public.admin_audit_log;
create policy admin_audit_log_service_all
  on public.admin_audit_log for all
  to service_role
  using (true)
  with check (true);
