-- 0069 — uma conta grátis não pode mais baixar a credencial de QR de todo
--        motorista, nem a posição exata da frota inteira; e `driver_code`
--        passa a ser realmente único.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- COMO APLICAR
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Dentro de UMA transação, como a 0067:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 \
--     -f supabase/migrations/0069_driver_code_and_fleet_exposure.sql
--
--   npx supabase db push
--
-- NÃO acrescente `begin;`/`commit;` aqui dentro (mesma razão da 0067).
--
-- DEPENDE DA 0067 estar aplicada: a seção A recria `public.profiles_public`, e
-- recriar a view faz o privilégio DEFAULT do schema `public` conceder SELECT a
-- `anon` de novo (é o fato (2) do cabeçalho da 0067). O revoke é reaplicado
-- aqui e o bloco Z falha se ele não pegar.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- NADA DISTO FOI EXECUTADO
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Não há Postgres, Docker nem psql no ambiente onde este arquivo foi escrito.
-- Tudo abaixo é leitura de código e de documentação; nenhuma afirmação aqui é
-- medição. Os comandos de prova estão no rodapé.

set local lock_timeout = '3s';

-- ═════════════════════════════════════════════════════════════════════════════
-- A. `driver_code` SAI de `public.profiles_public`
-- ═════════════════════════════════════════════════════════════════════════════
--
-- O QUE AINDA ESTAVA ABERTO DEPOIS DA 0067
-- A 0067 revogou `anon` da view — e isso estava certo. Mas manteve
-- `grant select ... to authenticated` (0067:538) sobre uma view que é
-- `security_invoker = off` (0049:43), ou seja, que lê `profiles` com o
-- privilégio do DONO e IGNORA a RLS da tabela. E a view ainda selecionava
-- `driver_code` (0049:40).
--
-- Contas `authenticated` são grátis e não verificadas: o Cadastro Expresso
-- (src/screens/passenger/ExpressRegisterScreen.tsx:76-82) cria uma com
-- `express_<timestamp>@goxl.express` e senha aleatória, sem confirmação. Duas
-- requisições depois, qualquer pessoa era `authenticated` e podia:
--
--     GET /rest/v1/profiles_public?select=*
--
-- e baixar o diretório inteiro do app COM `driver_code` — a credencial que o
-- AppNavigator aceita para travar uma corrida num motorista. Cruzando esse
-- diretório com `driver_locations` (legível para toda a frota online por
-- qualquer conta logada — seção B), o resultado é nome + posição + rumo ao
-- vivo de cada motorista trabalhando em Orlando, sem que o motorista possa
-- optar por sair nem perceber que está sendo lido. Isso é superfície de
-- perseguição, não de privacidade.
--
-- POR QUE DÁ PARA REMOVER A COLUNA AGORA
-- Nenhum leitor de `profiles_public` seleciona `driver_code`. Conferido por
-- grep em todo o repositório — os nove leitores do app pedem colunas
-- explícitas (`full_name`, `avatar_url`, `rating`, `id`), nunca `*` e nunca
-- `driver_code`:
--   DriverHomeScreen.tsx:156, ActiveRideScreen.tsx:186, IncomingRideCall.tsx:129,
--   useUnreadMessages.ts:74, DriverNavigateScreen.tsx:326,
--   useUpcomingScheduledRide.ts:67, ScheduledRidesScreen.tsx:63,
--   useDriverScheduledRides.ts:150 — e os scripts charge_unpaid_ride.ts:105,
--   find_rides.ts:97, check_driver_names.ts:95 (todos com service_role).
-- O único lugar que lê `driver_code` de outro usuário é
-- `verify_qr_lock_test.ts:53`, e ele lê a TABELA `profiles` com service_role.
--
-- E o sentido da resolução é o OUTRO: a Edge Function `resolve-driver-code`
-- traduz código → id. Ninguém precisa de id → código, exceto o próprio dono,
-- que lê a própria linha de `profiles` (policy "Usuário vê o próprio perfil").
--
-- `security_invoker` CONTINUA `off` — DE PROPÓSITO
-- A 0049:22-26 escolheu `off` para que a view sobrevivesse à remoção da policy
-- ampla de `profiles` (feita na 0050). Virar `on` agora faria as nove telas
-- pararem de ver o nome do outro participante da corrida, porque a RLS de
-- `profiles` só deixa cada um ler a PRÓPRIA linha. A view continua sendo uma
-- janela deliberada; o que muda é que a janela deixa de mostrar uma credencial.
--
-- `drop` + `create` em vez de `create or replace`: `create or replace view` não
-- consegue REMOVER coluna, só acrescentar no fim.

drop view if exists public.profiles_public;

create view public.profiles_public as
select
  id,
  full_name,
  avatar_url,
  rating,
  type
from public.profiles;

alter view public.profiles_public set (security_invoker = off);

-- Ordem importa: a view acabou de nascer, então o default privilege do schema
-- `public` já concedeu SELECT a `anon`. Revogar é obrigatório — sem esta linha,
-- a 0069 REABRIRIA o buraco que a 0067 fechou.
revoke all on public.profiles_public from anon;
grant select on public.profiles_public to authenticated;

comment on view public.profiles_public is
  'Colunas não sensíveis de profiles (nome, foto, nota, tipo). `security_invoker = off` (0049) — ignora a RLS de profiles de propósito, então quem tem SELECT aqui lê a linha de QUALQUER usuário; por isso `anon` é revogado (0067) e o conteúdo é mínimo. `driver_code` foi REMOVIDO na 0069: contas authenticated são grátis e não verificadas (Cadastro Expresso), e a coluna é a credencial de QR do motorista. Resolução de código vai pela Edge Function resolve-driver-code, no sentido código → id.';

-- ═════════════════════════════════════════════════════════════════════════════
-- B. `driver_locations` — a posição da frota deixa de ser uma listagem
-- ═════════════════════════════════════════════════════════════════════════════
--
-- A 0067 (seção B) colocou `to authenticated` em todas as policies e registrou
-- explicitamente a pendência: "o ramo amplo ainda entrega coordenada exata da
-- frota a qualquer conta logada; o caminho certo é uma RPC que devolva só os
-- carros num raio do passageiro, e isso exige mudar useNearbyDrivers junto"
-- (0067:227-230). É o que esta seção faz.
--
-- POR QUE NÃO DÁ PARA RESOLVER SÓ COM POLICY
-- RLS é por LINHA. "todo motorista online" e "os motoristas online perto de
-- mim" são o mesmo conjunto de linhas para a RLS — o que muda é o RAIO, que
-- depende de uma posição que só o chamador informa e que a policy não recebe.
-- E não dá para simplesmente apagar o ramo amplo: `useRide.ts:197-199`
-- (notifyOnlineDrivers) e `useRide.ts:387-389` (pushSilentRevokeToOnlineDrivers)
-- dependem dele — mas os dois leem SÓ `driver_id`, nunca coordenada.
--
-- É essa assimetria que dá a saída: privilégio de COLUNA. A policy ampla fica
-- como está (os dois fluxos de push continuam funcionando), e `lat`, `lng` e
-- `heading` saem do alcance do SELECT direto. Quem precisa de coordenada passa
-- pela RPC da B.2, que impõe raio e teto de linhas.

-- ─────────────────────────────────────────────────────────────────────────────
-- B.1 — SELECT de `authenticated` restrito às colunas não posicionais.
--
-- Feito dinamicamente a partir do catálogo, e não com uma lista fixa: a tabela
-- ganhou colunas depois de schema.sql (`is_online_changed_at`, na 0059/0060) e
-- pode ganhar outras. Uma lista fixa aqui viraria uma revogação silenciosa de
-- coluna nova no futuro. A regra é a EXCLUSÃO das três colunas posicionais.
--
-- INSERT/UPDATE não são tocados: o motorista continua gravando a própria
-- posição (DriverRideContext.tsx, DriverNavigateScreen.tsx, nav/
-- backgroundLocationTask.ts).
--
-- O invariante que este bloco precisa NÃO é "nenhum upsert encadeia
-- `.select()`". Essa era a redação original e ela envelheceu: os dois upserts
-- de status em DriverRideContext.tsx passaram a encadear `.select('is_online')`
-- — sem isso, a coerção `is_online := false` do trigger da 0038 é invisível e o
-- motorista fica com a chave verde sem receber corrida.
--
-- O invariante de verdade é mais estreito, e continua valendo: NENHUM cliente
-- lê de volta `lat`, `lng` ou `heading` de `driver_locations`. Só essas três
-- colunas saem do grant; qualquer outra segue selecionável. Os cinco call
-- sites, conferidos um a um:
--
--   • DriverRideContext (efeito de posição e efeito de transição) — `.select
--     ('is_online')`, coluna permitida;
--   • useDriverPeriodTracker — `.select('is_online, is_online_changed_at')`,
--     ambas permitidas;
--   • DriverNavigateScreen e nav/backgroundLocationTask — upsert sem `.select`.
--
-- Um `.select('*')` em qualquer um deles quebra sob esta migration. É o preço
-- consciente do privilégio de coluna: quem precisar de coordenada de outro
-- motorista passa pela RPC da B.2, que impõe raio e teto de linhas.
-- ─────────────────────────────────────────────────────────────────────────────
revoke select on public.driver_locations from authenticated;
revoke all    on public.driver_locations from anon;

do $$
declare
  v_cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into v_cols
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'driver_locations'
     and column_name not in ('lat', 'lng', 'heading');

  if v_cols is null then
    raise exception '0069: driver_locations sem colunas fora de lat/lng/heading — schema inesperado';
  end if;

  execute format('grant select (%s) on public.driver_locations to authenticated', v_cols);
  raise notice '0069: SELECT de authenticated em driver_locations limitado a: %', v_cols;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- B.2 — A RPC do mapa do passageiro.
