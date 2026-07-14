-- =====================================================
-- Go XL — Schema Supabase
-- =====================================================

-- Perfis de usuários (passageiros e motoristas)
create table public.profiles (
  id uuid references auth.users on delete cascade primary key,
  full_name text not null,
  phone text not null,
  email text not null,
  type text not null check (type in ('passenger', 'driver')),
  avatar_url text,
  rating numeric(2,1) default 5.0,
  total_rides integer default 0,
  push_token text,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

create policy "Usuário vê o próprio perfil" on public.profiles
  for select using (auth.uid() = id);

create policy "Usuário atualiza o próprio perfil" on public.profiles
  for update using (auth.uid() = id);

create policy "Usuário cria o próprio perfil" on public.profiles
  for insert with check (auth.uid() = id);

-- A antiga policy "Perfis públicos para leitura" (using (true), qualquer
-- authenticated lia a linha inteira de qualquer usuário) foi REMOVIDA na
-- migration 0050 — leitura de outro usuário passou a ir só por
-- `profiles_public` (colunas não sensíveis) ou por Edge Functions com
-- service_role. A policy "Usuário vê o próprio perfil" acima já cobre o
-- caso de leitura do próprio perfil.

-- Veículos dos motoristas
create table public.vehicles (
  id uuid default gen_random_uuid() primary key,
  driver_id uuid references public.profiles(id) on delete cascade not null,
  model text not null,
  plate text not null,
  color text not null,
  year integer not null,
  photo_url text,
  created_at timestamptz default now()
);

alter table public.vehicles enable row level security;

create policy "Motorista gerencia seu veículo" on public.vehicles
  for all using (auth.uid() = driver_id);

-- Restrita a `authenticated` (ver migration 0048).
create policy "Passageiro vê veículos" on public.vehicles
  for select to authenticated using (true);

-- Localização dos motoristas (realtime)
create table public.driver_locations (
  driver_id uuid references public.profiles(id) on delete cascade primary key,
  lat double precision not null,
  lng double precision not null,
  heading double precision,
  is_online boolean default false,
  updated_at timestamptz default now()
);

alter table public.driver_locations enable row level security;

create policy "Motorista atualiza própria localização" on public.driver_locations
  for all using (auth.uid() = driver_id);

create policy "Passageiro vê motoristas online" on public.driver_locations
  for select using (is_online = true);

-- Corridas
create table public.rides (
  id uuid default gen_random_uuid() primary key,
  passenger_id uuid references public.profiles(id) not null,
  driver_id uuid references public.profiles(id),
  origin_lat double precision not null,
  origin_lng double precision not null,
  origin_address text not null,
  destination_lat double precision not null,
  destination_lng double precision not null,
  destination_address text not null,
  status text not null default 'requesting' check (
    status in ('scheduled','requesting','accepted','driver_en_route','in_progress','completed','cancelled')
  ),
  price numeric(8,2),
  distance_km numeric(6,2),
  duration_min integer,
  scheduled_for timestamptz,
  paid boolean default false,
  created_at timestamptz default now(),
  accepted_at timestamptz,
  completed_at timestamptz
);

alter table public.rides enable row level security;

create policy "Passageiro vê suas corridas" on public.rides
  for select using (auth.uid() = passenger_id);

create policy "Motorista vê corridas disponíveis e suas" on public.rides
  for select using (
    status = 'requesting'
    or (status = 'scheduled' and driver_id is null)
    or auth.uid() = driver_id
    or auth.uid() = passenger_id
  );

create policy "Passageiro cria corrida" on public.rides
  for insert with check (auth.uid() = passenger_id);

create policy "Motorista aceita corrida" on public.rides
  for update using (
    auth.uid() = passenger_id
    or auth.uid() = driver_id
    or (status = 'requesting' and driver_id is null)
    or (status = 'scheduled' and driver_id is null)
  );

-- Avaliações
create table public.ratings (
  id uuid default gen_random_uuid() primary key,
  ride_id uuid references public.rides(id) on delete cascade not null,
  from_user uuid references public.profiles(id) not null,
  to_user uuid references public.profiles(id) not null,
  score integer not null check (score between 1 and 5),
  comment text,
  created_at timestamptz default now(),
  unique(ride_id, from_user)
);

alter table public.ratings enable row level security;

create policy "Usuário cria avaliação" on public.ratings
  for insert with check (auth.uid() = from_user);

create policy "Usuário vê suas avaliações" on public.ratings
  for select using (auth.uid() = from_user or auth.uid() = to_user);

-- Chat entre passageiro e motorista
create table public.messages (
  id uuid default gen_random_uuid() primary key,
  ride_id uuid references public.rides(id) on delete cascade not null,
  sender_id uuid references public.profiles(id) not null,
  text text not null,
  created_at timestamptz default now()
);

alter table public.messages enable row level security;

create policy "Participantes leem mensagens" on public.messages
  for select using (
    exists (
      select 1 from public.rides r
      where r.id = ride_id and (r.passenger_id = auth.uid() or r.driver_id = auth.uid())
    )
  );

create policy "Participantes enviam mensagens" on public.messages
  for insert with check (
    sender_id = auth.uid() and exists (
      select 1 from public.rides r
      where r.id = ride_id and (r.passenger_id = auth.uid() or r.driver_id = auth.uid())
    )
  );

-- View com colunas não sensíveis de profiles (nome, foto, nota, tipo,
-- driver_code), para telas que exibem dados de OUTRO usuário. Ver
-- migration 0049. A policy ampla de profiles (0048) foi removida na
-- migration 0050 — push_token agora só é lido server-side (Edge Function
-- send-ride-push, service_role).
create or replace view public.profiles_public as
select id, full_name, avatar_url, rating, type, driver_code
from public.profiles;

alter view public.profiles_public set (security_invoker = off);
grant select on public.profiles_public to authenticated;

-- Habilitar realtime nas tabelas principais
alter publication supabase_realtime add table public.rides;
alter publication supabase_realtime add table public.driver_locations;
alter publication supabase_realtime add table public.messages;

-- View: corrida com coordenadas como JSON (para facilitar leitura no app)
create or replace view public.rides_with_locations as
select
  r.*,
  json_build_object('lat', r.origin_lat, 'lng', r.origin_lng, 'address', r.origin_address) as origin,
  json_build_object('lat', r.destination_lat, 'lng', r.destination_lng, 'address', r.destination_address) as destination
from public.rides r;

-- security_invoker: a view deve respeitar RLS/permissões de quem consulta,
-- não do criador (corrige o alerta "Security Definer View" do linter).
alter view public.rides_with_locations set (security_invoker = on);
