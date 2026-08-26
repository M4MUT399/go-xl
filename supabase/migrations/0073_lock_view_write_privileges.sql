-- ═════════════════════════════════════════════════════════════════════════════
-- 0073 — `profiles_public` era GRAVÁVEL e APAGÁVEL por qualquer conta logada
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Descoberto ATACANDO o banco construído, não lendo o repositório. Doze rodadas
-- de crítica leram estas policies e aprovaram; o ataque levou uma tentativa.
-- A diferença não é esperteza: é que `pg_policies` mostra a FORMA da regra e o
-- ataque mostra o EFEITO dela. Foi a mesma distância que deixou a 0012 aplicar
-- limpo por anos sem surtir efeito (P0-12).
--
-- ── O ATAQUE, como foi rodado ────────────────────────────────────────────────
--
-- Bob é uma conta comum de PASSAGEIRO. Nada de admin, nada de service_role —
-- só um login normal do Cadastro Expresso, que é grátis e não verificado.
--
--     set local request.jwt.claims = '{"sub":"<bob>","role":"authenticated"}';
--     set local role authenticated;
--
--     select * from public.profiles where id = '<alice>';
--       -> 0 linhas.  A RLS de `profiles` funciona. É o controle.
--
--     update public.profiles_public set full_name = 'INVADIDO' where id = '<alice>';
--       -> 1 linha.  Escreveu no perfil de outra pessoa.
--     update public.profiles_public set rating = 1.0 where id = '<alice>';
--       -> 1 linha.  Nota de motorista para 1.0, em qualquer motorista.
--     delete from public.profiles_public where id = '<alice>';
--       -> 1 linha.  A conta da vítima deixou de existir.
--
-- Isto é alcançável do aplicativo. O PostgREST publica view como endpoint, e
-- quem tem o privilégio escreve por ela: `DELETE /rest/v1/profiles_public?id=eq.<x>`
-- com a anon key pública e QUALQUER sessão logada. Não precisa de exploit.
--
-- ── O QUE SALVOU O QUE SOBROU, e por acidente ────────────────────────────────
--
-- Duas coisas seguraram o estrago, e nenhuma delas foi desenhada para isto:
--
--   · `type` NÃO muda — o trigger `guard_profile_privileged_fields` reverte.
--     Ele foi escrito para outro fim (impedir autopromoção a motorista) e por
--     sorte cobre esta porta também. `full_name`, `avatar_url` e `rating` não
--     têm trigger nenhum e passam.
--   · O DELETE falha com 23503 se a vítima TIVER corrida — a FK
--     `rides_passenger_id_fkey` recusa. Quem não tem corrida ainda é apagável:
--     cadastro recém-feito, e motorista aprovado que ainda não rodou. Ou seja,
--     a proteção é "já usou o produto", que é exatamente ao contrário do que se
--     quer proteger.
--
-- Depender de trigger alheio e de FK para conter escrita indevida é depender de
-- efeito colateral. É o mesmo argumento da 0067: declarar o privilégio não
-- depende de expressão nenhuma.
--
-- ── O MECANISMO, e por que a 0069 quase o pegou ──────────────────────────────
--
-- Três fatos que só juntos produzem o buraco:
--
--   1. `alter default privileges in schema public grant all on tables ...` — o
--      padrão do Supabase. View nasce com ALL para anon/authenticated.
--   2. `security_invoker = off` em `profiles_public` (0049:43, 0069:97). É DE
--      PROPÓSITO e continua certo: a RLS de `profiles` só deixa cada um ler a
--      própria linha, então sem isto a view não teria função. O efeito colateral
--      é que TODO acesso pela view roda com o privilégio do dono — e o dono é
--      `postgres`, que não está sob `force row level security`. Vale para
--      leitura e vale, sem aviso, para ESCRITA.
--   3. A view é auto-atualizável: `select <colunas simples> from profiles`, um
--      único FROM, sem distinct/group by. `pg_relation_is_updatable` devolve 28
--      — INSERT, UPDATE e DELETE, todos passam para a tabela base.
--
-- A 0069 enxergou o fato 1 e escreveu, textualmente (0069:98-101):
--
--     "Ordem importa: a view acabou de nascer, então o default privilege do
--      schema `public` já concedeu SELECT a `anon`. Revogar é obrigatório —
--      sem esta linha, a 0069 REABRIRIA o buraco que a 0067 fechou."
--
-- O raciocínio está certo e foi aplicado pela METADE, duas vezes: só ao papel
-- `anon`, e só ao privilégio `SELECT`. O default privilege concede ALL, não
-- SELECT; e `authenticated` recebe o mesmo que `anon`. `revoke all from anon`
-- seguido de `grant select to authenticated` deixa authenticated com tudo o que
-- já tinha — `grant` não tira nada.
--
-- ── POR QUE O CONSERTO É PRIVILÉGIO, E NÃO `security_invoker = on` ───────────
--
-- Ligar `security_invoker` fecharia o buraco e quebraria o produto: a view
-- passaria a obedecer a RLS de `profiles`, que só permite a própria linha, e as
-- nove telas que mostram nome e foto de OUTRO usuário ficariam vazias. A view
-- existe justamente para ser essa janela. O que estava errado nunca foi o
-- `invoker=off` — foi a janela aceitar ser empurrada nos dois sentidos.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── A. As duas views do schema `public` ──────────────────────────────────────
--
-- `revoke all` PRIMEIRO e `grant select` DEPOIS. Na ordem inversa não adianta:
-- foi essa a ordem que a 0069 usou para `authenticated`, e é por isso que o
-- privilégio de escrita sobreviveu a ela.
--
-- `rides_with_locations` não é explorável hoje — a 0072 a deixou com
-- `security_invoker = on`, então a RLS de `rides` se aplica também na escrita, e
-- o ataque acima devolve 0 linhas nela (conferido). Entra aqui assim mesmo: o
-- privilégio não tem uso nenhum, e a única coisa que hoje separa esta view da
-- outra é uma reloption que um `create or replace` futuro apaga sem avisar.