--
-- ═══ POR QUE ESTA FUNÇÃO FOI REESCRITA (iteração 4) ═══════════════════════
-- A primeira versão desta RPC trocava um `select *` por uma função com raio e
-- teto de linhas, e parava aí. Isso não fecha o defeito que a seção B nomeia,
-- e é importante ser exato sobre por quê:
--
--   • ela devolvia `dl.lat, dl.lng, dl.heading` com PRECISÃO TOTAL — o mesmo
--     dado do `select` que ela substituiu, só que empacotado;
--   • `p_lat`/`p_lng` são escolhidos livremente pelo chamador e não tinham
--     nenhum vínculo com onde ele está;
--   • não havia rate limit NENHUM;
--   • `authenticated` inclui toda conta criada pelo Cadastro Expresso, que é
--     uma fábrica de contas grátis e não verificadas.
--
-- Somando: qualquer pessoa varria Orlando em algumas dezenas de chamadas e
-- reconstruía a frota inteira com coordenada exata MAIS RUMO. Posição exata +
-- rumo, amostrados no tempo, é uma trilha de deslocamento de uma pessoa
-- identificável. Era exatamente a superfície de perseguição que a seção B diz
-- estar fechando.
--
-- ═══ O QUE MUDA AGORA ═════════════════════════════════════════════════════
--   1. PRECISÃO. A coordenada é ARREDONDADA para 3 casas decimais — uma grade
--      de ~111 m em latitude e ~98 m em longitude nesta latitude. O mapa do
--      passageiro continua mostrando "tem carro ali"; o que deixa de existir é
--      o ponto exato. Arredondamento DETERMINÍSTICO (grade fixa), e não ruído
--      aleatório, de propósito: ruído se cancela na média se o atacante
--      consultar repetidamente, uma grade não.
--
--      ⚠️ E O ARREDONDAMENTO ACONTECE ANTES DO FILTRO (iteração 5). Na
--      iteração 4 ele era aplicado só na projeção, com o `where` e o `order by`
--      ainda sobre a coordenada exata — e nesse desenho ele não protegia nada.
--      O motivo está escrito por extenso no corpo da função, junto do
--      `return query`; o resumo é que PERTENCER ao resultado era uma função da
--      posição exata, e o chamador escolhe centro e raio, logo consegue
--      perguntar "está dentro deste círculo?" quantas vezes quiser. Três
--      círculos localizam um ponto. A grade de 111 m era enfeite sobre um
--      oráculo de trilateração.
--   2. RUMO. `heading` SAI do retorno. Ele não tem uso no mapa ambiente (o
--      marcador do passageiro pode apontar para cima) e é justamente o que
--      transforma uma sequência de pontos numa trajetória.
--   3. RATE LIMIT por `auth.uid()`, reusando `check_public_lookup_rate_limit`
--      da 0067. Sem isto, "varrer a cidade" não tinha custo nenhum.
--   4. ÂNCORA. Se o servidor já sabe de alguma posição do chamador, o centro
--      pedido tem de estar perto dela.
--
-- E o que continua: exige sessão, raio grampeado em [2; 15] km (o piso subiu de
-- 0,5 na iteração 5 — ver a constante), teto de 60 linhas, posições paradas há
-- mais de 10 min ficam de fora.
--
-- ═══ LIMITE HONESTO — LEIA ANTES DE CONSIDERAR ISTO RESOLVIDO ════════════
-- Isto REDUZ o dano; não o elimina. O que continua possível:
--   • uma conta logada ainda pode mover o centro e montar um mosaico de
--     Orlando. A âncora não impede isso, porque Orlando inteira cabe DENTRO da
--     tolerância da âncora — a âncora impede usar uma conta estabelecida para
--     varrer OUTRO mercado, não o próprio;
--   • uma conta RECÉM-CRIADA não tem âncora nenhuma (nunca pediu corrida), e o
--     Cadastro Expresso cria contas em duas requisições. Para essa conta a
--     âncora não existe e o único freio é o rate limit. Este é o buraco
--     residual, e ele é REAL;
--   • o teto por hora ainda comporta centenas de células distintas.
-- O que NÃO continua possível, desde a iteração 5: refinar a posição ABAIXO da
-- célula. O conjunto devolvido passou a ser função exclusiva das coordenadas
-- arredondadas, então varrer raio e centro não extrai mais do que a resposta já
-- entrega. O mosaico continua sendo mosaico; ele parou de ter zoom.
-- O que efetivamente encolhe o valor do ataque é (1) e (2): o produto vira
-- "há carros nesta quadra", não "este motorista está neste ponto, indo para
-- lá". Fechar o resto exige atestar a posição real do dispositivo, coisa que
-- este app não tem como fazer, ou cobrar verificação na criação de conta —
-- decisão de produto, não desta migration.
--
-- ═══ NOTAS DE IMPLEMENTAÇÃO ══════════════════════════════════════════════
-- `volatile` (e NÃO `stable`, como na primeira versão): a função agora chama
-- `check_public_lookup_rate_limit`, que faz INSERT/UPDATE. Postgres RECUSA em
-- tempo de execução um INSERT dentro de função não volátil, então manter
-- `stable` derrubaria o mapa inteiro. Isso também obriga o client a chamar por
-- POST — que é o que `supabase.rpc()` já faz.
--
-- `security definer` porque `authenticated` não tem mais SELECT em lat/lng.
-- Chamar `check_public_lookup_rate_limit` de dentro funciona porque, sob
-- `security definer`, o `current_user` é o DONO desta função, e o dono mantém
-- EXECUTE sobre a outra (os `revoke` da 0067 atingem public/anon/authenticated,
-- não o dono). A asserção Z.11 compara `proowner` das duas e falha alto se
-- divergirem — sem o mesmo dono este raciocínio cai e o mapa quebra. (Este
-- comentário afirmava que o bloco Z já fazia essa checagem quando ele não
-- fazia; a Z.11 foi escrita para tornar a afirmação verdadeira.) NÃO EXECUTADO
-- AQUI.
-- ─────────────────────────────────────────────────────────────────────────────

-- ─────────────────────────────────────────────────────────────────────────────
-- B.2.0 — O TETO DE BUCKETS VIRA PARÂMETRO, porque 5.000 está certo para uma
-- chave FORJÁVEL e errado para uma chave que é `auth.uid()`.
--
-- `check_public_lookup_rate_limit` (0067:596) tem `c_max_buckets constant := 5000`
-- por (função, janela) e, estourado o teto, NEGA em vez de criar bucket novo.
-- Esse desenho está certo para quem o motivou: `resolve-driver-code` é anônimo e
-- a chave sai de header de proxy, então "muitos buckets" é sinal de spray de
-- chaves forjadas, e ficar mais estrito é a resposta certa.
--
-- A RPC do mapa (B.2 abaixo) não se parece com isso em nada. A chave dela é
-- `md5(auth.uid())`: um bucket por USUÁRIO REAL por janela de 60 s, e ninguém
-- forja `auth.uid()`. Aplicar 5.000 ali não limita ataque nenhum — limita o
-- PRODUTO. Passados 5.000 passageiros distintos com o app aberto no mesmo
-- minuto, o 5.001º recebe `false`, a RPC levanta exceção e o mapa dele fica
-- vazio. Pior: contas são grátis, então o teto é alcançável de propósito — 5.000
-- contas do Cadastro Expresso batendo na RPC negam o mapa a passageiros reais,
-- e o sintoma (mapa sem carro) não se parece nem um pouco com a causa.
--
-- Então o teto deixa de ser constante e passa a ser argumento, com DEFAULT 5000:
-- todo chamador existente continua idêntico sem tocar em nada, e quem tem chave
-- não-forjável pede um teto compatível com o tamanho da base.
--
-- `drop` antes do `create`: acrescentar um parâmetro com default NÃO substitui a
-- função de 4 argumentos — cria uma SOBRECARGA. Com as duas vivas, uma chamada
-- de 4 argumentos vira "function is not unique" e o rate limit inteiro passa a
-- dar erro (que `resolve-driver-code` trata como `unavailable` → 503, ou seja,
-- Cadastro Expresso fora do ar). Dropar é obrigatório, não higiene.
drop function if exists public.check_public_lookup_rate_limit(text, text, integer, integer);

create or replace function public.check_public_lookup_rate_limit(
  p_bucket_key     text,
  p_function_name  text,
  p_max_requests   integer,
  p_window_seconds integer,
  p_max_buckets    integer default 5000
) returns boolean
language plpgsql
security definer
-- `pg_catalog` PRIMEIRO, e isso não é estilo. Quando `pg_catalog` NÃO é
-- nomeado no `search_path`, o Postgres o pesquisa implicitamente antes de tudo;
-- ao nomeá-lo, ele passa a valer na POSIÇÃO escrita. `public, pg_catalog` —
-- como estava — coloca um schema gravável na frente do catálogo dentro de uma
-- função `security definer`, que roda com o privilégio do dono. Quem conseguir
-- criar `public.now()`, `public.count()` ou um operador com a assinatura certa
-- sequestra o corpo desta função com privilégio de dono.
--
-- Hoje isso não é explorável no Supabase (nem `anon` nem `authenticated` têm
-- CREATE em `public`), então a troca é preventiva, não um patch de furo aberto.
-- Mas a ordem certa custa zero e a errada depende de um privilégio que alguém
-- pode conceder um dia sem ligar os pontos. Mesma troca em B.2 e na D.
set search_path = pg_catalog, public
as $$
declare
  -- Ver 0067 seção do rate limit: limpeza determinística e limitada, e teto de
  -- cardinalidade só no caminho que CRIA bucket. O corpo abaixo é o da 0067 com
  -- uma única diferença — `c_max_buckets` virou `p_max_buckets`.
  c_delete_batch constant integer := 200;

  v_window_start timestamptz;
  v_count        integer;
  v_buckets      integer;
