-- Bootstrap de compatibilidade Supabase para um Postgres LOCAL e DESCARTÁVEL.
--
-- Um Postgres puro não tem NADA do que as migrations do GoXL usam: `auth.uid()`
-- aparece 166 vezes, `storage.objects` 20, `cron.schedule` 10, `net.http_post` 6
-- e `vault.decrypted_secrets` 4. Sem estes objetos as migrations não chegam nem
-- a ser lidas — falham no parser.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- LEIA ISTO ANTES DE CITAR QUALQUER RESULTADO DESTE BANCO
-- ─────────────────────────────────────────────────────────────────────────────
-- Isto é um DUBLÊ, não o Supabase. Ele foi feito para responder UMA pergunta:
-- "este SQL executa, e as constraints/triggers/RLS que ele declara se comportam
-- como escrito?". Ele NÃO responde "o Supabase de produção se comporta assim".
--
-- O que este dublê NÃO prova, e continua NÃO VERIFICADO:
--
--   1. Qual versão do pg_cron está instalada em produção. `cron.schedule` aqui
--      é uma função nossa. Ela VALIDA o agendamento contra a gramática do
--      pg_cron 1.5+ (ver `cron.__validate_schedule`) justamente para não
--      fabricar um "passou" na pergunta em aberto do relatório — mas validar
--      contra o contrato documentado do 1.5 não é o mesmo que o servidor de
--      produção aceitar. Se lá roda pg_cron 1.4, `'10 seconds'` é REJEITADO e
--      o tick do despacho nunca acontece. Isso só o console do Supabase diz.
--
--   2. Que o agendamento realmente DISPARA. Nada aqui roda em background: a
--      tabela `cron.job` guarda a intenção, e ninguém a executa. Job agendado
--      neste banco é uma linha, não um relógio.
--
--   3. Que a chamada HTTP sai. `net.http_post` aqui só registra a intenção em
--      `net.__calls`. Nenhum pacote deixa a máquina — o que também é uma
--      proteção: um shim que fizesse a chamada de verdade postaria numa Edge
--      Function de PRODUÇÃO durante um teste.
--
--   4. Que o segredo existe no Vault. Aqui `vault.secrets` guarda texto puro e
--      `decrypted_secrets` só o devolve. Em produção o segredo é cifrado pelo
--      pgsodium E PODE SIMPLESMENTE NÃO EXISTIR — que é a outra metade da
--      pendência do despacho.
--
--   5. Nada sobre o GoTrue. `auth.users` aqui é uma tabela mínima; não há
--      cadastro, e-mail, refresh token nem trigger de signup.
--
-- O que ele PROVA de verdade: sintaxe, dependência entre objetos, ordem das
-- migrations, constraint, índice único, trigger em plpgsql, e política de RLS
-- exercitada com `set local role` + `request.jwt.claims`.

-- ─── Papéis do Supabase ──────────────────────────────────────────────────────
-- `nologin` de propósito: aqui eles são alvo de `set local role`, não contas.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator noinherit login password 'postgres';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin nologin noinherit;
  end if;
end $$;

grant anon, authenticated, service_role to authenticator;
grant anon, authenticated, service_role to postgres;

create schema if not exists auth;
create schema if not exists storage;
create schema if not exists extensions;
create schema if not exists vault;
create schema if not exists cron;
create schema if not exists net;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth, storage to anon, authenticated, service_role;

-- Extensões que o Supabase entrega prontas.
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
grant execute on all functions in schema extensions to anon, authenticated, service_role;

-- ─── auth ────────────────────────────────────────────────────────────────────
-- Mesma forma das funções do Supabase: leem o claim do JWT de um GUC da
-- sessão. É isso que permite testar RLS — `set local request.jwt.claims` faz o
-- papel do token que o PostgREST injetaria.
create table if not exists auth.users (
  id uuid primary key default extensions.gen_random_uuid(),
  email text unique,
  phone text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  raw_app_meta_data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create or replace function auth.jwt() returns jsonb
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), ''),
    '{}'
  )::jsonb;
