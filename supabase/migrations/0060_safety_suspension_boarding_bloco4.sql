-- Bloco 4 (compliance TNC F.S. 627.748) — três frentes independentes:
--
--   1) DENÚNCIA → SUSPENSÃO DE TOLERÂNCIA ZERO: nova tabela
--      driver_safety_reports (denúncia do passageiro/admin contra um
--      motorista) + driver_suspensions (veredito PERSISTIDO de suspensão —
--      mesmo princípio de "server computa uma vez, todo lugar só lê" de
--      driver_background_checks.disqualified na 0059). Um trigger em
--      driver_safety_reports SEMPRE cria a suspensão quando a categoria é de
--      tolerância zero (auditoria/histórico não depende de flag nenhuma) —
--      mas se essa suspensão de fato BLOQUEIA o motorista de ficar online é
--      controlado por uma flag PRÓPRIA (`safety_suspension_gate_v1_enabled`),
--      independente da flag do Bloco 3 (`onboarding_gates_v1_enabled`), pra
--      poder ligar/desligar os dois blocos sem depender um do outro (regra
--      geral do COMANDO: "feature flag por bloco").
--
--   2) CONFIRMAÇÃO DE MOTORISTA+VEÍCULO PELO PASSAGEIRO: nova coluna
--      `rides.passenger_confirmed_driver_at` + RPC
--      `confirm_driver_before_boarding(ride_id)`, carimbando no servidor —
--      mesmo padrão de accept_driver_disclosure (0059) e
--      stamp_ride_period_timestamps (0056). DECISÃO DE DESIGN (ver também
--      src/lib/driverBoardingConfirmation.ts): NÃO é um bloqueio rígido da
--      transição pra 'in_progress' — stamp_ride_period_timestamps() já é uma
--      trigger incondicional em produção desde o Bloco 1, usada por TODA
--      corrida; condicioná-la a esta tabela nova arriscaria travar corridas
--      legítimas se o passageiro estiver com o app fechado/sem internet no
--      momento exato do embarque. Em vez disso o app do passageiro pede a
--      confirmação de forma proeminente (client, via shouldPromptDriverConfirmation)
--      e o app do motorista mostra um AVISO (não bloqueio) se avançar sem ela
--      (client, via boardingWarning). Esta migração só grava o carimbo —
--      nenhuma trigger de rides é alterada.
--
--   3) RECIBO ELETRÔNICO COMPLETO PRO PASSAGEIRO: reaproveita 100% a infra já
--      existente do waybill (src/lib/waybill.ts + waybillExport.ts, tabela
--      `waybills` da migration do P4) — nenhuma tabela/função nova aqui. Só
--      precisa da flag de config `receipt_passenger_v1_enabled` (seed nesta
--      migração) pra a UI do passageiro decidir se mostra o botão de baixar
--      recibo; a geração em si já é genérica (motorista e passageiro usam o
--      mesmo buildWaybill/generateAndShareWaybill).
--
-- AMBIGUIDADE DOCUMENTADA — lista de categorias de tolerância zero: a
-- linguagem estatutária de F.S. 627.748 sobre "zero tolerance" trata
-- especificamente de uso de álcool/droga pelo motorista em serviço
-- (`driver_intoxication`). As categorias adicionais aqui
-- (`sexual_assault`, `physical_assault`, `weapon_possession`) seguem por
-- analogia a prática padrão do setor TNC (Uber/Lyft), MESMA lista definida
-- em src/lib/safetyIncidents.ts — reafirmada aqui via check constraint só
-- pra consistência de schema; a fonte de verdade da classificação
-- zero-tolerance × revisão normal é a função is_zero_tolerance_category()
-- abaixo, que espelha ZERO_TOLERANCE_CATEGORIES em TS. Documentado para
-- revisão jurídica/compliance antes de `safety_suspension_gate_v1_enabled`
-- ir a produção.

-- ─── 1) driver_safety_reports — denúncia (não append-only: admin precisa
--        poder atualizar status/resolution_notes ao revisar) ───────────────