begin
  if p_window_seconds is null or p_window_seconds <= 0 then
    raise exception 'p_window_seconds deve ser positivo';
  end if;

  if p_max_buckets is null or p_max_buckets <= 0 then
    raise exception 'p_max_buckets deve ser positivo';
  end if;

  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  delete from public.public_lookup_rate_limits
   where ctid in (
     select ctid
       from public.public_lookup_rate_limits
      where window_start < v_window_start - (p_window_seconds * 2) * interval '1 second'
      order by window_start
      limit c_delete_batch
   );

  update public.public_lookup_rate_limits
     set request_count = request_count + 1
   where bucket_key    = p_bucket_key
     and function_name = p_function_name
     and window_start  = v_window_start
  returning request_count into v_count;

  if not found then
    select count(*) into v_buckets
      from public.public_lookup_rate_limits
     where function_name = p_function_name
       and window_start  = v_window_start;

    if v_buckets >= p_max_buckets then
      raise warning '[rate-limit] teto de buckets atingido: function=% window=% buckets=% teto=%',
        p_function_name, v_window_start, v_buckets, p_max_buckets;
      return false;
    end if;

    insert into public.public_lookup_rate_limits (bucket_key, function_name, window_start, request_count)
    values (p_bucket_key, p_function_name, v_window_start, 1)
    on conflict (bucket_key, function_name, window_start)
    do update set request_count = public_lookup_rate_limits.request_count + 1
    returning request_count into v_count;
  end if;

  return v_count <= p_max_requests;
end;
$$;

-- Os grants da 0067 morreram junto com a assinatura antiga. Reaplicados aqui,
-- idênticos: só `service_role`, porque quem chama é Edge Function com service
-- key ou uma função `security definer` (cujo dono mantém EXECUTE).
revoke all    on function public.check_public_lookup_rate_limit(text, text, integer, integer, integer) from public;
revoke all    on function public.check_public_lookup_rate_limit(text, text, integer, integer, integer) from anon;
revoke all    on function public.check_public_lookup_rate_limit(text, text, integer, integer, integer) from authenticated;
grant execute on function public.check_public_lookup_rate_limit(text, text, integer, integer, integer) to service_role;

comment on function public.check_public_lookup_rate_limit(text, text, integer, integer, integer) is
  'Janela fixa de rate limit por (bucket_key, function_name). Substitui a versão de 4 argumentos da 0067 — ver 0069 B.2.0. `p_max_buckets` (default 5000) é o teto de buckets DISTINTOS por função/janela; estourado, NEGA em vez de criar linha. Esse teto existe contra spray de chaves FORJÁVEIS (resolve-driver-code, chave de header de proxy) e precisa ser MUITO maior quando a chave é auth.uid(), que ninguém forja e cuja cardinalidade é o tamanho da base de usuários.';

-- `drop` antes do `create`: `create or replace function` NÃO consegue mudar o
-- tipo de retorno, e `heading` saiu da tabela de saída. Sem este drop, aplicar
-- a 0069 num banco onde uma versão anterior desta função exista aborta com
-- "cannot change return type of existing function". A assinatura de ARGUMENTOS
-- não mudou, então o drop é preciso e não pega nenhuma outra sobrecarga.
drop function if exists public.nearby_online_drivers(double precision, double precision, double precision);

create or replace function public.nearby_online_drivers(
  p_lat       double precision,
  p_lng       double precision,
  p_radius_km double precision default 8
)
returns table (
  driver_id uuid,
  lat       double precision,
  lng       double precision
)
language plpgsql
volatile
security definer
-- `pg_catalog` primeiro: ver a nota na B.2.0.
set search_path = pg_catalog, public
as $$
declare
  c_max_radius_km constant double precision := 15;
  -- Piso do raio. Era 0,5 km. Subiu junto com o conserto do oráculo abaixo:
  -- o raio é a única alavanca fina que o chamador controla, e um piso menor
  -- que a célula da grade não descreveria nada de verdade — só daria ao
  -- atacante mais pontos de corte distinguíveis pelo mesmo preço. O único
  -- chamador legítimo pede 8 km fixos (useNearbyDrivers.ts:29), então este
  -- piso não recorta fluxo nenhum.
  c_min_radius_km constant double precision := 2;
  c_max_rows      constant integer          := 60;

  -- Casas decimais do arredondamento da coordenada. 3 ≈ 111 m em latitude.
  -- Ver o item 1 do cabeçalho: é o principal item desta reescrita.
  c_grid_decimals constant integer := 3;

  -- Meia célula da grade, em graus. Só existe para alargar a caixa envolvente
  -- CRUA o bastante para ela ser garantidamente um superconjunto do círculo
  -- calculado sobre a coordenada arredondada — ver o bloco do `return query`.
  -- (`c_grid_decimals` já está inicializada aqui: o PL/pgSQL avalia os defaults
  -- na ordem de declaração. Derivar em vez de repetir o 0,0005 é o que impede
  -- os dois números de divergirem numa edição futura.)
  c_half_cell     constant double precision := 0.5 * power(10::double precision, -c_grid_decimals);

  -- Tolerância da âncora. Generosa DE PROPÓSITO: um passageiro que pediu a
  -- última corrida do outro lado da área metropolitana não pode ficar sem mapa.
  -- Ver o LIMITE HONESTO — este número não é o que contém um scan local.
  c_anchor_km     constant double precision := 50;

  -- Rate limit por usuário. A HomeScreen faz poll a cada 8 s (7,5/min) mais
  -- refetch disparado por realtime, coalescido em 3 s pelo hook (≤ 20/min):
  -- ~28/min no pior caso legítimo. 90/min é ~3x de folga.
  c_rl_short_max  constant integer := 90;
  c_rl_short_secs constant integer := 60;
  -- 1 hora de app aberto e ativo ≈ 450 polls + refetches.
  c_rl_long_max   constant integer := 1200;
  c_rl_long_secs  constant integer := 3600;

  -- Teto de buckets distintos. Ver B.2.0 acima para o porquê de NÃO ser o
  -- default de 5.000: a chave aqui é `auth.uid()`, um bucket por passageiro com
  -- o app aberto, e 5.000 seria um teto de PRODUTO disfarçado de controle de
  -- abuso — o 5.001º passageiro do minuto ficaria sem mapa. Este número não
  -- defende contra nada (a chave não é forjável); ele existe só para o
  -- crescimento de linhas ter um limite duro em vez de nenhum.
  c_rl_max_buckets constant integer := 250000;

  v_uid       uuid;
  v_bucket    text;
  v_radius    double precision;
  v_lat_delta double precision;
  v_lng_delta double precision;
  v_anchor_lat double precision;
  v_anchor_lng double precision;
