-- =====================================================
-- Go XL — Schema Supabase (SNAPSHOT HISTÓRICO — NÃO EXECUTÁVEL)
-- =====================================================
--
-- PARE. Este arquivo recria quatro buracos de `anon` que as migrations já
-- fecharam. O aviso completo está no RODAPÉ (:268) — e é exatamente esse o
-- problema que o bloco abaixo resolve: um aviso no fim do arquivo só é lido
-- DEPOIS que o dano já foi feito. `psql -f schema.sql` teria criado as quatro
-- policies inseguras antes de chegar à linha 268, e um comentário não tem como
-- abortar uma execução.
--
-- Por isso a PRIMEIRA coisa que o arquivo faz é abortar. São DUAS travas, e a
-- primeira existe porque a segunda, sozinha, NÃO segura o caminho mais provável:
--
--   1. `\gset` + `\if` + `\quit`, meta-comandos do psql. `psql -f schema.sql`
--      SEM `-v ON_ERROR_STOP=1` — que é o padrão — apenas IMPRIME o erro de um
--      `raise exception` e segue para o comando seguinte. Quer dizer: a trava
--      (2) sozinha não impedia nada no modo padrão do psql; as quatro policies
--      abertas eram criadas logo em seguida, exatamente como se o bloco não
--      existisse. `\quit` encerra o psql na hora, sem depender de flag nenhuma.
--
--   2. o `do $$ … raise exception` logo abaixo, para todo caminho que NÃO é
--      psql (SQL Editor do Studio, runner de migrations, driver de aplicação).
--      Lá meta-comando com barra invertida não existe: as linhas do item 1 são
--      erro de sintaxe — o que também interrompe — e quem aborta de fato é a
--      exceção.
--
-- O conteúdo histórico abaixo fica intacto: preservar o registro de como o
-- schema nasceu e impedir que ele seja aplicado não são objetivos em conflito.
--
-- Para bootstrap de um banco novo, use `supabase/migrations/` em ordem:
--     npx supabase db push
--
-- Se você REALMENTE precisa aplicar este snapshot (só faz sentido para
-- reproduzir o estado histórico num banco descartável, nunca em produção),
-- rode antes, na MESMA sessão:
--     set goxl.allow_legacy_schema_sql = 'yes-i-know-this-reopens-anon-holes';
--
-- DESLOCAMENTO DE LINHAS: duas inserções mexeram na numeração. Este cabeçalho
-- acrescentou 67 linhas no topo, e a coluna `driver_code` mais 7 dentro do
-- `create table public.profiles`. Para toda citação `schema.sql:<N>` escrita
-- antes disso (0048, 0065, 0067 e o rodapé): some 67 se o alvo estiver ANTES
-- de profiles, e 74 se estiver DEPOIS. Conferências: `create table
-- public.profiles` era :6 e é :73; a policy "Passageiro cria corrida" era
-- :113 e é :187. A 0067 e a AUDITORIA já foram corrigidas; as demais, não.

select case
         when coalesce(current_setting('goxl.allow_legacy_schema_sql', true), '')
              = 'yes-i-know-this-reopens-anon-holes' then 'on'
         else 'off'
       end as goxl_allow_legacy \gset

\if :goxl_allow_legacy
\else
\echo '*** ABORTADO: supabase/schema.sql e um SNAPSHOT HISTORICO e NAO deve ser aplicado.'
\echo '*** Ele recria as quatro policies/views abertas a anon que as migrations'
\echo '*** 0048/0050/0067 fecharam. Use: npx supabase db push (com supabase/migrations/).'
\quit
\endif

do $$
begin
  if coalesce(current_setting('goxl.allow_legacy_schema_sql', true), '')
     <> 'yes-i-know-this-reopens-anon-holes' then
    raise exception
      'supabase/schema.sql e um SNAPSHOT HISTORICO e NAO deve ser aplicado: ele recria as quatro policies/views abertas a anon que as migrations 0048/0050/0067 fecharam (ver o aviso no rodape deste arquivo). Use "npx supabase db push" com supabase/migrations/. Para aplicar mesmo assim num banco descartavel, defina goxl.allow_legacy_schema_sql.';
  end if;
  raise warning
    'schema.sql aplicado com override: este banco NASCE com os buracos de anon abertos. Aplique supabase/migrations/ INTEIRO em seguida, ou ele fica publicamente legivel.';