$$;

create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid;
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(nullif(auth.jwt() ->> 'role', ''), current_setting('role', true));
$$;

create or replace function auth.email() returns text
language sql stable as $$
  select nullif(auth.jwt() ->> 'email', '');
$$;

grant execute on function auth.jwt(), auth.uid(), auth.role(), auth.email()
  to anon, authenticated, service_role;
grant select on auth.users to service_role;

-- ─── storage ─────────────────────────────────────────────────────────────────
create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  owner uuid,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz not null default now()
);

create table if not exists storage.objects (
  id uuid primary key default extensions.gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text,
  owner uuid,
  metadata jsonb,
  path_tokens text[] generated always as (string_to_array(name, '/')) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;

-- Idêntica à do Supabase: quebra o caminho e devolve TUDO menos o nome do
-- arquivo, e é por isso que `(storage.foldername(name))[1]` é o primeiro
-- diretório.
create or replace function storage.foldername(name text) returns text[]
language plpgsql immutable as $$
declare
  parts text[];
begin
  parts := string_to_array(name, '/');
  return parts[1 : array_length(parts, 1) - 1];
end $$;

create or replace function storage.filename(name text) returns text
language plpgsql immutable as $$
declare
  parts text[];
begin
  parts := string_to_array(name, '/');
  return parts[array_length(parts, 1)];
end $$;

create or replace function storage.extension(name text) returns text
language plpgsql immutable as $$
declare
  parts text[];
begin
  parts := string_to_array(storage.filename(name), '.');
  return parts[array_length(parts, 1)];
end $$;

grant all on storage.objects, storage.buckets to anon, authenticated, service_role;
grant execute on all functions in schema storage to anon, authenticated, service_role;

-- ─── vault ───────────────────────────────────────────────────────────────────
-- TEXTO PURO. Em produção isto é pgsodium. Aqui só existe para o SQL das
-- migrations resolver o nome — e para deixar visível que "o segredo existe" é
-- uma suposição, não um fato verificado.
create table if not exists vault.secrets (
  id uuid primary key default extensions.gen_random_uuid(),
  name text unique,
  description text not null default '',
  secret text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace view vault.decrypted_secrets as
  select id, name, description, secret, secret as decrypted_secret, created_at, updated_at
    from vault.secrets;

-- ─── pg_net (dublê) ──────────────────────────────────────────────────────────
-- Registra a intenção. NÃO faz rede: um shim que fizesse a chamada de verdade
-- bateria numa Edge Function de produção no meio de um teste.
create table if not exists net.__calls (
  id bigserial primary key,
  method text not null,
  url text not null,
  headers jsonb,
  body jsonb,
  timeout_milliseconds int,
  called_at timestamptz not null default now()
);

create or replace function net.http_post(
  url text,
  body jsonb default '{}'::jsonb,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb,
  timeout_milliseconds int default 5000
) returns bigint
language plpgsql as $$
declare
  novo bigint;
begin
  insert into net.__calls (method, url, headers, body, timeout_milliseconds)
  values ('POST', url, headers, body, timeout_milliseconds)
  returning id into novo;
  return novo;
end $$;

create or replace function net.http_get(
  url text,
  params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb,
  timeout_milliseconds int default 5000
) returns bigint
language plpgsql as $$
declare
  novo bigint;
begin
  insert into net.__calls (method, url, headers, body, timeout_milliseconds)
  values ('GET', url, headers, null, timeout_milliseconds)
  returning id into novo;
  return novo;
end $$;

create table if not exists net._http_response (
  id bigint primary key,
  status_code int,
  content_type text,
  headers jsonb,
  content text,
  timed_out boolean,
  error_msg text,
  created timestamptz not null default now()
);

-- ─── pg_cron (dublê COM validação) ───────────────────────────────────────────
create table if not exists cron.job (
  jobid bigserial primary key,
  schedule text not null,
  command text not null,
  nodename text not null default 'localhost',
  nodeport int not null default 5432,
  database text not null default current_database(),
  username text not null default current_user,
  active boolean not null default true,
  jobname text unique
);

create table if not exists cron.job_run_details (
  jobid bigint,
  runid bigserial primary key,
  job_pid int,
  database text,
  username text,
  command text,
  status text,
  return_message text,
  start_time timestamptz,
  end_time timestamptz
);

/*
 * A parte que mais importa deste arquivo.
 *
 * Um shim preguiçoso aceitaria qualquer string e faria a migration 0071 passar
 * — inventando exatamente a resposta que o relatório marca como pendente. Esta
 * função recusa o que o pg_cron recusaria, seguindo a gramática DOCUMENTADA:
 *
 *   - 5 campos de cron clássico;
 *   - `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`, `@annually`;
 *   - `N seconds` (1..59) — SOMENTE a partir do pg_cron 1.5.
 *
 * O último item é o ponto: aqui ele é aceito. Em produção depende da versão
 * instalada, que ninguém verificou. Aceitar aqui prova que NOSSO SQL está de
 * acordo com o contrato do 1.5+; não prova qual servidor está do outro lado.
 */
create or replace function cron.__validate_schedule(agenda text) returns void
language plpgsql as $$
declare
  segundos int;
begin
  if agenda ~ '^@(hourly|daily|weekly|monthly|yearly|annually|reboot)$' then
    return;
  end if;

  if agenda ~* '^\s*([0-9]+)\s+seconds?\s*$' then
    segundos := (regexp_match(agenda, '^\s*([0-9]+)', 'i'))[1]::int;
    if segundos between 1 and 59 then
      return;
    end if;
    raise exception
      'cron.schedule: intervalo em segundos fora da faixa aceita pelo pg_cron (1..59): %', agenda;
  end if;

  if array_length(regexp_split_to_array(btrim(agenda), '\s+'), 1) = 5 then
    return;
  end if;

  raise exception 'cron.schedule: agendamento invalido: %', agenda;
end $$;

create or replace function cron.schedule(job_name text, schedule text, command text)
returns bigint
language plpgsql as $$
declare
  novo bigint;
begin
  perform cron.__validate_schedule(schedule);
  insert into cron.job (jobname, schedule, command)
       values (job_name, schedule, command)
  on conflict (jobname) do update
          set schedule = excluded.schedule,
              command  = excluded.command,
              active   = true
    returning jobid into novo;
  return novo;
end $$;

create or replace function cron.schedule(schedule text, command text)
returns bigint
language plpgsql as $$
declare
  novo bigint;
begin
  perform cron.__validate_schedule(schedule);
  insert into cron.job (jobname, schedule, command)
       values ('job-' || nextval('cron.job_jobid_seq'), schedule, command)
    returning jobid into novo;
  return novo;
end $$;

create or replace function cron.unschedule(job_name text) returns boolean
language plpgsql as $$
declare
  removidos int;
begin
  delete from cron.job where jobname = job_name;
  get diagnostics removidos = row_count;
  return removidos > 0;
end $$;

create or replace function cron.unschedule(job_id bigint) returns boolean
language plpgsql as $$
declare
  removidos int;
begin
  delete from cron.job where jobid = job_id;
  get diagnostics removidos = row_count;
  return removidos > 0;
end $$;

-- `create extension if not exists pg_cron` / `pg_net` aparecem nas migrations e
-- em Postgres puro falhariam por extensão inexistente. Não há como interceptar
-- `create extension` sem event trigger em DDL de extensão — o runner remove
-- essas linhas e ANOTA cada remoção, para nenhuma sumir em silêncio.

-- ─── Publicação do Realtime ──────────────────────────────────────────────────
-- O Supabase já entrega `supabase_realtime` criada e vazia; as migrations só
-- fazem `alter publication ... add table`. Criar aqui é reproduzir o ambiente,
-- não remendar defeito. O que continua NÃO verificado é se o Realtime de fato
-- entrega o evento — publicação é só o lado do Postgres.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;

-- ─── Privilégios padrão do Supabase no schema public ─────────────────────────
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
