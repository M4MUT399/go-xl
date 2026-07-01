-- system_config — configuração dinâmica do backend, editável pelo admin sem
-- novo deploy do app. Serve de fonte da verdade para valores que a legislação,
-- a operação ou o produto precisam ajustar por cidade/estado/jurisdição:
-- timeout da chamada de corrida, antecedência de lembretes, limites de direção,
-- fees de aeroporto/porto, feature flags de providers (tolls, background check), etc.
--
-- Modelo chave/valor com override por jurisdição:
--   (key, jurisdiction) é único. 'global' é o padrão; uma linha com a mesma key
--   e jurisdiction='US-FL' sobrescreve o global para a Flórida. O app resolve
--   sempre "jurisdição específica → global" (ver src/lib/systemConfig.ts).
create table if not exists public.system_config (
  key          text        not null,
  jurisdiction text        not null default 'global',
  value        jsonb       not null,
  description  text,
  -- Config pública pode ser lida por qualquer usuário autenticado (ex.: timeout
  -- da chamada). Config sensível (chaves de provider, regras internas) fica
  -- is_public=false e só é acessível via service_role nas Edge Functions.
  is_public    boolean     not null default true,
  updated_at   timestamptz not null default now(),
  updated_by   uuid        references public.profiles(id),
  primary key (key, jurisdiction)
);

alter table public.system_config enable row level security;

-- Leitura: qualquer autenticado lê apenas as chaves públicas.
drop policy if exists system_config_read_public on public.system_config;
create policy system_config_read_public
  on public.system_config for select
  to authenticated
  using (is_public = true);

-- Escrita: exclusivamente via service_role (Edge Functions / admin). Nenhum
-- usuário comum pode inserir/alterar/remover configuração.
drop policy if exists system_config_admin_write on public.system_config;
create policy system_config_admin_write
  on public.system_config for all
  to service_role
  using (true)
  with check (true);

-- ─── Seeds padrão (idempotentes) ────────────────────────────────────────────
-- Valores iniciais seguros. O admin pode editá-los depois sem novo deploy.

-- Timeout da chamada de corrida (P1): por quanto tempo o overlay de chamada
-- fica na tela tocando o som antes de expirar automaticamente. Default 30s.
insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'ride_offer_timeout_seconds',
  'global',
  '30'::jsonb,
  'Segundos que a tela de chamada de corrida toca antes de expirar automaticamente.',
  true
)
on conflict (key, jurisdiction) do nothing;