begin
  v_uid := (select auth.uid());
  if v_uid is null then
    return;
  end if;

  -- ── DOMÍNIO DE ENTRADA, e por que ele é MAIS ESTREITO que o globo ────────
  -- O guard aceitava a esfera inteira (|lat| ≤ 90). Aceitar não é o mesmo que
  -- atender corretamente: a caixa envolvente calculada mais abaixo usa
  -- `greatest(abs(cos(radians(p_lat))), 0.01)` no denominador da longitude, e
  -- esse piso de 0,01 MENTE quando cos(lat) fica abaixo dele. Aí a caixa sai
  -- MAIS ESTREITA que o círculo que ela deveria conter, deixa de ser
  -- superconjunto, e o prefiltro descarta linhas que o filtro fino aprovaria —
  -- motorista some do mapa sem que nada erre. O comentário da caixa afirma
  -- "garantidamente um superconjunto"; a afirmação só é verdadeira dentro de um
  -- domínio, e o domínio precisa ser imposto aqui em vez de suposto lá.
  --
  -- 85° é o corte. Com o raio grampeado em 15 km, `v_lat_delta` ≤ 15/111,045 ≈
  -- 0,135°, então a borda mais extrema da caixa fica em ~85,14°, onde
  -- cos ≈ 0,085 — oito vezes acima do piso de 0,01, que portanto nunca entra em
  -- jogo. Abaixo de 85° a caixa é superconjunto de verdade, não por otimismo.
  --
  -- `p_lng` estreita pelo mesmo motivo, mas por OUTRA falha: a caixa é um
  -- intervalo aritmético em longitude e não sabe que 180 encosta em -180. Um
  -- centro perto do antimeridiano produziria `p_lng + delta > 180`, um
  -- intervalo que não casa com nada do outro lado da emenda. Tratar wrap de
  -- verdade exige um `or` com dois intervalos; 2° de margem custa uma linha e
  -- resolve o mesmo problema sem código não exercitado. (2° é folga sobre o
  -- pior `v_lng_delta` possível no domínio aceito: 0,135/cos(85°) ≈ 1,55°.)
  --
  -- Nada disto recorta uso real: a operação é Orlando (28,5°N, 81,4°W) e o
  -- fallback do hook é o centro de Orlando (useNearbyDrivers.ts:31). O que a
  -- restrição faz é impedir que a função devolva resultado SILENCIOSAMENTE
  -- ERRADO fora da região onde alguém a pensou.
  if p_lat is null or p_lng is null
     or p_lat < -85  or p_lat > 85
     or p_lng < -178 or p_lng > 178 then
    return;
  end if;

  -- ── Rate limit por usuário ────────────────────────────────────────────────
  -- `md5` só para não encher a tabela de rate limit com uuid de usuário; não é
  -- afirmação de segurança nenhuma (o uid já está em `profiles`), é higiene.
  --
  -- `raise exception` em vez de `return` vazio: o conjunto vazio é
  -- indistinguível de "não há carro por perto" e o passageiro ficaria olhando
  -- um mapa vazio sem nada em lugar nenhum dizendo por quê. A exceção chega ao
  -- client como erro e `useNearbyDrivers` a registra no console.
  --
  -- A exceção desfaz (rollback) o incremento DESTA chamada — de propósito e sem
  -- prejuízo: o contador já está no teto por causa das chamadas anteriores, que
  -- comitaram, e continua no teto até a janela virar.
  v_bucket := md5('goxl:nearby:' || v_uid::text);

  if not public.check_public_lookup_rate_limit(
       v_bucket, 'nearby_online_drivers:short', c_rl_short_max, c_rl_short_secs,
       c_rl_max_buckets)
  then
    raise exception 'nearby_online_drivers: rate limit (janela curta) excedido'
      using errcode = '53400';
  end if;

  if not public.check_public_lookup_rate_limit(
       v_bucket, 'nearby_online_drivers:long', c_rl_long_max, c_rl_long_secs,
       c_rl_max_buckets)
  then
    raise exception 'nearby_online_drivers: rate limit (janela longa) excedido'
      using errcode = '53400';
  end if;

  -- ── Âncora: o centro pedido tem de ficar perto de onde o servidor já viu o
  -- chamador. Duas fontes possíveis, nesta ordem:
  --   (a) o próprio motorista, quando ele usa o app de passageiro — a linha
  --       dele em `driver_locations`;
  --   (b) a origem da corrida mais recente do chamador como passageiro.
  -- Se NÃO houver nenhuma das duas (conta nova — o caso do Cadastro Expresso),
  -- não há o que ancorar e a chamada passa. Ver o LIMITE HONESTO: este é o
  -- buraco residual, e ele está aqui escrito em vez de escondido.
  select dl.lat, dl.lng into v_anchor_lat, v_anchor_lng
    from public.driver_locations dl
   where dl.driver_id = v_uid
   limit 1;

  if v_anchor_lat is null then
    select r.origin_lat, r.origin_lng into v_anchor_lat, v_anchor_lng
      from public.rides r
     where r.passenger_id = v_uid
     order by r.created_at desc
     limit 1;
  end if;

  -- ── REJEIÇÃO DE ÂNCORA LEVANTA, não devolve vazio ────────────────────────
  -- Este ramo devolvia conjunto vazio, e isso contradizia — 40 linhas acima, no
  -- mesmo corpo de função — o argumento que fez o rate limit levantar exceção:
  -- "o conjunto vazio é indistinguível de 'não há carro por perto'". A
  -- indistinguibilidade é a mesma aqui, e a consequência é pior, porque a
  -- recusa de âncora é PERSISTENTE: o passageiro que voou para outra cidade
  -- veria "não há carros em Orlando" a cada poll, indefinidamente, e o app não
  -- teria como saber que o servidor está recusando o centro em vez de não achar
  -- ninguém.
  --
  -- Não vaza nada sobre terceiros: o veredito depende só da última posição
  -- conhecida DO PRÓPRIO chamador, que ele já conhece melhor que nós.
  --
  -- O `errcode` é distinto do 53400 do rate limit de propósito — é ele que
  -- permite contar, no log, quantos usuários LEGÍTIMOS a âncora está barrando.
  -- Esse número é o único insumo honesto para mexer em `c_anchor_km`; sem ele a
  -- escolha de 50 km seria permanentemente um chute. NÃO MEDIDO AQUI.
  if v_anchor_lat is not null and v_anchor_lng is not null then
    if 6371 * acos(least(1, greatest(-1,
         sin(radians(v_anchor_lat)) * sin(radians(p_lat))
       + cos(radians(v_anchor_lat)) * cos(radians(p_lat)) * cos(radians(p_lng - v_anchor_lng))
       ))) > c_anchor_km then
      raise exception 'nearby_online_drivers: centro pedido fora do alcance da última posição conhecida do chamador'
        using errcode = '22023';
    end if;
  end if;

  v_radius := least(greatest(coalesce(p_radius_km, 8), c_min_radius_km), c_max_radius_km);

  -- Caixa envolvente para o prefiltro: barato e sargable. 111,045 km por grau
  -- de latitude; em longitude o grau encolhe por cos(lat).
  --
  -- O piso de 0,01 no cosseno é uma REDE DE SEGURANÇA que, no domínio aceito,
  -- nunca é acionada: o guard de entrada recusa |lat| > 85 exatamente para que
  -- cos(lat) na borda da caixa fique ≥ ~0,085. Se ele fosse acionado, a caixa
  -- ficaria ESTREITA DEMAIS e deixaria de ser superconjunto do círculo — que é
  -- justamente o que o guard existe para impedir. Ele fica aqui porque uma
  -- divisão por zero seria pior que uma caixa errada, não porque cubra o polo.
  v_lat_delta := v_radius / 111.045;
  v_lng_delta := v_radius / (111.045 * greatest(abs(cos(radians(p_lat))), 0.01));

  -- ── O ARREDONDAMENTO VEM ANTES DO FILTRO — a ordem É o conserto ───────────
  -- A versão anterior deste bloco dizia, com todas as letras: "O FILTRO usa a
  -- coordenada exata (o raio tem de estar certo); só o RETORNO é arredondado."
  -- Isso anulava o arredondamento inteiro. Com o filtro sobre a coordenada
  -- exata, a PERTINÊNCIA ao conjunto devolvido é uma função da posição exata, e
  -- pertinência é observável: o chamador escolhe centro e raio livremente, então
  -- ele varre o raio (ou desloca o centro) e vê o motorista entrar e sair do
  -- resultado. Cada resposta é um teste "está dentro deste círculo?", e três
  -- círculos localizam um ponto — trilateração. O limite não era os 111 m da
  -- grade; era a precisão do ponto flutuante. Os 111 m eram enfeite.
  --
  -- Agora TUDO o que decide o resultado é calculado sobre a coordenada já
  -- arredondada (CTE `snapped`): o corte do círculo, a ordenação e o desempate.
  -- Consequência: o conjunto devolvido é função exclusiva dos valores que já
  -- estão NA RESPOSTA. Varrer o raio passa a não revelar nada além da célula da
  -- grade — que é justamente o que a função se propõe a divulgar.
  --
  -- A caixa envolvente continua sobre a coluna CRUA porque é o único formato
  -- que o índice em (lat, lng) usa. Ela não decide nada: está alargada em meia
  -- célula, o máximo que o arredondamento move um ponto, o que a torna um
  -- superconjunto garantido do círculo arredondado. Uma linha que a caixa deixa
  -- passar ainda pode ser recusada pelo haversine; uma que ela recusa jamais
  -- passaria no haversine.
  --
  -- `order by` pela distância ARREDONDADA (e não por `driver_id`): preserva o
  -- "mais perto primeiro" que o mapa espera, e não vaza nada, porque a ordem é
  -- inteiramente recalculável a partir das linhas devolvidas. O desempate por
  -- `driver_id` existe para o corte do `limit` ser determinístico entre duas
  -- linhas da MESMA célula.
  --
  -- `heading` não aparece nem aqui nem na assinatura.
  return query
  with snapped as (
    select dl.driver_id                                              as driver_id,
           round(dl.lat::numeric, c_grid_decimals)::double precision as lat,
           round(dl.lng::numeric, c_grid_decimals)::double precision as lng
      from public.driver_locations dl
     where dl.is_online = true
       and dl.updated_at > now() - interval '10 minutes'
       and dl.lat between p_lat - v_lat_delta - c_half_cell
                      and p_lat + v_lat_delta + c_half_cell
       and dl.lng between p_lng - v_lng_delta - c_half_cell
                      and p_lng + v_lng_delta + c_half_cell
  )
  select s.driver_id, s.lat, s.lng
    from snapped s
   -- Haversine para recortar o círculo dentro da caixa. `least/greatest`
   -- protege o `acos` de sair de [-1, 1] por erro de ponto flutuante.
   where 6371 * acos(least(1, greatest(-1,
           sin(radians(p_lat)) * sin(radians(s.lat))
         + cos(radians(p_lat)) * cos(radians(s.lat)) * cos(radians(s.lng - p_lng))
         ))) <= v_radius
   order by 6371 * acos(least(1, greatest(-1,
           sin(radians(p_lat)) * sin(radians(s.lat))
         + cos(radians(p_lat)) * cos(radians(s.lat)) * cos(radians(s.lng - p_lng))
         ))) asc,
         s.driver_id asc
   limit c_max_rows;
end;
$$;

revoke all    on function public.nearby_online_drivers(double precision, double precision, double precision) from public;
revoke all    on function public.nearby_online_drivers(double precision, double precision, double precision) from anon;
grant execute on function public.nearby_online_drivers(double precision, double precision, double precision) to authenticated;

comment on function public.nearby_online_drivers(double precision, double precision, double precision) is
  'Motoristas online num raio do ponto informado, para o mapa do passageiro (useNearbyDrivers.ts). Substitui o SELECT direto em driver_locations, que devolvia a frota inteira. A coordenada é ARREDONDADA para 3 casas (~110 m) ANTES do filtro, e não só na projeção: com o `where`/`order by` sobre a coordenada exata, pertencer ao resultado era função da posição exata e o chamador trilaterava variando centro e raio — a grade era enfeite. `heading` NÃO é devolvido: posição mais rumo, amostrados no tempo, formam trilha de deslocamento de pessoa identificável. Raio grampeado em [2; 15] km, teto de 60 linhas, exige sessão, rate limit por auth.uid() (check_public_lookup_rate_limit) e o centro pedido tem de ficar a menos de 50 km de uma posição já conhecida do chamador, quando existir alguma (fora disso LEVANTA errcode 22023, não devolve vazio — vazio seria indistinguível de "não há carro por perto"). Domínio de entrada deliberadamente menor que o globo: |lat| ≤ 85 e |lng| ≤ 178, porque fora disso a caixa envolvente do prefiltro deixa de ser superconjunto do círculo (piso do cosseno / emenda do antimeridiano) e a função devolveria menos linhas sem errar. `volatile` porque chama a RPC de rate limit, que escreve. `security definer` porque authenticated perdeu o SELECT de lat/lng/heading na 0069 B.1. NÃO fecha o mosaico: uma conta nova não tem âncora — ver o LIMITE HONESTO no corpo da 0069 B.2.';

