-- ═════════════════════════════════════════════════════════════════════════════
-- 0080 — O motorista volta a conseguir PUBLICAR POSIÇÃO
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ─── O DEFEITO ───────────────────────────────────────────────────────────────
--
-- Desde a 0069, TODO upsert de posição feito pelo aplicativo morre com
-- `42501 permission denied for table driver_locations`. Não é intermitente,
-- não depende de GPS, não depende de RLS: é o papel `authenticated` sem o
-- privilégio que o comando exige. Sem publicar posição, o motorista nunca entra
-- no leque do despacho — e, na versão do app anterior a 4a86047, o erro fazia a
-- chave "Online" voltar sozinha para Offline com banner vermelho, que é
-- exatamente o sintoma relatado com print de tela.
--
-- ─── POR QUE, EXATAMENTE ─────────────────────────────────────────────────────
--
-- A 0069 B.1 (`0069_driver_code_and_fleet_exposure.sql:164` e `:182`) faz:
--
--     revoke select on public.driver_locations from authenticated;
--     grant  select (<todas as colunas menos lat, lng, heading>) ... ;
--
-- O raciocínio dela está escrito em `0069:143-161` e audita os CINCO call sites
-- por uma pergunta só: "algum cliente LÊ de volta lat/lng/heading?". A resposta
-- era não — todos encadeiam `.select('is_online')` ou nada. A conclusão foi que
-- revogar SELECT dessas três colunas era invisível para a escrita.
--
-- A pergunta estava incompleta. O `upsert` do supabase-js vira, no PostgREST,
-- um `insert ... on conflict (driver_id) do update set "lat" = excluded."lat",
-- "lng" = excluded."lng", "heading" = excluded."heading", ...` — uma cláusula
-- que o cliente NÃO escreve e que nenhuma leitura de código do app revela. E o
-- Postgres exige SELECT sobre toda coluna cujo valor é LIDO numa expressão do
-- `do update`, `excluded.<col>` incluída. Ler `excluded."lat"` é ler `lat`.
--
-- O privilégio é conferido na INICIALIZAÇÃO do plano, antes de qualquer tupla.
-- Por isso não importa se a linha do motorista já existe, se o `on conflict`
-- chega a disparar, ou se o motorista é novo: falha sempre, para todos.
--
-- ─── COMO ISSO FOI ISOLADO (Postgres de verdade, sem mock) ───────────────────
--
-- Num Postgres local construído do zero com `supabase/schema.sql` + as 79
-- migrations (`supabase/localdb/run-migrations.mjs`), rodando o comando como o
-- papel `authenticated` de verdade, com `request.jwt.claims` no lugar do JWT:
--
--   on conflict do update set is_online  = excluded.is_online   → OK
--   on conflict do update set updated_at = excluded.updated_at  → OK
--   on conflict do update set lat        = excluded.lat         → 42501
--   on conflict do update set heading    = excluded.heading     → 42501
--   on conflict do update set lat        = 0  (literal)         → OK
--   update ... set lat = 1 where driver_id = ...                → OK
--
-- As duas últimas isolam a causa: escrever `lat` é permitido; LER `excluded.lat`
-- é que não é. A prova roda a cada build em
-- `supabase/localdb/97_escrita_driver_locations.sql`, e ela não só afirma que o
-- caminho funciona — ela REVOGA o grant desta migration dentro da transação para
-- mostrar o 42501 voltar, e restaura em seguida.
--
-- Call sites derrubados pelo defeito, todos upsert com coordenada:
--   src/contexts/DriverRideContext.tsx:327  (efeito de posição — o ÚNICO ponto
--                                            que cria a linha e carimba updated_at)
--   src/contexts/DriverRideContext.tsx:535  (transição de status com fix)
--   src/screens/driver/DriverNavigateScreen.tsx:402
--   src/lib/nav/backgroundLocationTask.ts:103
--
-- ─── O CONSERTO, E POR QUE ELE E NÃO OUTRO ───────────────────────────────────
--
-- Devolver SELECT em `lat`, `lng` e `heading` a `authenticated`.
--
-- A alternativa era uma RPC `security definer` para publicar posição, como a
-- 0069 já fez do lado da LEITURA (`nearby_online_drivers`). Ela é mais elegante
-- e foi descartada por dois motivos concretos:
--
--   1. `.upsert()` do supabase-js SEMPRE gera `set <col> = excluded.<col>` para
--      cada coluna do payload. Não há como o cliente pedir outra coisa. Logo a
--      RPC exige mudar quatro call sites e PUBLICAR BUILD NOVA — e a 1.0.9, que
--      já está na faixa interna, continuaria quebrada no aparelho do motorista.
--   2. Esta migration conserta as builds JÁ INSTALADAS, sem ciclo de loja.
--
-- ─── O QUE ESTE GRANT NÃO REABRE, E POR QUÊ ──────────────────────────────────
--
-- A 0069 fechou o vazamento da frota com DUAS camadas, e só uma delas era a
-- coluna. A outra — a que de fato segura — foi o `drop policy` de `0069:711`,
-- que removeu `"Passageiro vê motoristas online" using (is_online = true)`.
-- Depois dele, as ÚNICAS linhas de `driver_locations` visíveis a `authenticated`
-- são duas, ambas ancoradas em `auth.uid()`:
--
--   · a própria linha do motorista  ("Motorista atualiza própria localização");
--   · o motorista da corrida ATIVA do passageiro ("Passageiro vê localização do
--     motorista ativo") — que é justamente o carro que ele acompanha no mapa.
--
-- Com o ramo amplo fora, devolver a coluna não devolve frota nenhuma: o
-- bisbilhoteiro logado que rodava `select lat, lng from driver_locations` passou
-- a receber ZERO LINHAS pela RLS, não por falta de privilégio. Isso é medido,
-- não deduzido — está nas asserções da 97.
--
-- Duas consequências declaradas, sem maquiagem:
--
--   a) ESTA MIGRATION CONTRADIZ, DE PROPÓSITO, as asserções de `0069:1115-1120`
--      ("authenticated ainda lê driver_locations.lat"). Elas estavam certas para
--      o invariante que a 0069 quis, e esse invariante custava a operação do
--      produto. Quem vale a partir daqui é o bloco Z abaixo.
--   b) A partir de agora o privilégio de coluna NÃO é mais a trava do vazamento
--      — a policy é. Se alguém um dia recriar uma policy de SELECT em
--      `driver_locations` que não dependa de `auth.uid()`, a frota volta a
--      vazar. Por isso o bloco Z assevera a AUSÊNCIA dessa policy, e a mesma
--      asserção passa a rodar a cada build no `99_verificacao.sql`.
--
-- IMPACTO DA APLICAÇÃO: instantâneo e sem downtime — é um `grant`, não mexe em
-- dado nem em estrutura. Não altera `system_config` e não toca em nenhuma flag.
-- ═════════════════════════════════════════════════════════════════════════════