create table if not exists public.driver_safety_reports (
  id                 uuid        primary key default gen_random_uuid(),
  driver_id          uuid        not null references public.profiles(id) on delete cascade,
  reporter_id        uuid        references public.profiles(id) on delete set null,
  ride_id            uuid        references public.rides(id) on delete set null,
  category           text        not null check (category in (
    'driver_intoxication', 'sexual_assault', 'physical_assault', 'weapon_possession',
    'discrimination', 'reckless_driving', 'vehicle_mismatch', 'unsafe_vehicle', 'other'
  )),
  -- Texto livre da denúncia — NÃO é PII de background check (regra geral do
  -- COMANDO é sobre relatório bruto de background check/documentos oficiais);
  -- ainda assim é sensível o bastante (pode identificar o denunciante por
  -- contexto) pra ficar restrito via RLS a admin+o próprio denunciante,
  -- nunca ao motorista denunciado — ver policy abaixo.
  description        text,
  status             text        not null default 'open' check (status in ('open', 'under_review', 'resolved', 'dismissed')),
  resolution_notes   text,
  created_at         timestamptz not null default now(),
  resolved_at        timestamptz
);

create index if not exists driver_safety_reports_driver_idx on public.driver_safety_reports (driver_id);
create index if not exists driver_safety_reports_status_idx on public.driver_safety_reports (status);

alter table public.driver_safety_reports enable row level security;

-- Leitura: o denunciante lê a própria denúncia; admins leem todas. O
-- motorista denunciado NUNCA lê via esta policy (proteção do denunciante
-- contra retaliação) — se algum dia precisar saber que foi denunciado, isso
-- vem de driver_suspensions (veredito), não da denúncia bruta.
drop policy if exists driver_safety_reports_select_reporter_or_admin on public.driver_safety_reports;
create policy driver_safety_reports_select_reporter_or_admin
  on public.driver_safety_reports for select
  to authenticated
  using (
    auth.uid() = reporter_id
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
  );

-- Inserção: qualquer usuário autenticado pode denunciar (passageiro contra
-- motorista da própria corrida, tipicamente) — reporter_id é sempre o
-- próprio usuário, nunca em nome de outro.
drop policy if exists driver_safety_reports_insert_own on public.driver_safety_reports;
create policy driver_safety_reports_insert_own
  on public.driver_safety_reports for insert
  to authenticated
  with check (auth.uid() = reporter_id);

-- Atualização (status/resolution_notes ao revisar): só admin.
drop policy if exists driver_safety_reports_update_admin on public.driver_safety_reports;
create policy driver_safety_reports_update_admin
  on public.driver_safety_reports for update
  to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true));

drop policy if exists driver_safety_reports_service_all on public.driver_safety_reports;
create policy driver_safety_reports_service_all
  on public.driver_safety_reports for all
  to service_role
  using (true)
  with check (true);

-- Sem policy de DELETE para nenhum papel além de service_role (default deny)
-- — uma denúncia não se apaga, no máximo se marca 'dismissed'.

-- ─── 2) driver_suspensions — veredito PERSISTIDO (suspensão ativa = lifted_at
--        is null), mesmo princípio de driver_background_checks.disqualified ──

create table if not exists public.driver_suspensions (
  id                uuid        primary key default gen_random_uuid(),
  driver_id         uuid        not null references public.profiles(id) on delete cascade,
  safety_report_id  uuid        references public.driver_safety_reports(id) on delete set null,
  -- Formato 'zero_tolerance_report:<category>' — ver buildSuspensionReason em
  -- src/lib/safetyIncidents.ts; mantém rastreabilidade da causa sem repetir a
  -- descrição sensível da denúncia aqui.
  reason            text        not null,
  suspended_at      timestamptz not null default now(),
  lifted_at         timestamptz,
  lifted_by         uuid        references public.profiles(id) on delete set null,
  lift_notes        text
);

create index if not exists driver_suspensions_driver_idx on public.driver_suspensions (driver_id);
create index if not exists driver_suspensions_active_idx on public.driver_suspensions (driver_id) where lifted_at is null;

alter table public.driver_suspensions enable row level security;

-- Leitura: o próprio motorista vê suas suspensões (precisa saber que está
-- suspenso e por quê — só o motivo categorizado, não a denúncia bruta);
-- admins veem todas.
drop policy if exists driver_suspensions_select_own_or_admin on public.driver_suspensions;
create policy driver_suspensions_select_own_or_admin
  on public.driver_suspensions for select
  to authenticated
  using (
    auth.uid() = driver_id
    or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin = true)
  );

