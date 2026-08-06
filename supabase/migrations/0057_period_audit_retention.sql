-- Bloco 2 (compliance F.S. 627.748) — log auditável + relatórios de
-- compliance, em cima da trilha imutável criada no Bloco 1
-- (driver_period_transitions, migration 0056).
--
-- Escopo desta migração:
--
--   1) Resolve a tensão "append-only" x "retenção configurável" já
--      documentada na migration 0056: converte driver_period_transitions em
--      tabela PARTICIONADA por mês (RANGE em created_at). Continua
--      IMPOSSÍVEL alterar/apagar uma LINHA (os triggers de rejeição são
--      clonados automaticamente pelo Postgres em toda partição, existente ou
--      futura — nenhuma DML de UPDATE/DELETE passa, nem via service_role).
--      Retenção vira DROP de uma PARTIÇÃO inteira já vencida — é DDL, não
--      DML, então não é bloqueada pelos triggers de linha, e é exatamente a
--      operação que o comando pede ("retenção configurável, default 5
--      anos"). Cada purge fica registrado em
--      driver_period_transitions_maintenance_log para auditoria de quem/
--      quando uma partição saiu do banco.
--
--   2) Hardening encontrado nesta revisão: a migration 0056 rejeitava
--      UPDATE/DELETE mas não TRUNCATE (trigger de linha não dispara em
--      TRUNCATE — é preciso um trigger de ESTATEMENT dedicado). Sem isso,
--      qualquer role com privilégio de TRUNCATE (ex.: service_role) apagaria
--      a tabela inteira de uma vez só, contornando a garantia de
--      imutabilidade. Fechado aqui com um trigger BEFORE TRUNCATE.
--
--   3) Config: `period_retention_years` (system_config, default 5, piso
--      técnico de 1 ano aplicado na própria função de purge — nunca purga
--      abaixo de 12 meses de histórico, mesmo que alguém configure um valor
--      menor por engano) e a flag `period_audit_v1_enabled` (Bloco 2,
--      default OFF) que liga as duas Edge Functions administrativas novas
--      (admin-telematics-claims, admin-telematics-export). A manutenção de
--      partição/retenção em si NÃO depende dessa flag — é infraestrutura
--      invisível ao usuário, roda sempre (mesmo raciocínio da 0056 para os
--      triggers de timestamp: "inertes por natureza", seguros ligar desde já).
--
--   4) Bucket de storage privado `telematics-exports` para o export mensal
--      (Edge Function admin-telematics-export) e a tabela
--      `telematics_export_runs` que registra cada geração (cron ou sob
--      demanda pelo admin).
--
-- Decisão de design documentada para review (ambiguidade real, registrando
-- em vez de decidir calado): "odômetro"/retenção por partição significa que,
-- ao converter a tabela hoje, os dados pré-existentes (se houver — a flag
-- period_tracking_v1_enabled está OFF em todo lugar, então na prática deve
-- estar vazia) são realocados para a(s) partição(ões) mensal(is) correta(s)
-- calculada(s) a partir do próprio created_at de cada linha; nenhuma linha é
-- descartada na conversão.

-- ─── 1) Tabela de log de manutenção de partição (criada antes das funções
--        que escrevem nela) ────────────────────────────────────────────────

create table if not exists public.driver_period_transitions_maintenance_log (
  id             uuid        primary key default gen_random_uuid(),
  action         text        not null check (action in ('partition_created', 'partition_purged')),
  partition_name text        not null,
  boundary_from  date,
  boundary_to    date,
  created_at     timestamptz not null default now()
);

create index if not exists driver_period_transitions_maintenance_log_created_idx
  on public.driver_period_transitions_maintenance_log (created_at desc);

alter table public.driver_period_transitions_maintenance_log enable row level security;

drop policy if exists driver_period_transitions_maintenance_log_select_admin on public.driver_period_transitions_maintenance_log;
create policy driver_period_transitions_maintenance_log_select_admin
  on public.driver_period_transitions_maintenance_log for select
  to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
  );

drop policy if exists driver_period_transitions_maintenance_log_service_all on public.driver_period_transitions_maintenance_log;
create policy driver_period_transitions_maintenance_log_service_all
  on public.driver_period_transitions_maintenance_log for all
  to service_role
  using (true)
  with check (true);

-- ─── 2) Função: garante a existência da partição mensal de `p_month_start`
--        (idempotente — chamada tanto na conversão abaixo quanto pelo cron
--        mensal, que sempre pré-cria o mês seguinte com folga) ────────────

create or replace function public.ensure_driver_period_transitions_partition(p_month_start date)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start   date := date_trunc('month', p_month_start)::date;
  v_end     date := (date_trunc('month', p_month_start) + interval '1 month')::date;
  v_name    text := format('driver_period_transitions_y%s_m%s', to_char(v_start, 'YYYY'), to_char(v_start, 'MM'));
  v_existed boolean;
begin
  select exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = v_name
  ) into v_existed;

  if v_existed then
    return false;
  end if;

  execute format(
    'create table if not exists public.%I partition of public.driver_period_transitions for values from (%L) to (%L)',
    v_name, v_start, v_end
  );

  insert into public.driver_period_transitions_maintenance_log (action, partition_name, boundary_from, boundary_to)
  values ('partition_created', v_name, v_start, v_end);

  return true;
