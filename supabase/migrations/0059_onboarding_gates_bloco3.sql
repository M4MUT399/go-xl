-- Bloco 3 (compliance TNC F.S. 627.748) — gates de onboarding do motorista no
-- SERVIDOR: verificação de identidade + background check (válido, não
-- desqualificado, recheck em dia) + aceite do disclosure legal, além do gate
-- de Stripe Connect que já existia (migration 0038).
--
-- Escopo desta migração:
--
--   1) ALTER driver_background_checks: acrescenta `disqualified` +
--      `disqualification_reasons`, o RESULTADO já decidido de
--      src/lib/disqualificationRules.ts#evaluateDisqualification. Ver
--      "DECISÃO DE DESIGN" abaixo — o porquê de a regra ficar em TS, não em
--      PL/pgSQL.
--
--   2) Nova tabela driver_disclosure_acceptances — trilha APPEND-ONLY (mesmo
--      padrão de imutabilidade de driver_period_transitions, migrations
--      0056/0057) do consentimento do motorista a um disclosure legal
--      versionado. Um registro de aceite é prova de consentimento; nunca deve
--      poder ser editado ou apagado.
--
--   3) Função public.driver_can_go_online(p_driver_id) — a MESMA regra de
--      src/lib/driverOnboardingGate.ts#evaluateOnboardingGate, reimplementada
--      aqui como fonte de verdade do SERVIDOR. As duas implementações (TS e
--      SQL) precisam concordar; ver
--      comentário no topo de driverOnboardingGate.ts. Diferença proposital: a
--      versão SQL só faz os checks BARATOS e sem duplicar lógica de negócio
--      complexa (ver decisão de design abaixo sobre desqualificação).
--
--   4) Estende (create or replace, preservando 100% o gate de Stripe já
--      existente) enforce_driver_online_gating() para também chamar
--      driver_can_go_online() — mas SÓ quando a flag `onboarding_gates_v1_enabled`
--      está ligada; enquanto OFF, driver_can_go_online() sempre devolve true e
--      o comportamento é idêntico ao de antes desta migração.
--
--   5) Config (seeds idempotentes): onboarding_gates_v1_enabled (false),
--      background_check_recheck_years (3), driver_disclosure_required
--      (false), driver_disclosure_version ('1').
--
-- DECISÃO DE DESIGN (documentada por ser uma escolha real de arquitetura, não
-- óbvia): por que `disqualified`/`disqualification_reasons` são colunas
-- PERSISTIDAS em vez de a regra de limiar (felony/DUI/violação grave, com
-- janelas de anos) ser reimplementada em PL/pgSQL aqui —
--   a) evita DOIS lugares com a MESMA regra de negócio sensível (a lista de
--      ofensas desqualificantes já está documentada como interpretação
--      sujeita a revisão jurídica em disqualificationRules.ts — duplicá-la em
--      SQL dobraria o risco de as duas divergirem silenciosamente);
--   b) a função pura testada (14 casos, ver __tests__/disqualificationRules.test.ts)
--      já é a fonte de verdade; quem processa o resultado de um background
--      check (hoje: só o MockBackgroundCheckProvider client-side, que AINDA
--      NÃO grava em driver_background_checks — gap pré-existente do P7, não
--      introduzido aqui, documentado em docs/bloco3-onboarding-gates.md)
--      roda essa função e persiste só o VEREDITO (bool + motivos), não o
--      relatório bruto — mesmo espírito de "result jsonb" da 0031.
-- driver_can_go_online() portanto LÊ o veredito já calculado, não recalcula.
--
-- AMBIGUIDADE DOCUMENTADA — recheck trienal × validade operacional (P7): ver
-- o comentário equivalente no topo de src/lib/driverOnboardingGate.ts. Em
-- resumo: são dois relógios independentes (validade operacional via
-- expires_at, existente desde o P7; recheck trienal via checked_at + N anos,
-- novo aqui) — o mais restritivo bloqueia.

-- ─── 1) driver_background_checks: veredito de desqualificação ─────────────

alter table public.driver_background_checks
  add column if not exists disqualified boolean not null default false;
alter table public.driver_background_checks
  add column if not exists disqualification_reasons text[] not null default '{}';

-- ─── 2) driver_disclosure_acceptances — trilha append-only de consentimento ─

create table if not exists public.driver_disclosure_acceptances (
  id             uuid        primary key default gen_random_uuid(),
  driver_id      uuid        not null references public.profiles(id) on delete cascade,
  -- Chave do documento aceito (permite múltiplos disclosures no futuro sem
  -- migrar schema de novo). Bloco 3 usa 'tnc_driver_disclosure'.
  disclosure_key text        not null,
  -- Versão do texto aceito — junto com disclosure_key, define QUAL redação
  -- foi consentida (importante se o texto legal mudar: aceite antigo não
  -- vale pra versão nova).
  version        text        not null,
  accepted_at    timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  unique (driver_id, disclosure_key, version)
);

create index if not exists driver_disclosure_acceptances_driver_idx
  on public.driver_disclosure_acceptances (driver_id, disclosure_key);

alter table public.driver_disclosure_acceptances enable row level security;

