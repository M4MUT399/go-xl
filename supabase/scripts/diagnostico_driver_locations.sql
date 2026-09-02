-- ═════════════════════════════════════════════════════════════════════════════
-- O motorista consegue GRAVAR status em driver_locations? — consulta única
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Cole no SQL Editor do Supabase (produção) e rode. É SOMENTE LEITURA: só
-- consulta catálogo (pg_*, information_schema) e as funções has_*_privilege.
-- Não escreve, não cria nada, não altera configuração.
--
-- POR QUE ELA EXISTE. Todo teste do app é mockado: o mock devolve o que o teste
-- mandar devolver, inclusive sucesso num caminho que o Postgres recusaria. Esta
-- consulta pergunta ao Postgres de produção — o único que sabe a resposta — se
-- o papel `authenticated` (o papel de QUALQUER usuário logado, motorista
-- incluso) ainda pode escrever status.
--
-- O QUE ELA NÃO PROVA: nada sobre RLS por linha (privilégio e policy são
-- camadas diferentes — a seção 3 mostra as policies para leitura humana, não as
-- avalia), nada sobre o PostgREST, nada sobre o aparelho. Ela responde a
-- camada de PRIVILÉGIO e mostra a de POLICY e TRIGGER.
--
-- COMO LER: a seção 1 é o veredito. Qualquer linha começando com "FALTA" ali é
-- escrita bloqueada para todo motorista, e nenhum conserto no app resolve.
-- ═════════════════════════════════════════════════════════════════════════════

with alvo as (select 'public.driver_locations'::regclass as t),

-- ── 1) VEREDITO: o que os DOIS caminhos de escrita do app exigem ────────────
-- Caminho A (com fix de GPS)  — upsert do PostgREST:
--     insert (driver_id,lat,lng,heading,is_online,updated_at) ... 
--       on conflict (driver_id) do update set <mesmas colunas> = excluded.<col>
--       returning is_online
-- Caminho B (sem fix de GPS)  — update simples:
--     update ... set is_online = $1 where driver_id = $2 returning is_online
--
-- Postgres exige, além de INSERT/UPDATE nas colunas escritas, SELECT nas
-- colunas LIDAS: as do `where`, as do `returning` e as lidas em expressão.
--
-- ⚠️ A LINHA QUE QUEBROU EM PRODUCAO É UMA DAS TRES DE `SELECT lat/lng/heading`
-- DO CAMINHO A. `excluded."lat"` É LEITURA DE `lat`. Uma versao anterior desta
-- consulta nao as listava, dava "ok" em tudo e teria absolvido um banco em que
-- nenhum motorista conseguia publicar posicao. Nao remova essas tres linhas.
veredito as (
  select * from (values
    ('A: upsert', 'SELECT', 'lat'),        -- excluded.lat, no `do update`
    ('A: upsert', 'SELECT', 'lng'),        -- excluded.lng
    ('A: upsert', 'SELECT', 'heading'),    -- excluded.heading
    ('A: upsert', 'INSERT', 'driver_id'),
    ('A: upsert', 'INSERT', 'lat'),
    ('A: upsert', 'INSERT', 'lng'),
    ('A: upsert', 'INSERT', 'heading'),
    ('A: upsert', 'INSERT', 'is_online'),
    ('A: upsert', 'INSERT', 'updated_at'),
    ('A: upsert', 'UPDATE', 'driver_id'),
    ('A: upsert', 'UPDATE', 'lat'),
    ('A: upsert', 'UPDATE', 'lng'),
    ('A: upsert', 'UPDATE', 'heading'),
    ('A: upsert', 'UPDATE', 'is_online'),
    ('A: upsert', 'UPDATE', 'updated_at'),
    ('A: upsert', 'SELECT', 'is_online'),   -- returning
    ('B: update', 'UPDATE', 'is_online'),
    ('B: update', 'SELECT', 'driver_id'),   -- where
    ('B: update', 'SELECT', 'is_online')    -- returning
  ) as v(caminho, verbo, coluna)
),
s1 as (
  select
    '1. VEREDITO — privilegio de coluna de `authenticated`' as secao,
    v.caminho || '  ' || rpad(v.verbo, 6) || ' ' || rpad(v.coluna, 12) as item,
    case when has_column_privilege('authenticated', (select t from alvo), v.coluna, v.verbo)
         then 'ok'
         else 'FALTA — este caminho de escrita esta BLOQUEADO para todo motorista'
    end as detalhe,
    1 as ord, v.caminho || v.verbo || v.coluna as ord2
  from veredito v
),

