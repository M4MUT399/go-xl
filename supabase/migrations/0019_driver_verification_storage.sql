-- Bucket privado para selfie + documento de verificação do motorista.
-- Diferente de "avatars" (público), aqui o acesso é restrito: o motorista só
-- vê/escreve a própria pasta; a equipe de admin acessa via Edge Function com
-- service_role, que gera signed URLs de curta duração — o arquivo nunca fica
-- acessível por URL pública direta.
insert into storage.buckets (id, name, public)
values ('driver-verification', 'driver-verification', false)
on conflict (id) do nothing;

drop policy if exists "Motorista envia a própria verificação" on storage.objects;
create policy "Motorista envia a própria verificação"
  on storage.objects for insert
  with check (
    bucket_id = 'driver-verification'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Motorista substitui a própria verificação" on storage.objects;
create policy "Motorista substitui a própria verificação"
  on storage.objects for update
  using (
    bucket_id = 'driver-verification'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Motorista vê a própria verificação" on storage.objects;
create policy "Motorista vê a própria verificação"
  on storage.objects for select
  using (
    bucket_id = 'driver-verification'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
