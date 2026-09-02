-- ═════════════════════════════════════════════════════════════════════════════
-- 0081 — trava de versão mínima do app (INERTE até alguém ligar)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ── O CASO REAL ────────────────────────────────────────────────────────────
--
-- Em 02/09/2026 um aparelho ativo em campo estava rodando a 1.0.0 — anterior a
-- 11/08, de antes de as chaves do Google Maps serem separadas (246de87). O mapa
-- dele aparecia em branco porque aquela chave compartilhada não autoriza mais
-- nada. Nada no app, no banco ou nas Edge Functions o impedia de seguir rodando.
--
-- O mapa em branco era o sintoma barato. O caro é `charge-ride/index.ts:466`:
-- ele cobra `rides.price` COMO O CLIENTE GRAVOU. O servidor não recalcula a
-- tarifa, só a lê. Um PASSAGEIRO em build velha cria a corrida com a tabela
-- velha — sem os +$0,25/milha, sem os $7 do MCO — e o servidor cobra esse valor
-- sem reclamar. Não há erro, não há alerta: só receita a menos.
--
-- ── POR QUE A METADE DO CLIENTE NÃO BASTA ──────────────────────────────────
--
-- A tela de "atualize o app" (src/components/common/UpdateRequiredScreen.tsx) é
-- inútil contra o aparelho que JÁ está velho: a 1.0.0 não tem esse código e
-- nunca vai ter. Ela só protege quem for ficar velho a partir da próxima build.
--
-- Quem tem dentes é este arquivo. O cliente novo carimba `x-goxl-version` em
-- toda requisição (src/lib/supabase.ts + src/lib/appVersion.ts); o trigger
-- abaixo lê esse cabeçalho e recusa o INSERT em `rides`. Cliente velho não manda
-- cabeçalho nenhum — e esse é precisamente o caso que precisa cair.
--
-- ── ESTA MIGRAÇÃO NÃO MUDA COMPORTAMENTO NENHUM HOJE ───────────────────────
--
-- O seed nasce com `min = 0.0.0` e `enforceServer = false`. Com qualquer um dos
-- dois nesse estado o trigger devolve NEW sem olhar mais nada. É a ordem certa
-- de implantação: a trava só pode subir DEPOIS que a build que a contém estiver
-- publicada e adotada. Ligar antes emparedaria justamente quem está em dia.
--
-- ⚠️ LIGAR ISTO É UM CORTE DURO, e é bom saber disso antes. No instante em que
-- `enforceServer` virar true com um `min` acima das builds em campo, TODO app
-- abaixo do mínimo — incluindo os que não mandam cabeçalho, ou seja tudo que
-- foi publicado antes desta migração — para de conseguir criar corrida. É o
-- objetivo, não um efeito colateral; mas é irreversível para o passageiro no
-- meio do pedido. Ligue com a loja já servindo a build nova.
--
-- ── FALHA PARA O LADO ABERTO EM TUDO QUE NÃO FOR O ALVO ────────────────────
--
-- Config ausente, jsonb torto, `min` fora do formato X.Y.Z, chamador que não é
-- `authenticated` (service_role, psql, migrations): tudo passa. A única coisa
-- que cai é um app autenticado, com a trava ligada, abaixo do mínimo.

-- ─── 1. Leitura do cabeçalho enviado pelo cliente ────────────────────────────
--
-- O PostgREST publica os cabeçalhos da requisição em `request.headers`, já com
-- os nomes em minúsculas. Fora de uma requisição PostgREST (psql, migration,
-- job) o GUC não existe — o `true` no `current_setting` faz isso devolver NULL
-- em vez de estourar.
create or replace function public.goxl_client_version()
returns text
language plpgsql
stable
as $$
declare
  v_headers jsonb;
begin
  begin
    v_headers := nullif(current_setting('request.headers', true), '')::jsonb;
  exception when others then
    -- Cabeçalho ilegível é indistinguível de cabeçalho ausente, e os dois
    -- significam a mesma coisa para quem chama: não sei quem é este cliente.
    return null;
  end;
  if v_headers is null then
    return null;
  end if;
  return nullif(btrim(v_headers->>'x-goxl-version'), '');
end $$;

comment on function public.goxl_client_version() is
  'Versão do app que enviou a requisição (cabeçalho x-goxl-version), ou NULL. O nome do cabeçalho é espelhado em src/lib/appVersion.ts:CABECALHO_VERSAO.';

-- O Postgres dá EXECUTE ao PUBLIC em toda função nova; revogar só de `anon` não
-- adiantaria nada. Ninguém precisa chamar isto de fora: quem usa é o trigger
-- abaixo, que é SECURITY DEFINER e roda como dono.
revoke execute on function public.goxl_client_version() from public, anon;

