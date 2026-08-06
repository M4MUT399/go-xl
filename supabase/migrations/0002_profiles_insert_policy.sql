-- Permite que o usuário autenticado crie o próprio perfil no cadastro.
-- Sem esta política, o insert em profiles é bloqueado pelo RLS e o
-- perfil (nome, telefone, tipo) nunca é gravado.
create policy "Usuário cria o próprio perfil" on public.profiles
  for insert with check (auth.uid() = id);