-- ─────────────────────────────────────────────────────────────────────────────
-- B.3 — A policy ampla `is_online = true` PERDEU O ÚLTIMO CONSUMIDOR LEGÍTIMO.
--
-- A 0067 B.1 manteve `using (is_online = true)` de propósito e escreveu por quê:
-- o mapa do passageiro dependia dela antes de existir corrida, e "estreitá-la
-- para um raio exige mudar o client junto". As duas coisas que faltavam
-- aconteceram desde então:
--
--   • o mapa saiu dela — `useNearbyDrivers` passou a chamar a RPC (B.2 acima),
--     que é `security definer` e não depende de policy nenhuma;
--   • o push de despacho saiu dela — `notifyOnlineDrivers`/
--     `pushSilentRevokeToOnlineDrivers` (useRide.ts:190 e :365) NÃO consultam
--     mais `driver_locations`: o leque é derivado no servidor, com a service
--     key, dentro de `send-ride-push`. Essa mudança fechou um defeito próprio
--     (leitura vazia no client cancelava a distribuição inteira em silêncio) e,
--     de quebra, deixou esta policy sem cliente.
--
-- Conferido um a um, o que ainda LÊ `driver_locations` com a chave do usuário:
--   • useDriverPeriodTracker.ts:142 — `.eq('driver_id', driverId)`, a PRÓPRIA
--     linha do motorista → coberta pela policy de B.3 da 0067 (`for all` inclui
--     select);
--   • ActiveRideScreen — a posição do motorista da corrida em andamento →
--     coberta pela policy ESTREITA da 0009 (B.2 da 0067).
-- Nenhum dos dois precisa do ramo amplo. O que o ramo amplo ainda entrega, e
-- só isso, é: qualquer conta logada lista QUEM está online e desde quando
-- (`is_online_changed_at`) — a agenda de trabalho da frota inteira, nome por
-- nome depois de cruzar com o diretório de usuários. Sem coordenada, desde a
-- B.1, mas ainda é vigilância de rotina de pessoa identificável.
--
-- ⚠️ CUSTO REAL, NOMEADO: `useNearbyDrivers.ts:139-147` assina realtime em
-- `driver_locations` para disparar refetch. O Realtime respeita RLS, então
-- depois deste drop o passageiro deixa de receber esses eventos e o mapa passa
-- a andar SÓ pelo poll de 8 s (useNearbyDrivers.ts:121), que é o caminho
-- garantido e sempre foi. Efeito colateral bom: o pior caso de chamadas cai de
-- ~28/min para 7,5/min, folga que o rate limit da RPC agradece.
drop policy if exists "Passageiro vê motoristas online" on public.driver_locations;

comment on table public.driver_locations is
  'Posição ao vivo dos motoristas. Toda policy é `to authenticated` desde a 0067. Desde a 0069, `authenticated` NÃO tem mais SELECT em lat/lng/heading (coordenada só sai pela RPC nearby_online_drivers ou por service_role) e o ramo amplo `is_online = true` FOI REMOVIDO: com o mapa na RPC e o leque de push derivado no servidor, ele não tinha mais consumidor e só entregava a agenda de trabalho da frota. Restam duas policies de SELECT: a própria linha do motorista e o motorista da corrida ativa do passageiro.';

-- ═════════════════════════════════════════════════════════════════════════════
-- C. `profiles.driver_code` passa a ser único de verdade
-- ═════════════════════════════════════════════════════════════════════════════
--
-- O código é derivado do UUID por `codeFromId`
-- (src/screens/driver/QRCodeScreen.tsx:23-33), e o JSDoc dessa função AFIRMAVA
-- "Único porque UUIDs são únicos. Não precisa de consulta ao banco". Falso: a
-- função lê 6 bytes do UUID e aplica `byte % 32` em cada um, jogando 128 bits
-- em 32^6 ≈ 2^30. Isso DESCARTA ~98 bits — a unicidade da entrada não
-- sobrevive a uma função que não é injetiva.
--
-- E a 0007:6 criou um índice COMUM (`create index`), não único. Nada no banco
-- impedia dois motoristas com o mesmo código. Na primeira colisão, o
-- `.maybeSingle()` da Edge Function virava erro e o Cadastro Expresso quebrava
-- para os DOIS, devolvendo `{driver:null}` — "código inválido" na tela, sem
-- nenhum sinal de que a causa era colisão.
--
-- Aniversário: com N motoristas, a chance de alguma colisão é ~1 - e^(-N²/2·2³⁰).
-- Para N = 1.000 é ~0,05%; para N = 10.000, ~4,5%. Não é iminente, é inevitável
-- se a frota crescer — e o modo de falha é o pior tipo: silencioso e para
-- terceiros.
--
-- O conserto tem três partes; duas estão aqui:
--   1. o índice ÚNICO (C.2), que impede colisão nova;
--   2. a desduplicação do que já existe (C.1), para a migração não abortar;
--   3. o caminho de retentativa com sal no escritor
--      (QRCodeScreen.tsx `codeFromId(id, attempt)`), fora deste arquivo.
--
-- ⚠️ E há um SEGUNDO defeito na mesma coluna, que a unicidade não resolve e
-- chega a piorar: o valor é escolhido pelo CLIENTE e é PREVISÍVEL a partir de
-- um id público, então dá para reservar de propósito o código de um motorista
-- escolhido a dedo e o índice único faz o resto do trabalho. É a C.3.

-- ─────────────────────────────────────────────────────────────────────────────
-- C.1 — Duplicatas PRÉ-EXISTENTES não podem abortar a migração.
--
-- `create unique index` falha se já houver duplicata, e a migração inteira
-- (incluindo as seções A e B, que são segurança) morreria junto. Então
-- desduplica ANTES, de forma determinística: mantém o menor `id` e ZERA o
-- código dos demais.
--
-- Zerar em vez de re-sortear aqui: gerar um código novo no SQL exigiria
-- reimplementar `codeFromId` em plpgsql, criando uma segunda definição do
-- formato que passaria a poder divergir do TypeScript. Com `null`, o próximo
-- open da tela de QR do motorista gera e grava um código novo — agora pelo
-- caminho com retentativa. O custo é real e vale nomear: o QR JÁ IMPRESSO
-- desses motoristas para de resolver até eles abrirem a tela. Só que ele já
-- estava quebrado — era exatamente a colisão que derrubava os dois.
--
-- ── POR QUE UM `raise warning` NÃO BASTA (correção da iteração 4) ─────────
-- A primeira versão desta seção só contava as linhas afetadas e emitia um
-- `raise warning`. Isso é operacionalmente inútil e vale ser específico:
--   • `npx supabase db push` — o caminho de deploy que este arquivo mesmo
--     recomenda no cabeçalho — despeja centenas de linhas de saída, e um
--     `warning` no meio some por rolagem. Ninguém é obrigado a ler nada;
--   • mesmo que alguém LEIA, a mensagem diz "3 perfis" e não diz QUAIS. A ação
--     que ela pede — "avise esses motoristas, o QR impresso parou de valer" —
--     é impossível de executar depois que o `update` já apagou a evidência. O
--     código antigo não existe mais em lugar nenhum;
--   • trata um efeito destrutivo sobre dados de motoristas reais como um
--     detalhe de log.
-- Então a tabela abaixo REGISTRA cada linha afetada, com o código antigo, antes
-- de zerar. É a única cópia que sobra, e é o que torna a mensagem acionável.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.driver_code_dedupe_audit (
  id           bigint generated always as identity primary key,
  profile_id   uuid        not null,
  old_code     text        not null,
  kept_by      uuid        not null,
  migration    text        not null default '0069',
  nulled_at    timestamptz not null default now()
);

comment on table public.driver_code_dedupe_audit is
  'Quem perdeu o driver_code na desduplicação da 0069 C.1, e qual era o código. Existe porque o `update` que zera é destrutivo e irreversível: sem esta linha não há como responder "quais motoristas precisam reimprimir o QR?". `kept_by` é o perfil que ficou com o código. Tabela operacional, não de produto: só service_role lê.';

-- Fechada por padrão. RLS ligada SEM policy nenhuma = nega tudo para anon e
-- authenticated mesmo que algum privilégio default do schema `public` conceda
-- SELECT — que é exatamente a armadilha que a 0067 documenta e que a seção A
-- desta migration teve de reaplicar. Cinto e suspensório de propósito.
alter table public.driver_code_dedupe_audit enable row level security;
revoke all on table public.driver_code_dedupe_audit from anon, authenticated;
grant select, insert on table public.driver_code_dedupe_audit to service_role;

do $$
declare
  v_dupes integer;
