-- Contato de emergência do passageiro/motorista, editável na tela de perfil.
alter table public.profiles
  add column if not exists emergency_contact_name  text,
  add column if not exists emergency_contact_phone text;
