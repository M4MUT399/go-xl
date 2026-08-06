-- ─────────────────────────────────────────────────────────────────────────────
-- URGENTE — corrige "Database error saving new user" no cadastro (2026-07-17).
--
-- SINTOMA: qualquer passageiro/motorista NOVO recebe "Database error saving new
-- user" na tela "Create your account". Bloqueia 100% dos cadastros, em toda
-- versão do app (1.0.1 e 1.0.2).
--
-- CAUSA RAIZ (diagnóstico em supabase/reports/diagnose_signup_failure.sql,
-- blocos 1 e 2): existe um trigger em `auth.users` chamando a função
-- `public.handle_new_user()`, criada pelo PAINEL do Supabase e NUNCA versionada
-- neste repositório. Ela executa, em resumo:
--       insert into profiles (id, email, is_admin) values (new.id, new.email, ...)
-- omitindo as colunas NOT NULL SEM default de `public.profiles`
-- (`full_name`, `phone`, `type`). Como o trigger roda DENTRO da transação do
-- INSERT em auth.users, a violação de NOT NULL aborta a transação inteira e o
-- GoTrue devolve "Database error saving new user".
--
-- POR QUE REMOVER (e não "consertar") O TRIGGER: o app já cria o perfil no
-- CLIENTE, com todos os campos obrigatórios vindos do formulário de cadastro —
-- ver src/contexts/AuthContext.tsx → signUp (passo 2):
--       supabase.from('profiles').insert({ id, full_name, phone, email, type,
--                                           rating, total_rides, language, ... })
-- O trigger do banco era um SEGUNDO gravador de profiles, redundante e quebrado.
-- Mantê-lo (mesmo corrigido) criaria conflito de chave primária (id duplicado)
-- com o insert do cliente. Removê-lo restaura exatamente o comportamento que
-- funcionava ANTES de o trigger ter sido criado no painel: o cliente é a única
-- fonte de criação de perfil.
--
-- SEGURANÇA: `is_admin` não é preenchido pelo insert do cliente — depende do
-- default da coluna (era assim antes do trigger e continua válido). Nada mais
-- do app depende deste trigger.
--
-- Idempotente e independente do nome exato do trigger: descobre e remove
-- qualquer trigger de auth.users cuja função seja `handle_new_user`, e depois
-- remove a função órfã em qualquer schema.
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  r record;
begin
  -- (1) Remove o(s) trigger(s) de auth.users que chamam handle_new_user.
  for r in
    select t.tgname
    from pg_trigger t
    join pg_proc  p on p.oid = t.tgfoid
    where t.tgrelid = 'auth.users'::regclass
      and not t.tgisinternal
      and p.proname = 'handle_new_user'
  loop
    execute format('drop trigger if exists %I on auth.users', r.tgname);
  end loop;

  -- (2) Remove a função órfã (qualquer schema) agora que nada mais a chama.
  for r in
    select p.oid::regprocedure as fn
    from pg_proc      p
    join pg_namespace n on n.oid = p.pronamespace
    where p.proname = 'handle_new_user'
  loop
    execute format('drop function if exists %s', r.fn);
  end loop;
end $$;

-- Verificação pós-fix (deve retornar ZERO linhas):
--   select tgname from pg_trigger
--   where tgrelid = 'auth.users'::regclass and not tgisinternal;