-- Inserção/atualização (levantar suspensão) diretas via client: nenhuma —
-- suspensão é criada só pela trigger (security definer, abaixo) e levantada
-- só por admin via RPC dedicada (lift_driver_suspension, abaixo). Não há
-- policy de insert/update pra `authenticated`, então fica bloqueado por
-- padrão (RLS deny-by-default) exceto service_role.
drop policy if exists driver_suspensions_service_all on public.driver_suspensions;
create policy driver_suspensions_service_all
  on public.driver_suspensions for all
  to service_role
  using (true)
  with check (true);

-- ─── 3) Trigger: denúncia de tolerância zero → suspensão automática ────────
-- SEMPRE cria a linha de suspensão (auditoria/histórico independe de flag —
-- mesmo padrão de disqualified em driver_background_checks, 0059); se isso
-- de fato BLOQUEIA o motorista é decidido depois, em driver_can_go_online(),
-- via safety_suspension_gate_v1_enabled.

create or replace function public.is_zero_tolerance_category(p_category text)
returns boolean
language sql
immutable
as $$
  select p_category in ('driver_intoxication', 'sexual_assault', 'physical_assault', 'weapon_possession');
$$;

create or replace function public.auto_suspend_on_zero_tolerance_report()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.is_zero_tolerance_category(new.category) then
    insert into public.driver_suspensions (driver_id, safety_report_id, reason, suspended_at)
    values (new.driver_id, new.id, 'zero_tolerance_report:' || new.category, now());
  end if;
  return new;
end;
$$;

drop trigger if exists trg_auto_suspend_on_zero_tolerance_report on public.driver_safety_reports;
create trigger trg_auto_suspend_on_zero_tolerance_report
  after insert on public.driver_safety_reports
  for each row execute function public.auto_suspend_on_zero_tolerance_report();

-- RPC de conveniência pra admin levantar uma suspensão (idempotência: erro
-- claro se já levantada, espelhando canLiftSuspension em safetyIncidents.ts).
create or replace function public.lift_driver_suspension(p_suspension_id uuid, p_notes text default null)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_is_admin boolean;
  v_lifted_at timestamptz;
begin
  select p.is_admin into v_is_admin from public.profiles p where p.id = auth.uid();
  if v_is_admin is distinct from true then
    raise exception 'apenas administradores podem levantar suspensões' using errcode = 'insufficient_privilege';
  end if;

  select lifted_at into v_lifted_at from public.driver_suspensions where id = p_suspension_id;
  if not found then
    raise exception 'suspensão não encontrada';
  end if;
  if v_lifted_at is not null then
    raise exception 'suspensão já foi levantada' using errcode = 'invalid_parameter_value';
  end if;

  update public.driver_suspensions
     set lifted_at = now(), lifted_by = auth.uid(), lift_notes = p_notes
   where id = p_suspension_id;
end;
$$;

revoke all on function public.lift_driver_suspension(uuid, text) from public;
grant execute on function public.lift_driver_suspension(uuid, text) to authenticated;

revoke all on function public.is_zero_tolerance_category(text) from public;
grant execute on function public.is_zero_tolerance_category(text) to service_role, authenticated;

-- ─── 4) rides.passenger_confirmed_driver_at + RPC de confirmação ───────────

alter table public.rides
  add column if not exists passenger_confirmed_driver_at timestamptz;