grant select (lat, lng, heading) on public.driver_locations to authenticated;

comment on table public.driver_locations is
  'Posição ao vivo dos motoristas. Toda policy é `to authenticated` desde a 0067, e desde a 0069 restam DUAS de SELECT, ambas ancoradas em auth.uid(): a própria linha do motorista e o motorista da corrida ativa do passageiro. É a POLICY que fecha a colheita da frota — o ramo amplo `is_online = true` foi removido na 0069. O privilégio de COLUNA sobre lat/lng/heading foi devolvido na 0080: sem ele o `on conflict do update set lat = excluded.lat` do upsert do PostgREST morria em 42501 e nenhum motorista conseguia publicar posição. Coordenada de terceiro em massa continua saindo só pela RPC nearby_online_drivers (raio, teto e rate limit) ou por service_role.';

-- ═════════════════════════════════════════════════════════════════════════════
-- Z — Asserções. Uma migration que aplica sem erro não é uma migration que fez
--     efeito: é o que a 0012 provou por anos neste mesmo repositório.
-- ═════════════════════════════════════════════════════════════════════════════
do $$
declare
  v_falta text;
  v_bad   text;
begin
  -- Z.1 — Os dois caminhos de escrita do app, coluna a coluna, verbo a verbo.
  --       A lista é o que o PostgREST emite, não o que o app "parece" mandar:
  --       o upsert LÊ excluded.<col> de toda coluna do payload, e isso é SELECT.
  select string_agg(v.verbo || ' ' || v.coluna, ', ') into v_falta
    from (values
      ('INSERT','driver_id'), ('INSERT','lat'), ('INSERT','lng'),
      ('INSERT','heading'),   ('INSERT','is_online'), ('INSERT','updated_at'),
      ('UPDATE','driver_id'), ('UPDATE','lat'), ('UPDATE','lng'),
      ('UPDATE','heading'),   ('UPDATE','is_online'), ('UPDATE','updated_at'),
      ('SELECT','driver_id'), ('SELECT','lat'), ('SELECT','lng'),
      ('SELECT','heading'),   ('SELECT','is_online'), ('SELECT','updated_at')
    ) as v(verbo, coluna)
   where not has_column_privilege('authenticated', 'public.driver_locations', v.coluna, v.verbo);

  if v_falta is not null then
    raise exception '0080 incompleta: authenticated ainda não pode %. O upsert de posição continua morrendo em 42501.', v_falta;
  end if;

  -- Z.2 — O que agora segura a frota é a POLICY. Nenhuma policy de leitura pode
  --       existir sem depender de auth.uid(): uma que não dependa vale para todo
  --       mundo logado e, COM o grant desta migration, entrega a frota inteira.
  --       Esta é a asserção que a alínea (b) do cabeçalho promete.
  select string_agg(p.policyname, ', ') into v_bad
    from pg_policies p
   where p.schemaname = 'public'
     and p.tablename  = 'driver_locations'
     and p.cmd in ('SELECT', 'ALL')
     and coalesce(p.qual, '') not like '%auth.uid()%';

  if v_bad is not null then
    raise exception '0080 insegura: policy de leitura em driver_locations sem auth.uid(): %. Com o grant de coluna devolvido, ela entrega lat/lng de TODA a frota a qualquer conta logada.', v_bad;
  end if;

  -- Z.3 — E as duas legítimas continuam de pé. Sem a primeira o motorista não
  --       lê o próprio status de volta (o `.select('is_online')` que denuncia a
  --       coerção do trigger da 0038); sem a segunda o passageiro perde o carro
  --       no mapa durante a viagem.
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'driver_locations'
       and policyname = 'Motorista atualiza própria localização'
  ) then
    raise exception '0080 quebrada: sumiu a policy da própria linha do motorista';
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'driver_locations'
       and policyname = 'Passageiro vê localização do motorista ativo'
  ) then
    raise exception '0080 quebrada: sumiu a policy da corrida ativa';
  end if;

  -- Z.4 — `anon` não entra nesta carona. A 0069:165 revogou tudo dele e esta
  --       migration concede só a `authenticated`; a asserção existe porque o
  --       erro clássico aqui é `grant ... to anon, authenticated` no automático.
  if has_column_privilege('anon', 'public.driver_locations', 'lat', 'SELECT') then
    raise exception '0080 insegura: anon voltou a ler driver_locations.lat — a anon key é pública (src/lib/supabase.ts:21)';
  end if;

  raise notice '0080: authenticated volta a publicar posição; a frota segue fechada pela policy.';
end $$;
