-- Seeds de configuração do background check (P7). Idempotentes.
--
-- Fallback local seguro em src/lib/systemConfig.ts (CONFIG_DEFAULTS): o app
-- funciona antes desta migration. Desligado por padrão → o gate de ficar online
-- não muda. Configurável por jurisdição (ex.: 'US-FL' sobrescreve a 'global').

-- Exige background check aprovado para o motorista ficar online.
insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'background_check_required',
  'global',
  'false'::jsonb,
  'Se true, o motorista só fica online com background check aprovado e válido.',
  true
)
on conflict (key, jurisdiction) do nothing;

-- Provider de background check: 'mock' ou 'stripe_identity' (futuro).
insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'background_check_provider',
  'global',
  '"mock"'::jsonb,
  'Provider de background check: mock (determinístico) ou stripe_identity.',
  false
)
on conflict (key, jurisdiction) do nothing;

-- Validade (dias) de um check aprovado antes de exigir renovação.
insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'background_check_valid_days',
  'global',
  '365'::jsonb,
  'Dias de validade de um background check aprovado antes de renovar.',
  true
)
on conflict (key, jurisdiction) do nothing;