end;
$$;

revoke all on function public.ensure_driver_period_transitions_partition(date) from public;
grant execute on function public.ensure_driver_period_transitions_partition(date) to service_role;

-- ─── 3) Conversão ONE-TIME de driver_period_transitions em tabela
--        particionada — guardada por um check de idempotência (relkind='p')
--        para a migração poder ser reaplicada em segurança ─────────────────

do $$
declare
  v_min date;
  v_max date;
  v_floor date;
  m date;
begin
  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'driver_period_transitions' and c.relkind = 'p'
  ) then

    execute 'alter table public.driver_period_transitions rename to driver_period_transitions_pre_partition';

    execute $ddl$
      create table public.driver_period_transitions (
        id                              uuid        not null default gen_random_uuid(),
        driver_id                       uuid        not null references public.profiles(id) on delete cascade,
        trip_id                         uuid        references public.rides(id) on delete set null,
        from_period                     text        not null check (from_period in ('P0_OFFLINE','P1_AVAILABLE','P2_ENROUTE','P3_ONTRIP')),
        to_period                       text        not null check (to_period   in ('P0_OFFLINE','P1_AVAILABLE','P2_ENROUTE','P3_ONTRIP')),
        reason                          text        not null,
        at_ms                           bigint      not null,
        lat                             double precision,
        lng                             double precision,
        cumulative_miles_at_transition  numeric,
        mileage_estimated               boolean     not null default false,
        created_at                      timestamptz not null default now(),
        -- Chave primária de tabela particionada precisa incluir a coluna de
        -- particionamento (created_at) — exigência do Postgres, não escolha
        -- de design. `id` sozinho (uuid v4) já garante unicidade prática; a
        -- composição só formaliza isso para o particionamento funcionar.
        primary key (id, created_at)
      ) partition by range (created_at)
    $ddl$;

    -- Partição "catch-all": qualquer linha fora das partições mensais
    -- explícitas cai aqui em vez de fazer o INSERT falhar — rede de
    -- segurança para dado histórico fora do range calculado abaixo ou para
    -- uma falha futura do cron de manutenção. Nunca é alvo de purge (só
    -- partições com o padrão de nome yYYYY_mMM são candidatas).
    execute 'create table public.driver_period_transitions_default partition of public.driver_period_transitions default';

    execute 'select date_trunc(''month'', min(created_at))::date, date_trunc(''month'', max(created_at))::date from public.driver_period_transitions_pre_partition'
      into v_min, v_max;

    if v_min is null then
      v_min := date_trunc('month', now())::date;
      v_max := v_min;
    end if;

    -- Sempre garante folga de 3 meses à frente de "agora", mesmo que o
    -- histórico existente seja mais antigo.
    v_floor := date_trunc('month', now() + interval '3 months')::date;
    if v_max < v_floor then
      v_max := v_floor;
    end if;

    m := v_min;
    while m <= v_max loop
      perform public.ensure_driver_period_transitions_partition(m);
      m := (m + interval '1 month')::date;
    end loop;

    execute 'insert into public.driver_period_transitions select * from public.driver_period_transitions_pre_partition';
    execute 'drop table public.driver_period_transitions_pre_partition';
  end if;
end $$;

-- ─── 4) Índices, RLS e triggers na tabela particionada (idênticos em
--        espírito aos da migration 0056 — o Postgres propaga automaticamente
--        para toda partição existente/futura a partir daqui) ──────────────

create index if not exists driver_period_transitions_driver_idx
  on public.driver_period_transitions (driver_id, at_ms desc);
create index if not exists driver_period_transitions_trip_idx
  on public.driver_period_transitions (trip_id);
create index if not exists driver_period_transitions_created_idx
  on public.driver_period_transitions (created_at desc);
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
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
  );

drop policy if exists driver_period_transitions_service_all on public.driver_period_transitions;
create policy driver_period_transitions_service_all
  on public.driver_period_transitions for all
  to service_role
  using (true)
  with check (true);

-- Reaproveita a função de rejeição já criada na migration 0056
-- (create or replace lá, reexecutada aqui por clareza/idempotência).
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

-- Hardening (achado nesta revisão, ver cabeçalho): TRUNCATE não dispara
-- trigger de LINHA, precisa de um trigger de ESTATEMENT dedicado — sem isso
-- qualquer role com privilégio de TRUNCATE zerava a tabela inteira contornando
-- a imutabilidade.
drop trigger if exists trg_reject_driver_period_transitions_truncate on public.driver_period_transitions;
create trigger trg_reject_driver_period_transitions_truncate
  before truncate on public.driver_period_transitions
  for each statement execute function public.reject_driver_period_transitions_mutation();

-- ─── 5) Função de purge por retenção (DROP de partição inteira vencida) ────