-- ─── 2. Comparação de versão POR NÚMERO ──────────────────────────────────────
--
-- ISTO É O CORAÇÃO DA COISA. Comparar versão como TEXTO é a armadilha clássica:
-- '1.0.10' < '1.0.9' na ordem alfabética, porque '1' vem antes de '9'. Acabamos
-- de atravessar exatamente essa transição (1.0.9 → 1.0.10) — um `<` de string
-- teria liberado a build velha e travado a nova.
--
-- Três segmentos, sempre, preenchidos com zero. O tamanho fixo não é detalhe:
-- em Postgres, ARRAY[1,0] < ARRAY[1,0,0] (o prefixo mais curto perde), então
-- comparar arrays de tamanhos diferentes faria '1.0' < '1.0.0'. Com três fixos,
-- '1.0' e '1.0.0' são iguais — igual ao `compararVersoes` de
-- src/lib/minAppVersion.ts, que é o outro lado desta mesma decisão.
--
-- Segmento não numérico vira 0 ('1.0.0-beta' == '1.0.0'). Não publicamos
-- pré-lançamento nas lojas, então inventar uma ordem para sufixos seria inventar
-- semântica que ninguém usa.
create or replace function public.goxl_versao_array(v text)
returns int[]
language sql
immutable
as $$
  with p as (select string_to_array(coalesce(v, ''), '.') as a)
  select array[
    coalesce(substring(coalesce((select a[1] from p), '') from '^[0-9]+')::int, 0),
    coalesce(substring(coalesce((select a[2] from p), '') from '^[0-9]+')::int, 0),
    coalesce(substring(coalesce((select a[3] from p), '') from '^[0-9]+')::int, 0)
  ]
$$;

comment on function public.goxl_versao_array(text) is
  'Versão X.Y.Z como int[3] para comparação NUMÉRICA. Espelha compararVersoes() em src/lib/minAppVersion.ts.';

revoke execute on function public.goxl_versao_array(text) from public, anon;

-- ─── 3. Seed da configuração, no estado INERTE ───────────────────────────────
--
-- `is_public = true` porque o app precisa ler isto para desenhar a tela de
-- atualização — o texto vem daqui, e não de src/i18n/translations.ts, para
-- poder mudar sem uma build nova (que é justamente o que não se pode exigir de
-- quem está preso na velha).
insert into public.system_config (key, jurisdiction, value, description, is_public)
values (
  'min_app_version',
  'global',
  jsonb_build_object(
    'min', '0.0.0',
    'enforceServer', false,
    'store', jsonb_build_object(
      'android', 'https://play.google.com/store/apps/details?id=com.goxl.app',
      'ios',     'https://apps.apple.com/app/go-xl/id6781716394'
    ),
    'message', jsonb_build_object(
      'en', jsonb_build_object(
        'titulo', 'Update required',
        'corpo',  'This version of Go XL is no longer supported. Please update to keep requesting rides.',
        'botao',  'Update Go XL'
      ),
      'pt', jsonb_build_object(
        'titulo', 'Atualização necessária',
        'corpo',  'Esta versão do Go XL não é mais suportada. Atualize para continuar pedindo corridas.',
        'botao',  'Atualizar o Go XL'
      ),
      'es', jsonb_build_object(
        'titulo', 'Actualización necesaria',
        'corpo',  'Esta versión de Go XL ya no es compatible. Actualiza para seguir pidiendo viajes.',
        'botao',  'Actualizar Go XL'
      )
    )
  ),
  'Versão mínima do app. min=0.0.0 e enforceServer=false deixam a trava inerte. Ver migration 0081.',
  true
)
on conflict (key, jurisdiction) do nothing;

-- ─── 4. O trigger ────────────────────────────────────────────────────────────
--
-- SECURITY DEFINER para conseguir ler `system_config` sem depender da RLS do
-- chamador. O papel do CHAMADOR é lido de `request.jwt.claims`, que o PostgREST
-- preenche por requisição e que o SECURITY DEFINER não mascara — `current_user`
-- aqui dentro seria o dono da função, não quem chamou, e usar isso seria o bug.
create or replace function public.enforce_min_app_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_papel   text;
  v_cfg     jsonb;
  v_min     text;
  v_cliente text;
begin
  -- Só usuário do app é barrado. service_role (Edge Functions), psql, migrations
  -- e jobs passam sempre — nenhum deles é um binário desatualizado na mão de
  -- alguém, e barrá-los quebraria manutenção no pior momento possível.
  v_papel := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role',
    ''
  );
  if v_papel <> 'authenticated' then
    return new;
  end if;

  select value into v_cfg
    from public.system_config
   where key = 'min_app_version'
     and jurisdiction = 'global';

  if v_cfg is null then
    return new;
  end if;
  -- Exige um booleano jsonb DE VERDADE, não a string "true". `->>` seguido de
  -- ::boolean aceitaria 'true', 'yes', 't' — e aí o servidor bloquearia numa
  -- config que o cliente (lerConfigTrava, que exige `=== true`) considera
  -- desligada. As duas metades discordando é o pior estado possível: o app não
  -- mostra a tela de atualização e o usuário só vê um erro cru.
  if jsonb_typeof(v_cfg->'enforceServer') <> 'boolean'
     or (v_cfg->>'enforceServer')::boolean is not true then
    return new;
  end if;

  v_min := v_cfg->>'min';
  -- Config torta não vira trava acidental. Exigir X.Y.Z também garante que o
  -- servidor e o `compararVersoes` do cliente enxerguem o mesmo número de
  -- segmentos — o servidor olha três.
  if v_min is null or v_min !~ '^[0-9]+\.[0-9]+\.[0-9]+$' then
    return new;
  end if;

  v_cliente := public.goxl_client_version();

  -- Cliente SEM cabeçalho é o alvo principal: toda build publicada antes desta
  -- migração cai aqui. Não é um caso de erro, é o caso de uso.
  if v_cliente is not null
     and public.goxl_versao_array(v_cliente) >= public.goxl_versao_array(v_min) then
    return new;
  end if;

  raise exception 'GOXL_UPDATE_REQUIRED: versão % abaixo do mínimo %',
        coalesce(v_cliente, '(sem cabeçalho)'), v_min
    using errcode = 'P0001',
          hint = 'Atualize o Go XL na loja para continuar.';