-- Não usa a trigger genérica de rides (stamp_ride_period_timestamps) de
-- propósito — ver "DECISÃO DE DESIGN" no topo: este carimbo é gravado só via
-- ação explícita do passageiro (RPC), não como consequência de uma mudança
-- de status.
create or replace function public.confirm_driver_before_boarding(p_ride_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_passenger_id uuid;
  v_status       text;
  v_already      timestamptz;
begin
  select passenger_id, status, passenger_confirmed_driver_at
    into v_passenger_id, v_status, v_already
    from public.rides
   where id = p_ride_id;

  if not found then
    raise exception 'corrida não encontrada';
  end if;
  if auth.uid() <> v_passenger_id then
    raise exception 'apenas o passageiro da corrida pode confirmar' using errcode = 'insufficient_privilege';
  end if;
  if v_already is not null then
    return; -- idempotente: já confirmado, não é erro (mesmo espírito de canConfirmDriver)
  end if;
  if v_status not in ('accepted', 'driver_en_route', 'in_progress') then
    raise exception 'corrida não está numa janela válida de confirmação' using errcode = 'invalid_parameter_value';
  end if;

  update public.rides
     set passenger_confirmed_driver_at = now()
   where id = p_ride_id;
end;
$$;

revoke all on function public.confirm_driver_before_boarding(uuid) from public;
grant execute on function public.confirm_driver_before_boarding(uuid) to authenticated;

-- ─── 5) Estende driver_can_go_online — suspensão checada ANTES do early
--        return da flag do Bloco 3, com sua PRÓPRIA flag independente ──────

create or replace function public.driver_can_go_online(p_driver_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_jurisdiction        text;
  v_suspension_enabled  boolean;
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

  -- Bloco 4: suspensão de tolerância zero — flag PRÓPRIA e independente da
  -- do Bloco 3 (checada antes do early-return abaixo), pra poder ligar/
  -- desligar os dois blocos sem depender um do outro.
  v_suspension_enabled := public.resolve_config_bool('safety_suspension_gate_v1_enabled', v_jurisdiction, false);
  if v_suspension_enabled is true then
    if exists (
      select 1 from public.driver_suspensions
       where driver_id = p_driver_id and lifted_at is null
    ) then
      return false;
    end if;
  end if;

  v_gates_enabled := public.resolve_config_bool('onboarding_gates_v1_enabled', v_jurisdiction, false);
  if v_gates_enabled is distinct from true then
    return true; -- flag do Bloco 3 OFF → preserva o comportamento anterior à 0059
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

-- enforce_driver_online_gating() (0059) já chama driver_can_go_online()
-- incondicionalmente — nenhuma mudança necessária nela; o novo check de
-- suspensão entra "de graça" via create or replace acima.

-- ─── 6) Config (seeds idempotentes) ────────────────────────────────────────

insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'safety_suspension_gate_v1_enabled',
  'global',
  'false'::jsonb,
  'Bloco 4 (compliance TNC F.S. 627.748): liga a ENFORCEMENT de suspensão de tolerância zero em driver_can_go_online() (o registro em driver_suspensions acontece sempre, independente desta flag — só o BLOQUEIO é condicional). Independente de onboarding_gates_v1_enabled (Bloco 3) — pode ser ligada sem o Bloco 3 estar ligado. Desligado por padrão.',
  true
)
on conflict (key, jurisdiction) do nothing;

insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'driver_confirmation_required',
  'global',
  'false'::jsonb,
  'Bloco 4: exige/solicita que o passageiro confirme foto do motorista + placa do veículo antes do embarque (shouldPromptDriverConfirmation/boardingWarning em src/lib/driverBoardingConfirmation.ts). É um PROMPT forte no app do passageiro + aviso não bloqueante no app do motorista, não um bloqueio rígido de rides.boarded_at — ver "DECISÃO DE DESIGN" no topo desta migração. Desligado por padrão.',
  true
)
on conflict (key, jurisdiction) do nothing;

insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'receipt_passenger_v1_enabled',
  'global',
  'false'::jsonb,
  'Bloco 4: mostra ao passageiro o botão de baixar/compartilhar o recibo eletrônico completo da corrida (reaproveita src/lib/waybill.ts + waybillExport.ts, já usados pelo motorista). Desligado por padrão.',
  true
)
on conflict (key, jurisdiction) do nothing;

insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'safety_reports_v1_enabled',
  'global',
  'false'::jsonb,
  'Bloco 4: mostra ao passageiro (tela RateRide) o botão de denúncia de segurança contra o motorista (src/lib/safetyIncidents.ts). O registro em driver_safety_reports e o trigger de suspensão automática de tolerância zero SEMPRE existem no servidor, independente desta flag — ela só controla se a UI de denúncia aparece no app. Desligado por padrão.',
  true
)
on conflict (key, jurisdiction) do nothing;
