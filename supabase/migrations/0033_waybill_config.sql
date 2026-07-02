-- Seed de configuração do waybill / carta de porte (P4). Idempotente.
--
-- Nada de dado legal "chumbado": os campos da empresa vêm VAZIOS e devem ser
-- preenchidos pelo admin conforme a jurisdição. Desligado por padrão → nenhum
-- comportamento novo até habilitar. Configurável por jurisdição.

-- Liga a geração/exibição do waybill por viagem.
insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'waybill_enabled',
  'global',
  'false'::jsonb,
  'Se true, o app gera o waybill/recibo legal por viagem.',
  true
)
on conflict (key, jurisdiction) do nothing;

-- Razão social da empresa (aparece no cabeçalho do waybill).
insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'company_legal_name',
  'global',
  '""'::jsonb,
  'Razão social da empresa exibida no waybill. Definir por jurisdição.',
  true
)
on conflict (key, jurisdiction) do nothing;

-- Número de licença/registro da empresa (ex.: TNC/PUC), exibido no waybill.
insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'company_license_number',
  'global',
  '""'::jsonb,
  'Número de licença/registro da empresa exibido no waybill. Definir por jurisdição.',
  true
)
on conflict (key, jurisdiction) do nothing;

-- Nota legal de rodapé (texto livre por jurisdição).
insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'waybill_footer_note',
  'global',
  '""'::jsonb,
  'Texto legal de rodapé do waybill (disclaimers por jurisdição).',
  true
)
on conflict (key, jurisdiction) do nothing;
