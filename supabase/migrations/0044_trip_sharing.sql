-- Tarefa 1 — Compartilhar viagem ao vivo com contato de confiança.
--
-- Modelo de segurança:
--  • O link público é um TOKEN opaco e aleatório (gen_random_uuid) — não
--    adivinhável e sem relação com o id da corrida.
--  • A página pública NÃO lê estas tabelas via RLS. Quem serve os dados é a
--    Edge Function `track-trip` (verify_jwt=false) usando service_role, que
--    valida o token + expiração e devolve APENAS campos whitelistados
--    (posição, rota, ETA, motorista+veículo, status). Nunca telefone/e-mail/preço.
--  • Por isso NÃO criamos policy de leitura pública aqui: as policies abaixo
--    servem só ao dono (passageiro) para gerenciar seus próprios shares/contatos.

-- ─── Contatos de confiança ─────────────────────────────────────────────────────
create table if not exists public.trusted_contacts (
  id          uuid default gen_random_uuid() primary key,
  owner_id    uuid references public.profiles(id) on delete cascade not null,
  name        text not null,
  -- Rótulo livre (telefone/e-mail) só para o passageiro reconhecer o contato na
  -- lista. NÃO é usado para envio automático — o envio é sempre pelo share sheet
  -- nativo, escolhido pelo próprio passageiro.
  contact     text,
  created_at  timestamptz default now()
);

alter table public.trusted_contacts enable row level security;

create policy "Dono gerencia seus contatos de confiança"
  on public.trusted_contacts
  for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create index if not exists trusted_contacts_owner_idx
  on public.trusted_contacts (owner_id);

-- ─── Compartilhamentos de viagem ───────────────────────────────────────────────
create table if not exists public.trip_shares (
  id          uuid default gen_random_uuid() primary key,
  token       uuid not null unique default gen_random_uuid(),   -- link público opaco
  ride_id     uuid references public.rides(id) on delete cascade not null,
  created_by  uuid references public.profiles(id) on delete cascade not null,
  contact_id  uuid references public.trusted_contacts(id) on delete set null,
  created_at  timestamptz default now(),
  -- TTL máximo de segurança: mesmo que a corrida não termine "limpo", o link
  -- morre. A Edge Function trata expires_at < now() como inativo.
  expires_at  timestamptz not null,
  -- Parada manual pelo passageiro. Também tratado como inativo pela função.
  revoked_at  timestamptz
);

alter table public.trip_shares enable row level security;

-- Só o dono cria/lê/atualiza os próprios shares pelo app autenticado.
-- (A leitura pública é feita pela Edge Function com service_role, sem RLS.)
create policy "Dono cria compartilhamento da própria corrida"
  on public.trip_shares
  for insert
  with check (auth.uid() = created_by);

create policy "Dono lê seus compartilhamentos"
  on public.trip_shares
  for select
  using (auth.uid() = created_by);

create policy "Dono revoga seus compartilhamentos"
  on public.trip_shares
  for update
  using (auth.uid() = created_by)
  with check (auth.uid() = created_by);

create index if not exists trip_shares_token_idx  on public.trip_shares (token);
create index if not exists trip_shares_ride_idx    on public.trip_shares (ride_id);
create index if not exists trip_shares_creator_idx on public.trip_shares (created_by);

-- ─── Preferência de compartilhamento automático ────────────────────────────────
-- Quando ON, o app cria o link automaticamente ao iniciar a corrida e oferece,
-- em um toque, abrir o share sheet para o contato escolhido. NUNCA envia sozinho
-- (o share sheet exige a ação do passageiro), respeitando a regra de envio.
alter table public.profiles
  add column if not exists trip_autoshare            boolean not null default false,
  add column if not exists trip_autoshare_contact_id uuid references public.trusted_contacts(id) on delete set null;
