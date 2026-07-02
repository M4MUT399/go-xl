-- Seeds de configuração das corridas agendadas (P2). Idempotentes.
--
-- Estes valores têm fallback local seguro em src/lib/systemConfig.ts
-- (CONFIG_DEFAULTS), então o app funciona mesmo antes desta migration rodar.
-- Semeá-los aqui os torna visíveis e editáveis no admin, e permite override
-- por jurisdição (ex.: uma linha jurisdiction='US-FL' sobrescreve a 'global').

-- Antecedência (min) com que uma agendada SEM motorista aparece na lista de
-- disponíveis para os motoristas. "Antecedência dinâmica".
insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'scheduled_ride_lead_minutes',
  'global',
  '60'::jsonb,
  'Minutos de antecedência com que uma corrida agendada sem motorista aparece na lista de disponíveis.',
  true
)
on conflict (key, jurisdiction) do nothing;

-- Antecedência (min) com que o banner fixo da agendada JÁ confirmada por mim
-- começa a aparecer no mapa do motorista.
insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'scheduled_ride_banner_minutes',
  'global',
  '120'::jsonb,
  'Minutos de antecedência com que o banner fixo da corrida agendada confirmada aparece para o motorista.',
  true
)
on conflict (key, jurisdiction) do nothing;

-- Antecedência (min) em que a agendada confirmada vira "iminente" — dispara o
-- alerta sonoro e o destaque de urgência no banner.
insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'scheduled_ride_reminder_minutes',
  'global',
  '15'::jsonb,
  'Minutos de antecedência em que a corrida agendada confirmada dispara alerta sonoro para o motorista.',
  true
)
on conflict (key, jurisdiction) do nothing;
