-- ─────────────────────────────────────────────────────────────────────────────
-- Diagnóstico — "Database error saving new user" no cadastro (SOMENTE LEITURA)
--
-- Sintoma (print do Edson, 2026-07-17): um passageiro novo (Aren Pattoukian,
-- aren.pattoukian@gmail.com) tenta criar a conta e recebe o alerta
--   "Error — Database error saving new user".
--
-- De onde vem essa mensagem: é wording do GoTrue (Supabase Auth). Ela aparece
-- quando o INSERT em `auth.users` FALHA no nível do banco — o app nem chega a
-- inserir em `public.profiles` (isso é um passo POSTERIOR, feito no cliente em
-- src/contexts/AuthContext.tsx → signUp). O auth.users só falha assim quando há
-- um TRIGGER anexado a `auth.users` (tipicamente `handle_new_user`, criado no
-- painel do Supabase e NÃO versionado em supabase/migrations/) que insere em
-- public.profiles e agora bate numa constraint/coluna que mudou.
--
-- Este script NÃO altera nada — só revela o trigger, seu código-fonte e o
-- schema atual de profiles, para sabermos EXATAMENTE o que corrigir.
--
-- Como rodar: Supabase → SQL Editor (logado como você, dono do projeto — roda
-- como service_role e enxerga o schema `auth`). Rode cada bloco e me mande o
-- resultado dos blocos (1) e (2) — são os decisivos.
-- ─────────────────────────────────────────────────────────────────────────────

-- (1) Triggers anexados a auth.users (o culpado quase certo mora aqui).
--     Se aparecer algo tipo `on_auth_user_created` → `handle_new_user`, é ele.
select tgname                      as trigger_name,
       case tgenabled when 'O' then 'enabled' when 'D' then 'DISABLED'
                      when 'R' then 'replica' when 'A' then 'always' end as status,
       pg_get_triggerdef(oid)      as definition
from pg_trigger
where tgrelid = 'auth.users'::regclass
  and not tgisinternal;

-- (2) Código-fonte das funções chamadas por esses triggers. É aqui que veremos
--     qual coluna/constraint de profiles o trigger viola (ex.: insere sem
--     `type`, ou referencia uma coluna que não existe mais).
select n.nspname               as schema,
       p.proname               as function_name,
       pg_get_functiondef(p.oid) as source
from pg_trigger t
join pg_proc      p on p.oid = t.tgfoid
join pg_namespace n on n.oid = p.pronamespace
where t.tgrelid = 'auth.users'::regclass
  and not t.tgisinternal;

-- (3) Schema atual de public.profiles. Uma coluna NOT NULL SEM default que o
--     trigger não preenche = INSERT falha = "Database error saving new user".
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'profiles'
order by ordinal_position;

-- (4) Constraints de profiles (CHECK, NOT NULL, FK). Ex.: profiles_type_check
--     (migration 0043) rejeita type nulo/inválido.
select conname                        as constraint_name,
       pg_get_constraintdef(oid)      as definition
from pg_constraint
where conrelid = 'public.profiles'::regclass
order by conname;

-- (5) Descarta "usuário duplicado": o e-mail já existe em auth.users? Se sim,
--     o erro seria outro ("User already registered"), mas confirmamos aqui.
select id, email, created_at, confirmed_at
from auth.users
where email = 'aren.pattoukian@gmail.com';

-- (6) Bônus: existe alguma linha em profiles com type nulo/inválido? Se o
--     trigger COPIA algo de uma linha assim, pode ser fonte de erro; e é bom
--     saber de qualquer jeito.
select id, full_name, email, type
from public.profiles
where type is null or type not in ('passenger', 'driver');
