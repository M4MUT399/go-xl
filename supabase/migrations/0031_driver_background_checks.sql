-- driver_background_checks — verificação de antecedentes do motorista (P7).
--
-- PRIVACIDADE (regra dura do projeto): NÃO há coluna de SSN nem de PII sensível.
-- O PII é coletado e guardado pelo PROVIDER (ex.: Stripe Identity) no cofre dele;
-- aqui persistimos apenas a REFERÊNCIA TOKENIZADA (`provider_ref`), o status e um
-- resumo NÃO sensível do resultado. Ver src/lib/backgroundCheck.ts.
create table if not exists public.driver_background_checks (
  id           uuid        primary key default gen_random_uuid(),
  driver_id    uuid        not null references public.profiles(id) on delete cascade,
  provider     text        not null default 'mock',
  -- Token de referência do provider (NÃO é PII). Ex.: id da VerificationSession.
  provider_ref text        not null,
  status       text        not null default 'pending',
  -- Resumo NÃO sensível do veredito (ex.: {"checks":["mvr","criminal"]}).
  result       jsonb,
  checked_at   timestamptz,
  expires_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.driver_background_checks
  drop constraint if exists driver_background_checks_status_check;
alter table public.driver_background_checks
  add constraint driver_background_checks_status_check
  check (status in ('not_started', 'pending', 'clear', 'consider', 'failed'));

create index if not exists driver_background_checks_driver_idx
  on public.driver_background_checks (driver_id, created_at desc);

alter table public.driver_background_checks enable row level security;

-- Leitura: o próprio motorista lê seus checks; admins leem todos.
drop policy if exists driver_background_checks_select_own_or_admin on public.driver_background_checks;
create policy driver_background_checks_select_own_or_admin
  on public.driver_background_checks for select
  to authenticated
  using (
    auth.uid() = driver_id
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_admin = true
    )
  );

-- Escrita (insert/update do veredito) é EXCLUSIVA do service_role: quem cria a
-- sessão e processa o webhook do provider é a Edge Function. O motorista NÃO
-- pode inserir/alterar o próprio status (evita auto-aprovação).
drop policy if exists driver_background_checks_service_all on public.driver_background_checks;
create policy driver_background_checks_service_all
  on public.driver_background_checks for all
  to service_role
  using (true)
  with check (true);
