-- Seeds de configuração de pedágio (P5). Idempotentes.
--
-- Fallback local seguro em src/lib/systemConfig.ts (CONFIG_DEFAULTS): o app
-- funciona antes desta migration e mantém pedágio = 0 até o admin habilitar.
-- Semear aqui torna a feature visível/editável no admin e permite override por
-- jurisdição (ex.: jurisdiction='US-FL' sobrescreve a 'global').

-- Liga/desliga a cobrança de pedágio no preço. Desligado por padrão.
insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'tolls_enabled',
  'global',
  'false'::jsonb,
  'Liga a estimativa de pedágio no preço da corrida. Desligado preserva o preço atual.',
  true
)
on conflict (key, jurisdiction) do nothing;

-- Qual provider de pedágio usar: 'mock' (determinístico) ou 'google' (stub).
insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'toll_provider',
  'global',
  '"mock"'::jsonb,
  'Provider de pedágio: mock (flat + perKm) ou google (Routes API, futuro).',
  false
)
on conflict (key, jurisdiction) do nothing;

-- Taxa fixa (USD) do provider mock quando o pedágio está habilitado.
insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'mock_toll_flat',
  'global',
  '0'::jsonb,
  'Provider mock: taxa fixa de pedágio em USD somada à corrida.',
  false
)
on conflict (key, jurisdiction) do nothing;

-- Taxa por km (USD) do provider mock quando o pedágio está habilitado.
insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'mock_toll_per_km',
  'global',
  '0'::jsonb,
  'Provider mock: taxa de pedágio por km em USD.',
  false
)
on conflict (key, jurisdiction) do nothing;