begin
  -- 1. REGISTRA antes de destruir. `kept_by` é o menor `id` daquele código —
  --    o mesmo critério determinístico que o `update` abaixo usa para escolher
  --    quem fica.
  with ranked as (
    select id,
           driver_code,
           row_number() over (partition by driver_code order by id) as rn,
           first_value(id) over (partition by driver_code order by id) as keeper
      from public.profiles
     where driver_code is not null
  )
  insert into public.driver_code_dedupe_audit (profile_id, old_code, kept_by)
  select r.id, r.driver_code, r.keeper
    from ranked r
   where r.rn > 1;

  get diagnostics v_dupes = row_count;

  -- 2. Só então zera.
  with ranked as (
    select id,
           row_number() over (partition by driver_code order by id) as rn
      from public.profiles
     where driver_code is not null
  )
  update public.profiles p
     set driver_code = null
    from ranked r
   where p.id = r.id
     and r.rn > 1;

  if v_dupes > 0 then
    raise warning '0069: % perfil(is) tinham driver_code DUPLICADO; o código foi zerado e será regerado no próximo open da tela de QR. QUEM SÃO e qual era o código: select * from public.driver_code_dedupe_audit where migration = ''0069''; O QR impresso antigo desses motoristas parou de valer (ele já não funcionava).', v_dupes;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- C.2 — O índice único.
--
-- Parcial (`where driver_code is not null`) por duas razões: o índice fica
-- menor, e a intenção fica escrita — vários perfis SEM código são normais (todo
-- passageiro, e todo motorista que ainda não abriu a tela do QR).
--
-- `create index if not exists` (não `concurrently`): este arquivo roda dentro de
-- uma transação, e `concurrently` é proibido em transação. A tabela `profiles`
-- é pequena o bastante para o lock valer os milissegundos.
--
-- O índice comum de 0007:6 (`profiles_driver_code_idx`) fica onde está: é
-- redundante com este, mas dropá-lo é uma mudança de performance sem relação
-- com o defeito, e não é o que este arquivo veio fazer.
-- ─────────────────────────────────────────────────────────────────────────────
-- O `drop` antes: `create unique index if not exists` casa pelo NOME, não pela
-- definição. Num banco onde uma versão anterior desta migration já criou o
-- índice com o predicado antigo (só `driver_code is not null`), o `if not
-- exists` o daria por bom e o `type = 'driver'` da C.3 nunca entraria.
drop index if exists public.profiles_driver_code_unique_idx;

create unique index if not exists profiles_driver_code_unique_idx
  on public.profiles (driver_code)
  where driver_code is not null and type = 'driver';

comment on index public.profiles_driver_code_unique_idx is
  'Unicidade de driver_code. Ver 0069 seção C: codeFromId mapeia 128 bits de UUID em 32^6, não é injetiva, e sem esta restrição a primeira colisão quebrava o Cadastro Expresso dos dois motoristas envolvidos. O `type = ''driver''` do predicado é redundante com o CHECK da C.3 e está aqui de propósito: se um dia o CHECK cair, o índice sozinho ainda casa com o WHERE de resolve-driver-code (driver_code + type).';

-- ─────────────────────────────────────────────────────────────────────────────
-- C.3 — `driver_code` deixa de ser campo livre do cliente.
--
-- ── O DEFEITO ────────────────────────────────────────────────────────────────
-- Quem grava `profiles.driver_code` é o CLIENTE, com a chave do próprio
-- usuário: `QRCodeScreen.tsx:57-60` faz `update({driver_code}).eq('id', id)`.
-- E o guard de campos privilegiados (0065:1207, herdado de 0018/0043/0055) NÃO
-- lista essa coluna — ela nunca esteve na lista de nenhuma das quatro versões.
-- Consequência direta: qualquer conta autenticada escreve QUALQUER valor ali, e
-- reescreve quantas vezes quiser.
--
-- Isso importa porque o código é PREVISÍVEL. `codeFromId` (src/lib/driverCode.ts)
-- é determinística sobre o `profiles.id`, e o `id` é público — sai em
-- `profiles_public` para toda conta logada. Então:
--
--   1. o atacante lê o `id` do motorista alvo em `profiles_public`;
--   2. calcula `codeFromId(id_do_alvo)` — a mesma função que a tela do alvo vai
--      usar, sem sal, `attempt = 0`;
--   3. grava esse código no PRÓPRIO perfil, antes de o alvo abrir a tela do QR.
--
-- O alvo abre a tela, bate no 23505, o laço de retentativa o saliza e ele
-- termina com OUTRO código (QRCodeScreen.tsx:71-74). Isto é: o material impresso
-- do motorista — o QR que ele distribui, a razão de a coluna existir — nunca
-- resolve para ele. E não há erro em tela nenhuma: do ponto de vista do alvo o
-- código simplesmente "é outro".
--
-- Pior, e é o detalhe que torna o alvo escolhível a dedo: um perfil de
-- PASSAGEIRO também podia segurar um código. `resolve-driver-code/index.ts:443`
-- filtra `.eq('type','driver')`, então o código sequestrado por um passageiro
-- não resolve para ninguém — mas o índice único da C.2 conta a linha do mesmo
-- jeito. O resultado é negação pura: o código fica queimado, o motorista perde o
-- dele, e não existe pergunta que devolva "por quê" (o dono do código nem
-- aparece na consulta que a Edge Function faz).
--
-- ── O CONSERTO, E O QUE ELE NÃO ALCANÇA ─────────────────────────────────────
-- Três partes, nenhuma delas tocando `codeFromId`: os vetores dela estão
-- fixados por teste (`driverCode.test.ts:98-104`) e o formato já circula
-- impresso — mudar a derivação invalidaria QR de campo.
--
--   1. o trigger abaixo: no INSERT o cliente nunca define `driver_code`; no
--      UPDATE o valor só pode ir de NULL para alguma coisa, e só em perfil que
--      JÁ É `type = 'driver'` E JÁ ESTÁ `verification_status = 'approved'`.
--      Depois de existir, é imutável para o cliente;
--   2. o CHECK: perfil que não é motorista não carrega código — o que fecha a
--      negação por passageiro na camada do banco, não só na do trigger;
--   3. o predicado do índice (C.2 acima) ganha `type = 'driver'` junto.
--
-- A exigência de `approved` no item 1 não é decoração: ver o bloco longo no
-- corpo do trigger. Sem ela, os itens 2 e 3 PIORAM o ataque — obrigam o
-- sequestrador a ser motorista, que é justamente o filtro de
-- `resolve-driver-code`, e o QR impresso do alvo passa a resolver para o
-- atacante em vez de morrer.
--
-- ⚠️ LIMITE HONESTO: isto NÃO torna o código imprevisível. Um atacante que
-- consiga um perfil de motorista APROVADO ainda tem uma gravação NULL→valor e
-- ainda pode gastá-la num código previsível de um alvo — uma vez, sem poder
-- rodar a lista nem soltar e retomar. O que mudou é que essa conta agora custa
-- passar pela verificação documental, e é rastreável até uma pessoa que
-- entregou documentos. Fechar a CLASSE exige gerar o código NO SERVIDOR
-- (sorteio aleatório com retentativa, sob service key) — mudança de produto que
-- troca o formato do QR e por isso não entra nesta migration.
-- ─────────────────────────────────────────────────────────────────────────────

-- A auditoria da C.1 vira o registro dos DOIS tipos de zeragem desta migration.
-- `kept_by` deixa de ser obrigatória: na C.1 ela é "quem ficou com o código";
-- aqui não fica ninguém — o código volta a ficar livre.
alter table public.driver_code_dedupe_audit
  alter column kept_by drop not null;

alter table public.driver_code_dedupe_audit
  add column if not exists reason text not null default 'duplicate';