end $$;

comment on function public.enforce_min_app_version() is
  'Recusa INSERT em rides vindo de app abaixo de min_app_version. Inerte enquanto enforceServer=false. Ver migration 0081.';

revoke all on function public.enforce_min_app_version() from public, anon;

drop trigger if exists trg_min_app_version on public.rides;
create trigger trg_min_app_version
  before insert on public.rides
  for each row
  execute function public.enforce_min_app_version();

-- ─── 5. Asserções ────────────────────────────────────────────────────────────
do $$
declare
  v_cfg jsonb;
begin
  -- 5.1 A comparação numérica funciona. Este é o teste que impede a regressão
  -- que motivou o formato: como TEXTO, '1.0.10' < '1.0.9'.
  if not (public.goxl_versao_array('1.0.10') > public.goxl_versao_array('1.0.9')) then
    raise exception '0081 incompleta: 1.0.10 não ficou maior que 1.0.9 — comparação virou texto';
  end if;
  if not (public.goxl_versao_array('1.0') = public.goxl_versao_array('1.0.0')) then
    raise exception '0081 incompleta: 1.0 e 1.0.0 deveriam ser iguais';
  end if;
  if not (public.goxl_versao_array('1.0.0') < public.goxl_versao_array('1.0.10')) then
    raise exception '0081 incompleta: 1.0.0 deveria ser menor que 1.0.10';
  end if;
  if not (public.goxl_versao_array('2.0.0') > public.goxl_versao_array('1.99.99')) then
    raise exception '0081 incompleta: o major deveria mandar sobre o minor';
  end if;
  if not (public.goxl_versao_array('lixo') = public.goxl_versao_array('0.0.0')) then
    raise exception '0081 incompleta: entrada ilegível deveria virar 0.0.0';
  end if;

  -- 5.2 O seed existe, é legível pelo app e nasceu INERTE.
  select value into v_cfg
    from public.system_config
   where key = 'min_app_version' and jurisdiction = 'global';
  if v_cfg is null then
    raise exception '0081 incompleta: a config min_app_version não ficou gravada';
  end if;
  if (v_cfg->>'enforceServer')::boolean is not false then
    raise exception '0081 incompleta: a trava nasceu LIGADA (enforceServer=%)', v_cfg->>'enforceServer';
  end if;
  if v_cfg->>'min' <> '0.0.0' then
    raise exception '0081 incompleta: min nasceu como %, esperado 0.0.0', v_cfg->>'min';
  end if;
  if not exists (
    select 1 from public.system_config
     where key = 'min_app_version' and jurisdiction = 'global' and is_public
  ) then
    raise exception '0081 incompleta: min_app_version não é is_public — o app não conseguiria ler o texto';
  end if;
  if v_cfg->'message'->'en'->>'titulo' is null
     or v_cfg->'message'->'pt'->>'titulo' is null
     or v_cfg->'message'->'es'->>'titulo' is null then
    raise exception '0081 incompleta: falta texto em algum dos três idiomas';
  end if;

  -- 5.3 O trigger está pendurado onde deve.
  if not exists (
    select 1 from pg_trigger
     where tgname = 'trg_min_app_version'
       and tgrelid = 'public.rides'::regclass
       and not tgisinternal
  ) then
    raise exception '0081 incompleta: o trigger trg_min_app_version não ficou em rides';
  end if;

  -- 5.4 Nenhuma das funções novas ficou aberta ao anônimo. O Postgres concede
  -- EXECUTE ao PUBLIC por padrão, então esquecer o revoke é o caminho fácil.
  if has_function_privilege('anon', 'public.goxl_client_version()', 'execute')
     or has_function_privilege('anon', 'public.goxl_versao_array(text)', 'execute')
     or has_function_privilege('anon', 'public.enforce_min_app_version()', 'execute') then
    raise exception '0081 incompleta: alguma função nova continua executável por anon';
  end if;

  raise notice '0081: trava de versão instalada e INERTE (min=0.0.0, enforceServer=false).';
end $$;