end $$;

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
  -- Esta coluna FALTAVA, e a falta tornava o arquivo inexecutável: a view
  -- profiles_public abaixo a seleciona, então nem com o override documentado no
  -- cabeçalho o snapshot chegava ao fim. O lugar dela é aqui e não na 0049,
  -- porque a 0007 já indexa profiles(driver_code) 42 migrations antes — em
  -- produção ela foi criada à mão, fora do controle de migration, e a 0049 é a
  -- regularização tardia. Ver AUDITORIA §4, P1 nº 0.
  driver_code text,
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

-- ─────────────────────────────────────────────────────────────────────────────
-- AVISO — ESTE ARQUIVO NÃO É UMA MIGRATION E NÃO É O ESTADO ATUAL DO BANCO
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `supabase/schema.sql` é um SNAPSHOT HISTÓRICO do schema como ele era no
-- início do projeto. NADA no repositório aplica este arquivo: o pipeline real
-- é `supabase/migrations/`, aplicado em ordem. Este arquivo existe só como
-- documentação de origem.
--
-- ESTE AVISO NÃO É MAIS A ÚNICA PROTEÇÃO. Ele está no RODAPÉ: um `psql -f`
-- criaria os quatro buracos abaixo antes de o parser sequer chegar aqui, e um
-- comentário não aborta execução nenhuma. A guarda de verdade está no TOPO do
-- arquivo: o `\quit` de :58 (que encerra o psql mesmo sem ON_ERROR_STOP=1) e o
-- `do $$` de :61 (que cobre quem não é psql). O texto abaixo continua sendo o
-- registro de O QUE seria recriado.
--
-- CONSEQUÊNCIA PRÁTICA: quem fizer bootstrap de um banco novo SÓ com este
-- arquivo (forçando o override do topo) recria, literalmente, os quatro
-- buracos de `anon` que as migrations fecharam:
--
--   :140-141  policy "Passageiro vê motoristas online" em driver_locations,
--             `for select using (is_online = true)` SEM cláusula `to` — ou
--             seja, vale para `anon` também: a posição em tempo real de todo
--             motorista online, pública.
--
--   :172-178  policy "Motorista vê corridas disponíveis e suas" em rides,
--             SEM cláusula `to` — `anon` lê toda corrida com
--             `status = 'requesting'` (endereços de origem/destino de
--             passageiros reais) e toda `scheduled` sem motorista.
--
--   :183-189  policy "Motorista aceita corrida" em rides, UPDATE SEM cláusula
--             `to` e SEM `with check` — `anon` pode aceitar/alterar corrida
--             alheia, e o `using` não restringe o estado pós-update.
--
--   :243-248  view `public.profiles_public` com `security_invoker = off`, que
--             portanto lê `profiles` com o privilégio do DONO e ignora a RLS
--             da tabela. Com o privilégio default de `anon` no schema
--             `public`, isso é o diretório inteiro do app (incluindo
--             `driver_code`, a credencial de QR) exposto pré-login.
--
-- PORTANTO: depois deste arquivo, `supabase/migrations/` DEVE ser aplicado na
-- íntegra e em ordem. A migration 0067
-- (`0067_close_anon_readable_policies.sql`) é a que fecha exatamente esses
-- quatro pontos.
--
-- POR QUE NÃO CORRIGIMOS ESTE ARQUIVO NO LUGAR: não é porque "mexer aqui
-- deslocaria números de linha citados em outros comentários" — esse motivo é
-- fraco e não justificaria deixar código inseguro escrito. O motivo defensável
-- é que este arquivo NÃO É UMA MIGRATION e nada o aplica: reescrevê-lo
-- produziria um snapshot que nunca existiu, apagando o registro histórico de
-- como o schema realmente nasceu — que é o único valor que ele ainda tem. A
-- correção pertence às migrations, e está lá.