revoke all on public.profiles_public      from anon, authenticated;
revoke all on public.rides_with_locations from anon, authenticated;

grant select on public.profiles_public      to authenticated;
grant select on public.rides_with_locations to authenticated;

-- ── B. A trava que não depende de alguém lembrar ─────────────────────────────
--
-- Consertar as duas views nomeadas resolve hoje e não resolve amanhã: a próxima
-- view criada em `public` nasce com ALL outra vez, pelo mesmo default privilege,
-- e ninguém vai reler este arquivo. A asserção abaixo falha a migration inteira
-- se QUALQUER view de `public` expuser escrita a `anon` ou `authenticated`.
--
-- Ela não conserta a view futura — de propósito. Uma correção automática
-- silenciosa esconderia que a view nasceu errada; a asserção obriga quem a
-- criar a decidir e a escrever a decisão.

do $$
declare
  v_bad text;
begin
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
    raise exception '0073 incompleta: view com escrita exposta: %', v_bad;
  end if;

  raise notice '0073: nenhuma view de public dá escrita a anon/authenticated.';
end $$;

-- ── C. E que `anon` não leia nenhuma das duas ────────────────────────────────
-- A 0067 e a 0069 já fecham isto; a asserção existe para que a próxima migration
-- que recriar uma view não desfaça o trabalho delas em silêncio.

do $$
declare
  v_bad text;
begin
  if to_regrole('anon') is null then
    return;
  end if;

  select string_agg(v, ', ') into v_bad
    from unnest(array['public.profiles_public', 'public.rides_with_locations']) as v
   where to_regclass(v) is not null
     and has_table_privilege('anon', v, 'SELECT');

  if v_bad is not null then
    raise exception '0073 incompleta: anon ainda lê: %', v_bad;
  end if;
end $$;

comment on view public.profiles_public is
  'Colunas não sensíveis de profiles (nome, foto, nota, tipo). `security_invoker = off` (0049) — ignora a RLS de profiles DE PROPÓSITO, então quem tem privilégio aqui alcança a linha de QUALQUER usuário. Por isso: `anon` revogado (0067), `driver_code` removido (0069) e SOMENTE SELECT para `authenticated` (0073) — antes da 0073 esta view aceitava UPDATE e DELETE de qualquer conta logada, por cima da RLS.';