-- ── 2) Privilégio de TABELA (o `grant` cru, sem coluna) ─────────────────────
s2 as (
  select
    '2. Privilegio de tabela por papel' as secao,
    rpad(r.rolname, 14) || ' ' || p.priv as item,
    case when has_table_privilege(r.rolname, (select t from alvo), p.priv)
         then 'sim' else 'nao' end as detalhe,
    2 as ord, r.rolname || p.priv as ord2
  from (values ('SELECT'),('INSERT'),('UPDATE'),('DELETE')) as p(priv)
  cross join (
    select rolname from pg_roles
     where rolname in ('anon','authenticated','service_role','authenticator')
  ) r
),

-- ── 3) RLS: está ligada? e QUAIS policies existem, com as expressões ────────
s3a as (
  select
    '3. RLS' as secao,
    'row level security' as item,
    case when c.relrowsecurity then 'LIGADA' else 'DESLIGADA' end
      || case when c.relforcerowsecurity then ' (forcada tambem para o dono)' else '' end as detalhe,
    3 as ord, '0' as ord2
  from pg_class c where c.oid = (select t from alvo)
),
s3b as (
  select
    '3. RLS' as secao,
    rpad(coalesce(p.cmd,'?'), 6) || ' ' || coalesce(array_to_string(p.roles, ','), '-')
      || ' :: ' || p.policyname as item,
    'using(' || coalesce(p.qual, '-') || ')  check(' || coalesce(p.with_check, '-') || ')' as detalhe,
    3 as ord, '1' || p.policyname as ord2
  from pg_policies p
  where p.schemaname = 'public' and p.tablename = 'driver_locations'
),

-- ── 4) TRIGGERS: o que pode abortar ou reescrever a linha em silêncio ───────
s4 as (
  select
    '4. Triggers' as secao,
    rpad(tg.tgname, 40) || ' ' ||
      case tg.tgenabled when 'O' then 'ativo' when 'D' then 'DESABILITADO'
           when 'R' then 'replica' when 'A' then 'always' else tg.tgenabled::text end as item,
    case when (tg.tgtype & 2) <> 0 then 'BEFORE ' else 'AFTER/INSTEAD ' end
      || case when (tg.tgtype & 4)  <> 0 then 'INSERT ' else '' end
      || case when (tg.tgtype & 16) <> 0 then 'UPDATE ' else '' end
      || case when (tg.tgtype & 8)  <> 0 then 'DELETE ' else '' end
      || '-> ' || p.proname
      || case when p.prosecdef then ' (security definer)' else '' end as detalhe,
    4 as ord, tg.tgname as ord2
  from pg_trigger tg
  join pg_proc p on p.oid = tg.tgfoid
  where tg.tgrelid = (select t from alvo) and not tg.tgisinternal
),

-- ── 5) Colunas NOT NULL sem default: o que um INSERT é OBRIGADO a trazer ────
--     (é a razão de o upsert sem coordenada morrer em 23502)
s5 as (
  select
    '5. Colunas obrigatorias num INSERT' as secao,
    rpad(a.attname, 22) || format_type(a.atttypid, a.atttypmod) as item,
    case when a.attnotnull and d.adbin is null
           then 'NOT NULL SEM DEFAULT — todo INSERT tem de trazer esta coluna'
         when a.attnotnull then 'not null, mas tem default'
         else 'aceita null' end as detalhe,
    5 as ord, lpad(a.attnum::text, 3, '0') as ord2
  from pg_attribute a
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attrelid = (select t from alvo) and a.attnum > 0 and not a.attisdropped
),

-- ── 6) Constraint de conflito do upsert (`on conflict (driver_id)`) ─────────
s6 as (
  select
    '6. Chave do on conflict' as secao,
    con.conname || ' (' || case con.contype when 'p' then 'primary key'
                                            when 'u' then 'unique' end || ')' as item,
    (select string_agg(att.attname, ', ' order by k.ord)
       from unnest(con.conkey) with ordinality as k(attnum, ord)
       join pg_attribute att on att.attrelid = con.conrelid and att.attnum = k.attnum) as detalhe,
    6 as ord, con.conname as ord2
  from pg_constraint con
  where con.conrelid = (select t from alvo) and con.contype in ('p','u')
)

select secao, item, detalhe
from (
  select * from s1  union all select * from s2  union all select * from s3a
  union all select * from s3b union all select * from s4 union all select * from s5
  union all select * from s6
) tudo
order by ord, ord2;