-- Leitura: o próprio motorista lê seus aceites; admins leem todos (auditoria).
drop policy if exists driver_disclosure_acceptances_select_own_or_admin on public.driver_disclosure_acceptances;
create policy driver_disclosure_acceptances_select_own_or_admin
  on public.driver_disclosure_acceptances for select
  to authenticated
  using (
    auth.uid() = driver_id
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
  );

-- Inserção: só o próprio motorista registra o PRÓPRIO consentimento — não faz
-- sentido um admin "aceitar" em nome de alguém.
drop policy if exists driver_disclosure_acceptances_insert_own on public.driver_disclosure_acceptances;
create policy driver_disclosure_acceptances_insert_own
  on public.driver_disclosure_acceptances for insert
  to authenticated
  with check (auth.uid() = driver_id);

drop policy if exists driver_disclosure_acceptances_service_all on public.driver_disclosure_acceptances;
create policy driver_disclosure_acceptances_service_all
  on public.driver_disclosure_acceptances for all
  to service_role
  using (true)
  with check (true);

-- Append-only: nenhuma UPDATE/DELETE, nem por service_role — mesmo padrão de
-- dureza aplicado a driver_period_transitions (migrations 0056/0057). Um
-- consentimento registrado é prova histórica; uma retratação/nova versão gera
-- uma NOVA linha, nunca edita a antiga.
create or replace function public.reject_driver_disclosure_acceptances_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'driver_disclosure_acceptances é append-only: % não é permitido (uma nova versão do aceite gera uma NOVA linha)', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

drop trigger if exists trg_reject_driver_disclosure_acceptances_update on public.driver_disclosure_acceptances;
create trigger trg_reject_driver_disclosure_acceptances_update
  before update on public.driver_disclosure_acceptances
  for each row execute function public.reject_driver_disclosure_acceptances_mutation();

drop trigger if exists trg_reject_driver_disclosure_acceptances_delete on public.driver_disclosure_acceptances;
create trigger trg_reject_driver_disclosure_acceptances_delete
  before delete on public.driver_disclosure_acceptances
  for each row execute function public.reject_driver_disclosure_acceptances_mutation();

-- RPC de conveniência: idempotente (on conflict do nothing — reaceitar a
-- MESMA versão não é erro, só não duplica linha) e fixa accepted_at no
-- servidor (não confia no relógio do device).
create or replace function public.accept_driver_disclosure(p_disclosure_key text, p_version text)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  insert into public.driver_disclosure_acceptances (driver_id, disclosure_key, version, accepted_at)
  values (auth.uid(), p_disclosure_key, p_version, now())
  on conflict (driver_id, disclosure_key, version) do nothing;
end;
$$;

revoke all on function public.accept_driver_disclosure(text, text) from public;
grant execute on function public.accept_driver_disclosure(text, text) to authenticated;

-- ─── 3) Helper: resolve um valor booleano de system_config por jurisdição
--        (específica → global), mesma regra de src/lib/systemConfig.ts /
--        supabase/functions/_shared/adminConfigFlag.ts, agora também em SQL
--        pro trigger de gate poder ler sem round-trip pra Edge Function ─────

create or replace function public.resolve_config_bool(p_key text, p_jurisdiction text, p_default boolean)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_specific jsonb;
  v_global   jsonb;