comment on column public.driver_code_dedupe_audit.reason is
  '''duplicate'' = zerado pela desduplicação da 0069 C.1 (dois perfis com o mesmo código; `kept_by` diz quem ficou). ''not_a_driver'' = zerado pela 0069 C.3 antes do CHECK, porque o perfil não é `type = ''driver''` e o código estava ocupando o espaço de nomes de graça; `kept_by` é nula.';

-- Limpeza ANTES do CHECK: `add constraint` valida as linhas existentes e
-- abortaria a migration inteira se um único perfil não-motorista tivesse
-- código. Registra antes de destruir, mesma razão da C.1 — o valor antigo não
-- existe em nenhum outro lugar depois do update.
--
-- Interação com a C.1, que roda antes: se um passageiro sequestrador e o
-- motorista alvo dividiam o código, a C.1 desempata por `id` e pode ter ficado
-- com o do PASSAGEIRO, zerando o do motorista. Não é problema, e vale dizer por
-- quê em vez de deixar o leitor conferir: esta limpeza zera o do passageiro
-- logo em seguida, o código volta a ficar livre, e a tela de QR do motorista
-- regenera pelo `attempt = 0` — que é exatamente o código original. O caso se
-- conserta sozinho; o que fica é a linha de auditoria dos dois lados.
do $$
declare
  v_squatted integer;
begin
  insert into public.driver_code_dedupe_audit (profile_id, old_code, kept_by, reason)
  select p.id, p.driver_code, null, 'not_a_driver'
    from public.profiles p
   where p.driver_code is not null
     and p.type is distinct from 'driver';

  get diagnostics v_squatted = row_count;

  update public.profiles
     set driver_code = null
   where driver_code is not null
     and type is distinct from 'driver';

  if v_squatted > 0 then
    raise warning '0069 C.3: % perfil(is) NÃO-motorista(s) seguravam driver_code; o código foi liberado. QUEM SÃO: select * from public.driver_code_dedupe_audit where reason = ''not_a_driver''; Se algum desses códigos for previsível a partir do id de um motorista real (codeFromId), trate como sequestro tentado, não como sujeira de dados.', v_squatted;
  end if;
end $$;

create or replace function public.guard_driver_code()
returns trigger
language plpgsql
security definer
-- `pg_catalog` primeiro: ver a nota na B.2.0.
set search_path = pg_catalog, public
as $$
declare
  v_role text := auth.role();
begin
  -- Mesma porta do guard de 0065: quem escreve com a service key é o servidor
  -- (delete-account zera o código, admin-* lê). Sem JWT (psql, migração) também
  -- passa — é o contexto do operador, não o do app.
  if v_role is null or v_role = 'service_role' then
    return new;
  end if;

  -- INSERT: o perfil é criado PELO CLIENTE (0065 B.2 documenta que não existe
  -- criação server-side desde a 0062). Nenhum dos dois caminhos de criação
  -- reais manda `driver_code` — AuthContext.tsx:175 e ExpressRegisterScreen.tsx:87
  -- foram conferidos coluna a coluna —, então zerar aqui não recorta fluxo
  -- nenhum e fecha a porta de nascer já com o código de outro.
  if tg_op = 'INSERT' then
    new.driver_code := null;
    return new;
  end if;

  -- UPDATE: reverte qualquer mudança, EXCETO a primeira atribuição num perfil
  -- que já é de motorista.
  --
  -- `old.type` e não `new.type`, e isto não é preciosismo: os dois triggers
  -- BEFORE UPDATE de `profiles` rodam em ordem alfabética de NOME, e
  -- `trg_guard_driver_code` vem antes de `trg_guard_profile_privileged_fields`.
  -- Ou seja, quando este código roda, `new.type` ainda é o que o CLIENTE
  -- mandou — a reversão de `type` só acontece depois. Ler `old.type` tira a
  -- ordem dos triggers da conta: um passageiro que mande
  -- `{type:'driver', driver_code:'ABC234'}` no mesmo update não engana nada.
  -- `verification_status = 'approved'` é a trava que dá custo real ao sequestro,
  -- e ela entrou DEPOIS de uma revisão apontar que as outras três regras, juntas,
  -- pioravam o ataque em vez de conter. O raciocínio, porque é contraintuitivo:
  --
  --   ANTES da C.3, o sequestrador mais provável era um PASSAGEIRO — bastava
  --   gravar o código do alvo no próprio perfil. Isso queimava o código (o alvo
  --   levava 23505 e era salgado), mas `resolve-driver-code` filtra
  --   `type = 'driver'` (index.ts:467), então o QR já impresso do alvo resolvia
  --   para NINGUÉM. Prejuízo: negação.
  --
  --   COM o CHECK e o predicado do índice, código só existe em perfil
  --   `type = 'driver'`. Isso não impede o sequestro — `type` é escolhido
  --   livremente no INSERT (0065 B.2) e contas são grátis —, apenas OBRIGA o
  --   sequestrador a ser motorista. E aí o filtro de `resolve-driver-code` passa
  --   a casar com ELE: o QR impresso do alvo deixa de estar morto e passa a
  --   resolver para o atacante, que recebe a corrida travada e o ponto de origem
  --   do passageiro. Negação virou redirecionamento — estritamente pior.
  --
  --   `approved` corta isso porque não é auto-atribuível: 0018/0043/0055 só
  --   deixam o dono da linha ir para `pending`, e `approved` sai de admin com
  --   service key. O custo do ataque sobe de "criar conta" para "passar pela
  --   verificação documental da GoXL".
  --
  -- Não recorta fluxo legítimo: `driver_can_go_online` já exige
  -- `verification_status = 'approved'` (0059:263). Motorista não aprovado não
  -- fica online, logo o QR dele não receberia corrida de todo jeito — a tela de
  -- QR simplesmente não exibe código até a aprovação sair, que é a verdade.
  if new.driver_code is distinct from old.driver_code then
    if old.driver_code is not null
       or old.type is distinct from 'driver'
       or old.verification_status is distinct from 'approved' then
      new.driver_code := old.driver_code;
    end if;
  end if;

  return new;
end;
$$;

comment on function public.guard_driver_code() is
  'Impede o cliente de escolher `profiles.driver_code`. INSERT: sempre nulo. UPDATE: só NULL→valor, e só em perfil que já é type=''driver'' E já está verification_status=''approved''. service_role passa. Ver 0069 C.3: codeFromId é determinística sobre um id público, então sem isto qualquer conta reservava o código do QR de um motorista escolhido a dedo. A exigência de ''approved'' existe porque o CHECK e o predicado do índice, sozinhos, obrigariam o sequestrador a ser motorista — que é o filtro de resolve-driver-code — e transformariam negação em redirecionamento da corrida.';

-- Trigger SEPARADO em vez de acrescentar a coluna ao guard de 0065: aquele
-- corpo tem ~130 linhas e teria de ser copiado inteiro para cá só para ganhar
-- um `if`, criando uma segunda definição que passaria a poder divergir. Dois
-- triggers BEFORE na mesma tabela mexendo em colunas disjuntas compõem sem
-- conflito — a única interação é a ordem, tratada acima com `old.type`.
-- `insert or update` porque a criação do perfil é do cliente.
drop trigger if exists trg_guard_driver_code on public.profiles;
create trigger trg_guard_driver_code
  before insert or update on public.profiles
  for each row execute function public.guard_driver_code();

-- Segunda camada, independente do trigger: o trigger é reescrevível por
-- migration futura e roda só sob `auth.role()` de app; o CHECK vale para TODO
-- escritor, inclusive service_role e psql.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.profiles'::regclass
       and conname  = 'profiles_driver_code_only_for_drivers'
  ) then
    alter table public.profiles
      add constraint profiles_driver_code_only_for_drivers
      check (driver_code is null or type = 'driver');
  end if;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- Z. Asserções — falham alto se qualquer seção acima ficar pela metade
-- ═════════════════════════════════════════════════════════════════════════════
do $$
begin
  -- Z.1 — `driver_code` realmente saiu da view.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'profiles_public'
       and column_name  = 'driver_code'
  ) then
    raise exception '0069 incompleta: profiles_public ainda expõe driver_code';
  end if;

  -- Z.2 — recriar a view não pode ter devolvido SELECT a `anon`.
  if exists (select 1 from pg_roles where rolname = 'anon')
     and has_table_privilege('anon', 'public.profiles_public', 'SELECT') then
    raise exception '0069 incompleta: anon voltou a ter SELECT em public.profiles_public (default privilege do schema public)';
  end if;

  -- Z.3 — as nove telas do app dependem desta view; ela não pode ter ficado
  -- sem grant para `authenticated`.
  if exists (select 1 from pg_roles where rolname = 'authenticated')
     and not has_table_privilege('authenticated', 'public.profiles_public', 'SELECT') then
    raise exception '0069 quebrada: authenticated perdeu SELECT em public.profiles_public';
  end if;

  -- Z.4 — coordenada fora do alcance do SELECT direto, e as demais colunas
  -- ainda ao alcance (senão useRide.ts:197 para de achar motorista online).
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    if has_column_privilege('authenticated', 'public.driver_locations', 'lat', 'SELECT') then
      raise exception '0069 incompleta: authenticated ainda lê driver_locations.lat';
    end if;
    if has_column_privilege('authenticated', 'public.driver_locations', 'lng', 'SELECT') then
      raise exception '0069 incompleta: authenticated ainda lê driver_locations.lng';
    end if;
    -- O consumidor destes dois grants MUDOU. Era useRide.ts:197 (a lista de
    -- motoristas online para o push); esse leitor não existe mais — o leque é
    -- derivado no servidor. Quem depende deles hoje é o MOTORISTA lendo a
    -- PRÓPRIA linha em useDriverPeriodTracker.ts:142-145, que é o que reconcilia
    -- o período de trabalho depois de o app ser morto e reaberto.
    if not has_column_privilege('authenticated', 'public.driver_locations', 'driver_id', 'SELECT') then
      raise exception '0069 quebrada: authenticated perdeu driver_locations.driver_id (useDriverPeriodTracker.ts:142 depende dele)';
    end if;
    if not has_column_privilege('authenticated', 'public.driver_locations', 'is_online', 'SELECT') then
      raise exception '0069 quebrada: authenticated perdeu driver_locations.is_online';
    end if;
    if not has_function_privilege('authenticated', 'public.nearby_online_drivers(double precision, double precision, double precision)', 'EXECUTE') then
      raise exception '0069 quebrada: authenticated não pode executar nearby_online_drivers (mapa do passageiro morre)';
    end if;
  end if;

  -- Z.5 — sem duplicata de driver_code restante.
  if exists (
    select 1 from public.profiles
     where driver_code is not null
     group by driver_code having count(*) > 1
  ) then
    raise exception '0069 incompleta: ainda há driver_code duplicado';
  end if;

  -- Z.6 — o índice existe E É ÚNICO. Conferir só a existência pelo nome não
  -- assere nada: a 0007:6 já criava um índice comum sobre a mesma coluna, e o
  -- `create unique index if not exists` da C.2 casa pelo NOME — num banco onde
  -- uma versão anterior deste arquivo tenha criado a variante não-única (ou o
  -- predicado antigo), a C.2 sairia calada e a Z.5 passaria por sorte, porque
  -- ela só olha os dados de HOJE. `indisunique` é o que responde a pergunta.
  if not exists (
    select 1 from pg_index i
      join pg_class c on c.oid = i.indexrelid
     where c.relname = 'profiles_driver_code_unique_idx'
       and i.indisunique
  ) then
    raise exception '0069 incompleta: profiles_driver_code_unique_idx não existe ou não é UNIQUE — a colisão de driver_code continua possível';
  end if;

  -- Z.7 — o CHECK da C.3 (perfil não-motorista não segura código).
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.profiles'::regclass
       and conname  = 'profiles_driver_code_only_for_drivers'
  ) then
    raise exception '0069 incompleta: falta o CHECK profiles_driver_code_only_for_drivers';
  end if;

  -- Z.8 — o trigger da C.3 existe e está HABILITADO. `tgenabled = ''D''` é um
  -- trigger desabilitado: ele aparece em `\d` e não roda.
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.profiles'::regclass
       and tgname  = 'trg_guard_driver_code'
       and tgenabled <> 'D'
  ) then
    raise exception '0069 incompleta: trg_guard_driver_code ausente ou desabilitado — driver_code volta a ser campo livre do cliente';
  end if;

  -- Z.9 — o ramo amplo de driver_locations saiu (B.3) e os dois legítimos
  -- ficaram. A segunda metade importa tanto quanto a primeira: dropar a policy
  -- errada deixaria o motorista sem ler a própria posição.
  if exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename  = 'driver_locations'
       and policyname = 'Passageiro vê motoristas online'
  ) then
    raise exception '0069 incompleta: a policy ampla `is_online = true` continua em driver_locations';
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename  = 'driver_locations'
       and policyname = 'Motorista atualiza própria localização'
  ) then
    raise exception '0069 quebrada: driver_locations sem a policy da própria linha do motorista (useDriverPeriodTracker morre)';
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename  = 'driver_locations'
       and policyname = 'Passageiro vê localização do motorista ativo'
  ) then
    raise exception '0069 quebrada: driver_locations sem a policy da corrida ativa (o passageiro perde o carro no mapa durante a viagem)';
  end if;

  -- Z.10 — EXATAMENTE UMA `check_public_lookup_rate_limit`. Esta é a asserção
  -- mais importante do bloco em termos de raio de dano, e a menos óbvia.
  --
  -- A B.2.0 dropou a versão de 4 argumentos e criou a de 5 com default. Se as
  -- DUAS existirem — porque a 0067 foi reaplicada depois da 0069, o que
  -- `supabase db push` faz sem pestanejar num banco reconstruído fora de ordem —
  -- toda chamada de 4 argumentos vira `function is not unique`. E aí:
  --   • `resolve-driver-code` lê isso como `unavailable` e responde 503 — o
  --     Cadastro Expresso inteiro para;
  --   • `nearby_online_drivers` (que passa 5) continua funcionando, então o
  --     sintoma aparece num produto e não no outro, o que atrasa o diagnóstico.
  -- Zero funções é o outro extremo e quebra os dois.
  if (select count(*) from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname = 'check_public_lookup_rate_limit') <> 1 then
    raise exception '0069 quebrada: existe % versão(ões) de check_public_lookup_rate_limit — tem de ser exatamente 1 (a de 5 argumentos, 0069 B.2.0). Duas = "function is not unique" em toda chamada de 4 argumentos.',
      (select count(*) from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'check_public_lookup_rate_limit');
  end if;

  -- Z.11 — `nearby_online_drivers` e `check_public_lookup_rate_limit` têm o
  -- MESMO DONO.
  --
  -- Esta asserção existe porque o comentário da B.2 (:250-251) AFIRMAVA que o
  -- bloco Z já a fazia. Não fazia. E a afirmação não é decorativa: é o passo
  -- inteiro do raciocínio que explica por que uma função `security definer`
  -- consegue chamar a outra depois de a 0067 ter revogado EXECUTE de `public`,
  -- `anon` e `authenticated`. O que sobra é o privilégio do DONO — logo, se os
  -- donos divergirem, a chamada interna vira `permission denied for function
  -- check_public_lookup_rate_limit` e o mapa de motoristas para inteiro.
  --
  -- Divergir é plausível, não hipotético: basta uma das duas ser recriada por
  -- um papel diferente (migration aplicada com outra credencial, `psql` de um
  -- superusuário, restore parcial). O sintoma seria um erro em tempo de
  -- execução na RPC do mapa, longe daqui, sem nada apontando para a causa.
  -- As duas assinaturas são citadas por `::regprocedure`, não por `proname`:
  -- buscar por nome devolveria MAIS DE UMA linha se existisse sobrecarga, e um
  -- subquery escalar com duas linhas aborta com "more than one row returned by
  -- a subquery" — um erro que não diz nada sobre donos. Aqui, se a assinatura
  -- exata não existir, o erro já nomeia a função que falta.
  if (select proowner from pg_proc
       where oid = 'public.nearby_online_drivers(double precision, double precision, double precision)'::regprocedure)
     is distinct from
     (select proowner from pg_proc
       where oid = 'public.check_public_lookup_rate_limit(text, text, integer, integer, integer)'::regprocedure) then
    raise exception '0069 quebrada: nearby_online_drivers (dono %) e check_public_lookup_rate_limit (dono %) têm donos DIFERENTES. A chamada interna depende do EXECUTE do dono — ver 0069 B.2. Recrie as duas com o mesmo papel.',
      (select pg_get_userbyid(proowner) from pg_proc
        where oid = 'public.nearby_online_drivers(double precision, double precision, double precision)'::regprocedure),
      (select pg_get_userbyid(proowner) from pg_proc
        where oid = 'public.check_public_lookup_rate_limit(text, text, integer, integer, integer)'::regprocedure);
  end if;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- PROVAS PARA UM HUMANO RODAR (nenhuma delas rodou aqui)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- P1. A view perdeu a coluna e continua servindo as telas:
--       select * from public.profiles_public limit 1;   -- 5 colunas, sem driver_code
--
-- P2. Uma conta de passageiro comum NÃO lê coordenada. Pegue um JWT de
--     passageiro real (o app grava a sessão) e:
--       curl -s "$SUPABASE_URL/rest/v1/driver_locations?select=lat,lng" \
--         -H "apikey: $ANON_KEY" -H "Authorization: Bearer $PASSENGER_JWT"
--     ESPERADO: erro `permission denied for column lat`. 200 com dados aqui
--     significa que a B.1 não pegou.
--
--       curl -s "$SUPABASE_URL/rest/v1/driver_locations?select=driver_id,is_online" ...
--     ESPERADO desde a B.3: 200 com ZERO linha (ou só a própria, se o JWT for de
--     motorista). 200 listando a frota significa que o drop da policy ampla não
--     pegou. `permission denied` significa que o drop levou junto uma das duas
--     policies legítimas — a Z.9 deveria ter pego isso.
--
-- P3. A RPC respeita o raio e o teto:
--       select count(*) from public.nearby_online_drivers(28.5383, -81.3792, 8);
--       select count(*) from public.nearby_online_drivers(28.5383, -81.3792, 20000);
--     ESPERADO: o segundo NÃO pode devolver mais que o primeiro por causa do
--     raio pedido — 20000 é grampeado em 15 km — e nunca mais que 60 linhas.
--
-- P3b. O ORÁCULO DE TRILATERAÇÃO ESTÁ FECHADO. É a prova que importa da B.2, e
--      ela não é sobre contagem: é sobre a resposta NÃO mudar quando só a
--      pergunta muda dentro da célula. Com pelo menos um motorista online:
--
--        select * from public.nearby_online_drivers(28.5383,   -81.3792, 8);
--        select * from public.nearby_online_drivers(28.53831,  -81.37921, 8);
--        select * from public.nearby_online_drivers(28.538309, -81.379209, 8);
--
--      ESPERADO: as três devolvem EXATAMENTE as mesmas linhas, com as mesmas
--      coordenadas (todas múltiplas de 0,001). Diferença entre elas na BORDA do
--      raio é o oráculo de volta.
--
--      E o teste de varredura, que é como o ataque realmente se parece — pegue
--      um motorista devolvido e estreite o raio até ele sumir:
--        select * from public.nearby_online_drivers(<lat>, <lng>, 2);
--        select * from public.nearby_online_drivers(<lat>, <lng>, 2.0001);
--      ESPERADO: o ponto de corte cai numa distância calculável a partir da
--      coordenada ARREDONDADA que a função devolveu, e não numa distância mais
--      fina que isso. (O raio mínimo é 2 km — pedir menos é grampeado.)
--
-- P3c. `driver_code` não é mais escolhido pelo cliente (C.3). Com um JWT de
--      passageiro comum:
--        curl -s -X PATCH "$SUPABASE_URL/rest/v1/profiles?id=eq.$MEU_ID" \
--          -H "apikey: $ANON_KEY" -H "Authorization: Bearer $PASSENGER_JWT" \
--          -H 'Content-Type: application/json' -H 'Prefer: return=representation' \
--          -d '{"driver_code":"ABC234"}'
--      ESPERADO: 200 com `driver_code: null` no corpo devolvido. O trigger
--      REVERTE em silêncio (não levanta erro) — é o mesmo estilo do guard de
--      0065, e por isso a prova precisa olhar o corpo, não o status.
--
--      Com um JWT de motorista que JÁ tem código, tentando trocar:
--      ESPERADO: 200 e o código ANTIGO de volta no corpo.
--
-- P4. REALTIME — a verificação que mais importa e a que não dá para fazer
--     por SQL. O privilégio de COLUNA interage com o Realtime, e nada nesta
--     máquina observa esse comportamento. Depois de aplicar, com o app rodando:
--       (a) motorista online → o carro aparece e se MOVE no mapa do passageiro
--           (useNearbyDrivers usa a RPC + poll de 8 s; o realtime é só gatilho
--           de refetch, então mesmo se o payload vier sem colunas o mapa anda);
--       (b) motorista alterna online/offline → useDriverPeriodTracker.ts:210
--           registra WENT_ONLINE/WENT_OFFLINE (ele lê `is_online` e
--           `is_online_changed_at`, colunas que CONTINUAM concedidas).
--     SE (b) REGREDIR, o rollback é uma linha e devolve o estado da 0067:
--           grant select on public.driver_locations to authenticated;
--     (isso reabre a leitura de coordenada pela frota — é rollback, não fix.)
--
-- P5. Unicidade:
--       select driver_code, count(*) from public.profiles
--        where driver_code is not null group by 1 having count(*) > 1;
--     ESPERADO: zero linhas.
--       update public.profiles set driver_code = (
--         select driver_code from public.profiles
--          where driver_code is not null limit 1
--       ) where id = '<outro motorista>';
--     ESPERADO: ERRO de unique violation. Um sucesso aqui significa que o
--     índice não foi criado.