create or replace function public.purge_expired_driver_period_transitions()
returns table(partition_name text, dropped boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_retention_years int;
  v_cutoff date;
  r record;
begin
  select (value #>> '{}')::int into v_retention_years
  from public.system_config
  where key = 'period_retention_years' and jurisdiction = 'global';

  -- Piso de 1 ano é regra de negócio, não só validação de tipo — ver
  -- cabeçalho desta migração. Aplicado aqui (não só na leitura do app) para
  -- que nenhum caminho de purge dependa de o app estar rodando corretamente.
  v_retention_years := greatest(coalesce(v_retention_years, 5), 1);
  v_cutoff := date_trunc('month', now() - (v_retention_years || ' years')::interval)::date;

  for r in
    select c.relname,
           substring(c.relname from 'y([0-9]{4})_m([0-9]{2})$') as ym_match,
           (substring(c.relname from 'y([0-9]{4})'))::int as yr,
           (substring(c.relname from '_m([0-9]{2})$'))::int as mo
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    join pg_class p on p.oid = i.inhparent
    join pg_namespace n on n.oid = p.relnamespace
    where n.nspname = 'public'
      and p.relname = 'driver_period_transitions'
      and c.relname ~ '^driver_period_transitions_y[0-9]{4}_m[0-9]{2}$'
  loop
    if make_date(r.yr, r.mo, 1) < v_cutoff then
      execute format('drop table if exists public.%I', r.relname);

      insert into public.driver_period_transitions_maintenance_log (action, partition_name, boundary_from, boundary_to)
      values (
        'partition_purged',
        r.relname,
        make_date(r.yr, r.mo, 1),
        (make_date(r.yr, r.mo, 1) + interval '1 month')::date
      );

      partition_name := r.relname;
      dropped := true;
      return next;
    end if;
  end loop;
end;
$$;

revoke all on function public.purge_expired_driver_period_transitions() from public;
grant execute on function public.purge_expired_driver_period_transitions() to service_role;

-- ─── 6) Manutenção mensal via pg_cron: pré-cria os 2 meses seguintes
--        (folga contra o cron falhar uma vez) + roda o purge ─────────────

create extension if not exists pg_cron;

select cron.unschedule('period-transitions-maintenance')
where exists (select 1 from cron.job where jobname = 'period-transitions-maintenance');

select cron.schedule(
  'period-transitions-maintenance',
  '15 6 1 * *',  -- dia 1 de cada mês, 06:15 UTC — fora do horário de pico do app
  $$
    select public.ensure_driver_period_transitions_partition((date_trunc('month', now()) + interval '1 month')::date);
    select public.ensure_driver_period_transitions_partition((date_trunc('month', now()) + interval '2 months')::date);
    select public.purge_expired_driver_period_transitions();
  $$
);

-- ─── 7) Bucket privado para o export mensal + tabela de registro ──────────

insert into storage.buckets (id, name, public)
values ('telematics-exports', 'telematics-exports', false)
on conflict (id) do nothing;

-- Sem policy de storage.objects para `authenticated` de propósito: o acesso
-- (leitura/escrita) só acontece via Edge Function com service_role (mesmo
-- padrão do bucket driver-verification, migration 0019) — service_role
-- ignora RLS/policy de storage, então nenhuma policy adicional é necessária
-- nem desejável aqui (nenhum usuário comum deve ler este bucket direto).

create table if not exists public.telematics_export_runs (
  id           uuid        primary key default gen_random_uuid(),
  -- Primeiro dia do mês exportado (não o dia em que o export rodou).
  month        date        not null,
  triggered_by text        not null check (triggered_by in ('cron', 'admin')),
  admin_id     uuid        references public.profiles(id) on delete set null,
  row_count    integer     not null default 0,
  storage_path text,
  created_at   timestamptz not null default now()
);

create index if not exists telematics_export_runs_month_idx
  on public.telematics_export_runs (month desc);

alter table public.telematics_export_runs enable row level security;

drop policy if exists telematics_export_runs_select_admin on public.telematics_export_runs;
create policy telematics_export_runs_select_admin
  on public.telematics_export_runs for select
  to authenticated
  using (
    exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
  );

drop policy if exists telematics_export_runs_service_all on public.telematics_export_runs;
create policy telematics_export_runs_service_all
  on public.telematics_export_runs for all
  to service_role
  using (true)
  with check (true);

-- ─── 8) Config (seeds idempotentes) ────────────────────────────────────────

insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'period_retention_years',
  'global',
  '5'::jsonb,
  'Bloco 2 (compliance TNC F.S. 627.748): anos de retenção de driver_period_transitions antes de a partição mensal correspondente ser purgada (DROP). Piso técnico de 1 ano aplicado sempre, mesmo que este valor seja configurado abaixo disso.',
  true
)
on conflict (key, jurisdiction) do nothing;

insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'period_audit_v1_enabled',
  'global',
  'false'::jsonb,
  'Bloco 2 (compliance TNC F.S. 627.748): liga as Edge Functions administrativas admin-telematics-claims (claims lookup) e admin-telematics-export (export mensal para a seguradora). Desligado por padrão. NÃO afeta a manutenção de partição/retenção, que roda sempre independente desta flag.',
  false
)
on conflict (key, jurisdiction) do nothing;
