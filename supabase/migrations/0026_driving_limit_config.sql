-- Seeds de configuração do limite de direção (P3). Idempotentes.
--
-- Fallback local seguro em src/lib/systemConfig.ts (CONFIG_DEFAULTS): o app
-- funciona antes desta migration. Semear aqui torna as regras visíveis e
-- editáveis no admin e permite override por jurisdição (ex.: jurisdiction=
-- 'US-FL' sobrescreve a 'global').

-- Horas de direção acumuladas que exigem descanso obrigatório.
insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'driving_limit_hours',
  'global',
  '12'::jsonb,
  'Horas de direção acumuladas que exigem descanso obrigatório antes de voltar a dirigir.',
  true
)
on conflict (key, jurisdiction) do nothing;

-- Horas de descanso contínuo que zeram o acúmulo de direção.
insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'rest_required_hours',
  'global',
  '6'::jsonb,
  'Horas de descanso contínuo necessárias para zerar o acúmulo de direção.',
  true
)
on conflict (key, jurisdiction) do nothing;

-- Antecedência (min) do limite em que o motorista começa a ser avisado.
insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'driving_warn_minutes',
  'global',
  '30'::jsonb,
  'Minutos antes de atingir o limite de direção em que o motorista começa a ser avisado.',
  true
)
on conflict (key, jurisdiction) do nothing;
