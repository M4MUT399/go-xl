-- ═════════════════════════════════════════════════════════════════════════════
-- VERIFICAÇÃO DO ESTADO FINAL — o build prova o resultado, não só a ausência de erro
-- ═════════════════════════════════════════════════════════════════════════════
--
-- "As 72 migrations aplicaram sem erro" e "o banco está no estado pretendido"
-- são afirmações diferentes. Uma migration pode aplicar limpo e não surtir
-- efeito nenhum — foi exatamente o que a 0012 fez por anos. Este arquivo fecha
-- essa distância: cada asserção abaixo é uma afirmação do relatório de auditoria
-- que passa a ser conferida por máquina a cada build.
--
-- O QUE ELE NÃO PROVA — leia antes de citar qualquer coisa daqui:
--
--   · Nada sobre produção. Este é um banco descartável construído do repositório.
--   · Nada sobre pg_cron ou pg_net: as asserções de cron abaixo conferem que o
--     AGENDAMENTO FOI REGISTRADO no dublê do bootstrap, não que ele dispara.
--     Se o job roda em produção, e com que versão de pg_cron, segue NÃO MEDIDO.
--   · Nada sobre o GoTrue, o Vault de verdade, ou a existência dos segredos.

do $$
declare
  v_faltando text;
  v_bad      text;
  v_n        integer;
  v_opts     text[];
begin
  -- ── 1. As tabelas base existem ───────────────────────────────────────────
  -- Parece óbvio e não é: nenhuma das 72 migrations cria `profiles` ou `rides`.
  -- Elas só existem se a baseline tiver sido aplicada. Esta asserção é o que
  -- transforma "esqueci a baseline" em erro, em vez de 60 falhas em cascata.
  select string_agg(t, ', ') into v_faltando
    from unnest(array['profiles', 'rides', 'driver_locations', 'messages']) as t
   where to_regclass('public.' || t) is null;

  if v_faltando is not null then
    raise exception 'verificação: tabelas base ausentes: %', v_faltando;
  end if;

  -- ── 2. RLS ligada em toda tabela base ────────────────────────────────────
  select string_agg(c.relname, ', ') into v_bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('profiles', 'rides', 'driver_locations', 'messages')
     and c.relrowsecurity = false;

  if v_bad is not null then
    raise exception 'verificação: RLS desligada em: %', v_bad;
  end if;

  -- ── 3. P0-11 — nenhuma policy de rides/driver_locations em {public} ──────
  select string_agg(format('%s.%s (%s)', tablename, policyname, cmd), ', ') into v_bad
    from pg_policies
   where schemaname = 'public'
     and tablename in ('rides', 'driver_locations')
     and 'public' = any(roles);

  if v_bad is not null then
    raise exception 'verificação: P0-11 regrediu — policies em {public}: %', v_bad;
  end if;

  -- ── 4. P0-12 — a view expõe TODAS as colunas de rides ────────────────────
  select string_agg(column_name, ', ') into v_faltando
    from information_schema.columns
   where table_schema = 'public' and table_name = 'rides'
     and column_name not in (
       select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'rides_with_locations'
     );

  if v_faltando is not null then
    raise exception 'verificação: P0-12 regrediu — rides_with_locations não expõe: %', v_faltando;
  end if;

  -- ── 5. …e continua respeitando a RLS de quem consulta ────────────────────
  -- Sem security_invoker a view roda com privilégio do dono e passa por cima da
  -- RLS de `rides`. É o defeito que a 0036 consertou, e recriar a view apaga a
  -- propriedade — então esta asserção guarda a 0072 contra si mesma.
  select c.reloptions into v_opts
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'rides_with_locations';

  if v_opts is null or not ('security_invoker=on' = any(v_opts)) then
    raise exception 'verificação: rides_with_locations sem security_invoker — passaria por cima da RLS';
  end if;

  -- ── 6. anon não alcança corrida nem diretório de usuário ─────────────────
  -- `to_regrole` devolve NULL em vez de erro se o papel não existir, então em
  -- Postgres puro fora do Supabase o check se auto-ignora.
  if to_regrole('anon') is not null then
    select string_agg(v, ', ') into v_bad
      from unnest(array['public.rides_with_locations', 'public.profiles_public']) as v
     where to_regclass(v) is not null
       and has_table_privilege('anon', v, 'SELECT');

    if v_bad is not null then
      raise exception 'verificação: anon ainda tem SELECT em: %', v_bad;
    end if;
  end if;

  -- ── 7. Nenhuma view de public aceita escrita de anon/authenticated ──────
  -- P0-13: `profiles_public` é `security_invoker = off`, então escrever por ela
  -- roda com o privilégio do dono e passa por cima da RLS. O default privilege
  -- do Supabase faz TODA view nova nascer com ALL — esta asserção é o que
  -- transforma isso em falha de build em vez de buraco silencioso.
  select string_agg(format('%s (%s para %s)', g.table_name, g.privilege_type, g.grantee), ', ')
    into v_bad
    from information_schema.role_table_grants g
    join pg_class c     on c.relname = g.table_name
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
   where g.table_schema = 'public'
     and c.relkind in ('v', 'm')
     and g.grantee in ('anon', 'authenticated')
     and g.privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE');

  if v_bad is not null then
    raise exception 'verificação: P0-13 regrediu — view com escrita exposta: %', v_bad;
  end if;

  -- ── 8. `anon` não executa função nenhuma de public ──────────────────────
  -- A linha irmã do default privilege, agora sobre FUNÇÕES. Isto é a segunda
  -- tranca da 0075: mesmo que a guarda de alguma RPC volte ao formato que se
  -- auto-desliga sem JWT, quem não tem sessão não alcança a função.
  --
  -- Ela mora aqui, e não na 98, de propósito: com a guarda correta o ataque
  -- falha mesmo COM o privilégio, então nenhuma sonda de comportamento
  -- consegue enxergar o privilégio sobrando. Invariante de forma se confere
  -- por forma.
  if to_regrole('anon') is not null then
    select string_agg(p.oid::regprocedure::text, ', ') into v_bad
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
       and pg_get_function_result(p.oid) <> 'trigger'
       and has_function_privilege('anon', p.oid, 'EXECUTE');

    if v_bad is not null then
      raise exception 'verificação: anon executa RPC de public: %. Revogar só de `anon` não basta: o Postgres dá EXECUTE ao PUBLIC em toda função nova — use `revoke execute on function <f> from public, anon`.', v_bad;
    end if;
  end if;

  -- ── 9. Nenhuma guarda que se auto-desliga quando auth.uid() é NULL ──────
  -- O formato `auth.uid() is not null and auth.uid() <> ...` protege o usuário
  -- logado e libera quem não fez login. Ver 0075.
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and pg_get_functiondef(p.oid) ~* 'auth\.uid\(\)\s+is\s+not\s+null\s+and';

  if v_bad is not null then
    raise exception 'verificação: guarda que se auto-desliga com uid nulo em: %', v_bad;
  end if;

  -- ── 10. Os agendamentos foram REGISTRADOS (não: disparam) ───────────────
  select count(*) into v_n from cron.job;
  if v_n = 0 then
    raise exception 'verificação: nenhum agendamento registrado — o tick do despacho não existiria';
  end if;

  raise notice 'verificação: estado final OK (% agendamentos registrados no dublê de cron).', v_n;
end $$;
