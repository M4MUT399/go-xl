-- 0016_photos_and_language.sql
-- Suporte a: idioma preferido do usuário e foto de perfil (avatar).

-- 1) Colunas novas ----------------------------------------------------------
alter table public.profiles
  add column if not exists language text not null default 'en';

-- avatar_url já pode existir; garante a coluna
alter table public.profiles
  add column if not exists avatar_url text;

-- 2) Buckets de Storage -----------------------------------------------------
-- Cria o bucket público 'avatars' (idempotente).
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- 3) Políticas de Storage ---------------------------------------------------
-- Leitura pública (necessária para exibir as imagens no app).
drop policy if exists "Public read avatars" on storage.objects;
create policy "Public read avatars"
  on storage.objects for select
  using (bucket_id = 'avatars');

-- Upload/atualização/remoção apenas pelo dono (pasta = id do usuário).
drop policy if exists "Users manage own avatars" on storage.objects;
create policy "Users manage own avatars"
  on storage.objects for all
  to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