begin
  if p_jurisdiction is not null and p_jurisdiction <> 'global' then
    select value into v_specific from public.system_config
     where key = p_key and jurisdiction = p_jurisdiction;
    if v_specific is not null then
      return (v_specific #>> '{}')::boolean;
    end if;
  end if;

  select value into v_global from public.system_config
   where key = p_key and jurisdiction = 'global';
  if v_global is not null then
    return (v_global #>> '{}')::boolean;
  end if;

  return p_default;
end;
$$;

revoke all on function public.resolve_config_bool(text, text, boolean) from public;
grant execute on function public.resolve_config_bool(text, text, boolean) to service_role;

create or replace function public.resolve_config_numeric(p_key text, p_jurisdiction text, p_default numeric)
returns numeric
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_specific jsonb;
  v_global   jsonb;
begin
  if p_jurisdiction is not null and p_jurisdiction <> 'global' then
    select value into v_specific from public.system_config
     where key = p_key and jurisdiction = p_jurisdiction;
    if v_specific is not null then
      return (v_specific #>> '{}')::numeric;
    end if;
  end if;

  select value into v_global from public.system_config
   where key = p_key and jurisdiction = 'global';
  if v_global is not null then
    return (v_global #>> '{}')::numeric;
  end if;

  return p_default;
end;
$$;

revoke all on function public.resolve_config_numeric(text, text, numeric) from public;
grant execute on function public.resolve_config_numeric(text, text, numeric) to service_role;

-- ─── 4) driver_can_go_online — a decisão unificada, espelhando
--        evaluateOnboardingGate (src/lib/driverOnboardingGate.ts) ──────────

create or replace function public.driver_can_go_online(p_driver_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_jurisdiction        text;
  v_gates_enabled       boolean;
  v_verification_status text;
  v_bg_required         boolean;
  v_recheck_years       numeric;
  v_disclosure_required boolean;
  v_disclosure_version  text;
  v_check               record;
begin
  select jurisdiction, verification_status
    into v_jurisdiction, v_verification_status
    from public.profiles
   where id = p_driver_id;

  -- Perfil inexistente: não é a este gate que cabe decidir — devolve true
  -- (outros gates/FKs já impediriam a linha de driver_locations de existir).
  if not found then
    return true;
  end if;

  v_gates_enabled := public.resolve_config_bool('onboarding_gates_v1_enabled', v_jurisdiction, false);
  if v_gates_enabled is distinct from true then
    return true; -- flag OFF → preserva o comportamento anterior a esta migração
  end if;

  if v_verification_status is distinct from 'approved' then
    return false;
  end if;

  v_bg_required := public.resolve_config_bool('background_check_required', v_jurisdiction, false);
  if v_bg_required then
    select status, checked_at, expires_at, disqualified
      into v_check
      from public.driver_background_checks
     where driver_id = p_driver_id
     order by created_at desc
     limit 1;

    if not found or v_check.status is distinct from 'clear' then
      return false;
    end if;
    if v_check.expires_at is not null and v_check.expires_at <= now() then
      return false;
    end if;
    if v_check.disqualified is true then
      return false;
    end if;

    v_recheck_years := public.resolve_config_numeric('background_check_recheck_years', v_jurisdiction, 3);
    if v_check.checked_at is not null
       and v_check.checked_at < now() - (v_recheck_years || ' years')::interval then
      return false;
    end if;
  end if;

  v_disclosure_required := public.resolve_config_bool('driver_disclosure_required', v_jurisdiction, false);
  if v_disclosure_required then
    v_disclosure_version := coalesce(
      (select value #>> '{}' from public.system_config where key = 'driver_disclosure_version' and jurisdiction = v_jurisdiction),
      (select value #>> '{}' from public.system_config where key = 'driver_disclosure_version' and jurisdiction = 'global'),
      '1'
    );

    if not exists (
      select 1 from public.driver_disclosure_acceptances
       where driver_id = p_driver_id
         and disclosure_key = 'tnc_driver_disclosure'
         and version = v_disclosure_version
    ) then
      return false;
    end if;
  end if;

  return true;
end;
$$;

revoke all on function public.driver_can_go_online(uuid) from public;
grant execute on function public.driver_can_go_online(uuid) to service_role, authenticated;

-- ─── 5) Estende o gate de driver_locations (create or replace preserva o
--        check de Stripe da 0038 tal e qual, e ACRESCENTA os novos checks) ──

create or replace function public.enforce_driver_online_gating()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stripe_enabled boolean;
begin
  if new.is_online is true then
    select (stripe_charges_enabled and stripe_payouts_enabled)
      into v_stripe_enabled
      from public.profiles
     where id = new.driver_id;

    if v_stripe_enabled is distinct from true then
      new.is_online := false;
      return new;
    end if;

    -- Bloco 3: verificação + background check + disclosure. Função já trata
    -- sozinha a flag onboarding_gates_v1_enabled (devolve true se OFF).
    if public.driver_can_go_online(new.driver_id) is distinct from true then
      new.is_online := false;
    end if;
  end if;
  return new;
end;
$$;

-- Trigger já existe (0038) apontando pra mesma função — nada a recriar aqui,
-- create or replace da função já é suficiente.

-- ─── 6) Config (seeds idempotentes) ────────────────────────────────────────

insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'onboarding_gates_v1_enabled',
  'global',
  'false'::jsonb,
  'Bloco 3 (compliance TNC F.S. 627.748): liga os gates de onboarding no SERVIDOR (verificação de identidade + background check válido/não desqualificado/recheck em dia + aceite do disclosure legal) via driver_can_go_online(). Desligado por padrão — enquanto OFF, o gate de driver_locations continua igual ao de antes desta migração (só Stripe Connect).',
  true
)
on conflict (key, jurisdiction) do nothing;

insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'background_check_recheck_years',
  'global',
  '3'::jsonb,
  'Bloco 3 (compliance TNC F.S. 627.748): anos entre recertificações obrigatórias do background check ("recheck trienal"), INDEPENDENTE da validade operacional (background_check_valid_days, P7). O motorista precisa refazer o check pelo menos a cada N anos mesmo que a validade operacional configurada seja maior.',
  true
)
on conflict (key, jurisdiction) do nothing;

insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'driver_disclosure_required',
  'global',
  'false'::jsonb,
  'Bloco 3 (compliance TNC F.S. 627.748): exige que o motorista tenha aceitado a versão vigente do disclosure legal (driver_disclosure_acceptances) para ficar online. Desligado por padrão.',
  true
)
on conflict (key, jurisdiction) do nothing;

insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'driver_disclosure_version',
  'global',
  '"1"'::jsonb,
  'Bloco 3: versão vigente do texto do disclosure legal (driver_disclosure_acceptances.version). Mudar este valor invalida aceites de versões anteriores — o motorista precisa aceitar de novo.',
  true
)
on conflict (key, jurisdiction) do nothing;
