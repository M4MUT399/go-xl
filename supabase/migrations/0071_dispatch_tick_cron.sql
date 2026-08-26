-- ═════════════════════════════════════════════════════════════════════════════
-- 0071 — O TICK DO DISPATCH PASSA A EXISTIR
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ─── O DEFEITO ───────────────────────────────────────────────────────────────
-- O comentário da ação em `supabase/functions/dispatch-engine/index.ts` dizia,
-- antes desta rodada:
--
--     // ── tick: expira/expande/timeout + reconcile (chamado por cron) ─────
--
-- e `src/hooks/useRide.ts` se apoia nisso com todas as letras: "Best-effort: o
-- `tick` do servidor também expira/promove sozinho." (busque por essa frase; o
-- arquivo está sendo editado em paralelo e um número de linha aqui envelhece).
--
-- Não havia cron nenhum. Nem nesta migration nem em nenhuma outra: os únicos
-- `cron.schedule` do repositório são 0035 (repasse semanal), 0052 e 0057
-- (retenção de log), 0058 e 0063 (telemática) e 0068 (varredura de `requesting`
-- preso). Nenhum aponta para `dispatch-engine`.
--
-- CONSEQUÊNCIA, e ela é do tipo que não aparece em teste nenhum: sem tick,
--   • uma oferta PENDING cujo `expires_at` passou NUNCA vira EXPIRED. O card
--     fica no app do motorista depois de vencido, e o pedido não anda;
--   • o raio NUNCA expande. `dispatch_radius_step_km` e `dispatch_radius_max_km`
--     são configuráveis e inertes: se ninguém aceitar dentro do raio inicial, o
--     pedido fica em OFFERING até alguém aceitar por acaso;
--   • `dispatch_global_timeout_seconds` (300 s) nunca dispara, então
--     `NO_DRIVERS` nunca é atingido pelo caminho de timeout e o passageiro
--     espera indefinidamente sem receber a resposta "não achamos motorista".
--
-- O motor está correto — `_shared/dispatchEngine.ts` tem teste de unidade e as
-- transições são puras. O que faltava era alguém chamar `tick`.
--
-- ─── O QUE ESTA MIGRATION FAZ ────────────────────────────────────────────────
--   A. Uma trava de exclusão (`dispatch_tick_lease` + `try_acquire_dispatch_tick`)
--      para que dois ticks não rodem em cima um do outro.
--   B. O agendamento em si, a cada 10 s, com um portão que evita bater na função
--      quando não há nada para despachar.
--
-- ─── O QUE ESTA MIGRATION *NÃO* CONSERTA — declarado, não escondido ─────────
-- A trava serializa TICK contra TICK. Ela NÃO serializa tick contra as ações do
-- client (`create`, `accept`, `reject`, `cancel`), que continuam podendo rodar
-- concorrentes a um tick — essa corrida é ANTERIOR a esta migration e continua
-- de pé. A janela concreta: um tick lê o estado, um motorista aceita, e o
-- `upsert` de `persistDiff` (dispatch-engine/index.ts:240, `onConflict
-- trip_request_id,driver_id`) pode reescrever para PENDING uma linha de
-- `ride_offers` que acabou de virar ACCEPTED. Fechar isso exige serializar por
-- `trip_request_id` dentro de `persistDiff`, ou um `where status = 'PENDING'` no
-- upsert — trabalho do módulo de dispatch, não deste arquivo. Está registrado
-- aqui para não se perder.
--
-- (Parte disso foi fechada junto com esta migration: o `update` de
-- `trip_requests` em `dispatch-engine/index.ts` ganhou `.in('status',
-- ACTIVE_DISPATCH)` e o laço passa a PULAR o pedido que saiu do conjunto no meio
-- do tick. O que continua aberto é a corrida no `upsert` de `ride_offers`
-- quando o status do pedido NÃO mudou neste tick.)
--
-- SEGUNDO PONTO NÃO FECHADO — custo do `persistDiff`. Ele faz `await` em série
-- dentro de laço aninhado: ~2 a 4 idas ao PostgREST POR OFERTA. Com a operação
-- pequena isso é irrelevante; com muitos pedidos ativos ao mesmo tempo a rodada
-- se aproxima do prazo da trava e passa a depender da cerca do token para não
-- se sobrepor. O ponto de virada NÃO FOI MEDIDO — não há Postgres aqui e não há
-- dado de produção. O que instrumentar antes de mexer: duração de cada tick
-- (`last_tick_at` → fim) contra `count(*)` de `trip_requests` em
-- ACTIVE_DISPATCH. Agrupar os `upsert` em lote por pedido é a correção, e ela
-- não deve ser feita às cegas.
--
-- NADA NESTE ARQUIVO FOI EXECUTADO. Não há Postgres nesta máquina. As
-- asserções do bloco Z no fim existem para falhar alto quando um humano aplicar.

set lock_timeout = '3s';

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ─────────────────────────────────────────────────────────────────────────────
-- A. TRAVA DE EXCLUSÃO ENTRE TICKS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- POR QUE NÃO `pg_try_advisory_lock`: a trava de sessão do Postgres é liberada
-- quando a CONEXÃO fecha, e quem fala com o banco aqui é o PostgREST, com pool
-- de conexões. Duas chamadas da mesma Edge Function podem sair por conexões
-- diferentes, e a trava tomada numa não é liberável pela outra. Uma trava de
-- sessão nesse arranjo ou não segura nada ou vaza para sempre.
--
-- POR QUE UMA LINHA COM PRAZO: o `update ... where locked_until < now()` abaixo
-- é uma única instrução, portanto atômica, e o `returning` diz quem ganhou.
-- Se a Edge Function morrer no meio (deploy, OOM, timeout do Deno) ninguém
-- precisa limpar nada: o prazo vence sozinho e o tick seguinte assume. É a
-- propriedade que uma trava explícita não tem.
create table if not exists public.dispatch_tick_lease (
  -- Uma linha só, para sempre. O `check` é o que garante isso — sem ele, um
  -- `insert` distraído criaria uma segunda linha e cada tick pegaria a sua,
  -- que é exatamente a ausência de trava, só que difícil de perceber.
  id           boolean     primary key default true check (id),
  locked_until timestamptz not null default '-infinity',
  -- Quem é o dono ATUAL da trava. Sem isto o release não tem como provar posse,
  -- e um tick que estourou o próprio prazo liberaria a trava do SUCESSOR — ver
  -- a nota de cerca (fencing) em `release_dispatch_tick` abaixo.
  token        uuid,
  -- Só para diagnóstico humano: quando o último tick REALMENTE começou.
  last_tick_at timestamptz
);

insert into public.dispatch_tick_lease (id) values (true) on conflict (id) do nothing;

-- A tabela não é lida por ninguém além da função abaixo (que é `security
-- definer`). Nem `anon` nem `authenticated` têm o que fazer com ela.
alter table public.dispatch_tick_lease enable row level security;
revoke all on public.dispatch_tick_lease from public, anon, authenticated;

-- DROP ANTES DE CRIAR, e é obrigatório, não higiene. Uma versão anterior deste
-- arquivo declarava `try_acquire_dispatch_tick` como `returns boolean` e
-- `release_dispatch_tick()` sem argumento. Duas armadilhas do Postgres:
--
--   • `create or replace function` NÃO troca o tipo de retorno — aborta com
--     `42P13 cannot change return type of existing function`. Se alguém já
--     aplicou aquela cópia, esta migration morreria AQUI, ~200 linhas antes da
--     asserção Z.6 escrita justamente para diagnosticar esse caso, e com uma
--     mensagem que não explica nada;
--   • acrescentar parâmetro cria SOBRECARGA, não substituição. O
--     `release_dispatch_tick()` de zero argumentos sobreviveria ao lado do novo,
--     e a cerca (fencing) não valeria nada — bastaria alguém chamar a sobrecarga
--     errada para um tick atrasado liberar a trava do sucessor.
--
-- `if exists` sem `cascade`: nada depende destas funções além da Edge Function.
drop function if exists public.try_acquire_dispatch_tick(integer);
drop function if exists public.release_dispatch_tick();

-- Devolve o TOKEN de posse quando ganha, `null` quando perde. Devolver um token
-- em vez de um booleano é o que torna o release à prova de tick atrasado.
create or replace function public.try_acquire_dispatch_tick(p_lease_seconds integer default 25)
returns uuid
language plpgsql
security definer
-- `pg_catalog` primeiro: ver a nota da B.2.0 na 0069. Schema gravável na frente
-- do catálogo dentro de `security definer` é sequestro de corpo de função.
set search_path = pg_catalog, public
as $$
declare
  v_token uuid;
begin
  if p_lease_seconds is null or p_lease_seconds <= 0 then
    raise exception 'p_lease_seconds deve ser positivo';
  end if;
  -- TETO. O chamador é a Edge Function, e `TICK_LEASE_SECONDS` lá é um literal
  -- em TypeScript: alguém "consertando" 25 para 25000 (achando que é ms)
  -- congelaria o despacho inteiro por ~7 h, em silêncio, sem erro nenhum.
  -- 120 s é folgado para um tick e curto o bastante para o estrago se curar.
  if p_lease_seconds > 120 then
    raise exception 'p_lease_seconds = % excede o teto de 120 s. O tick não demora isso; um valor assim quase sempre é milissegundos passados como segundos.', p_lease_seconds;
  end if;

  -- Atômico: quem conseguir mover `locked_until` ganhou o tick. Os perdedores
  -- não atualizam linha nenhuma e recebem `null`.
  --
  -- Não há janela de duplo acquire: sob READ COMMITTED o segundo `update`
  -- bloqueia na linha, e ao destravar reavalia o WHERE contra a versão nova
  -- (EvalPlanQual), onde `locked_until` já está no futuro. Zero linhas.
  update public.dispatch_tick_lease
     set locked_until = now() + (p_lease_seconds * interval '1 second'),
         token        = gen_random_uuid(),
         last_tick_at = now()
   where id = true
     and locked_until < now()
  returning token into v_token;

  return v_token;
end;
$$;

-- Devolver a trava ANTES do prazo. Sem isto, um tick que termina em 300 ms
-- ainda bloquearia os próximos 25 s de tentativas — o prazo existe para o caso
-- em que a função MORRE, não para o caso normal.
--
-- CERCA (fencing), e é o ponto todo do token: `timeout_milliseconds` do pg_net
-- abandona a RESPOSTA, não cancela o trabalho do outro lado. Então um tick pode
-- passar dos 8 s do http_post e continuar vivo no Deno depois do próprio prazo
-- de 25 s vencer. Sequência sem token: tick #1 pega em T=0; T=25 o prazo vence;
-- T=30 o tick #2 pega; T=31 o `finally` do #1 libera — e evapora a trava do #2;
-- T=40 entra o #3 rodando EM CIMA do #2. Com o token, o release do #1 casa
-- zero linhas e não faz nada. Liberar a trava de outro é pior que não liberar.
create or replace function public.release_dispatch_tick(p_token uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_released boolean;
begin
  if p_token is null then
    return false;
  end if;

  update public.dispatch_tick_lease
     set locked_until = '-infinity',
         token        = null
   where id = true
     and token = p_token
  returning true into v_released;

  return coalesce(v_released, false);
end;
$$;

revoke all    on function public.try_acquire_dispatch_tick(integer) from public, anon, authenticated;
revoke all    on function public.release_dispatch_tick(uuid)        from public, anon, authenticated;
grant execute on function public.try_acquire_dispatch_tick(integer) to service_role;
grant execute on function public.release_dispatch_tick(uuid)        to service_role;

comment on function public.try_acquire_dispatch_tick(integer) is
  'Trava de exclusão entre execuções do tick do dispatch (0071 A). Um `update ... where locked_until < now()` atômico: devolve o token de posse quando ganha, null quando perde. O prazo (default 25 s, teto 120 s) é rede de segurança para a Edge Function morrer sem devolver a trava — o caminho normal chama release_dispatch_tick(token) no fim. NÃO serializa tick contra ações do client; ver o cabeçalho da 0071.';

comment on function public.release_dispatch_tick(uuid) is
  'Devolve a trava do tick (0071 A) SE o token bater com o dono atual. Devolve false quando o token está velho — caso do tick que estourou o próprio prazo e voltou depois de outro já ter assumido. Liberar sem provar posse permitiria dois ticks concorrentes.';

-- ─────────────────────────────────────────────────────────────────────────────
-- B. O AGENDAMENTO
-- ─────────────────────────────────────────────────────────────────────────────
select cron.unschedule('dispatch-engine-tick')
where exists (select 1 from cron.job where jobname = 'dispatch-engine-tick');

-- A CADA 10 SEGUNDOS, e o número sai do TTL da oferta.
-- ─────────────────────────────────────────────────────────────────────────────
-- `dispatch_offer_ttl_seconds` tem default 15 s (dispatch-engine/index.ts:118).
-- O atraso máximo entre uma oferta vencer e ser marcada EXPIRED é o período do
-- tick, então 10 s é ~⅔ do TTL: o motorista seguinte recebe o card em no máximo
-- 25 s no pior caso. Um cron de 1 minuto — a granularidade padrão do cron de
-- cinco campos — daria 75 s de pior caso para um TTL de 15 s, ou seja, o TTL
-- viraria enfeite.
--
-- `'10 seconds'` é a sintaxe de INTERVALO do pg_cron, aceita para 1..59 s, e não
-- um cron de seis campos. PRÉ-CONDIÇÃO A CONFERIR NO BANCO (não conferível
-- daqui, não há Postgres nesta máquina): a versão instalada do pg_cron precisa
-- suportar intervalo em segundos. A asserção Z.3 no fim deste arquivo falha alto
-- se o job não tiver sido criado.
--
--     select extname, extversion from pg_extension where extname = 'pg_cron';
--
-- O PORTÃO `where exists (...)`: sem ele o cron acordaria a Edge Function 8.640
-- vezes por dia para descobrir que não há nada a despachar. O `exists` usa
-- `trip_requests_status_idx` (0054:48, sobre `(status, created_at)`) e custa
-- praticamente nada; com a frota parada o `net.http_post` sequer é enfileirado.
-- Os três estados são os mesmos de `ACTIVE_DISPATCH` em
-- dispatch-engine/index.ts:78 — se aquela lista mudar, esta tem de mudar junto,
-- e a asserção Z.4 abaixo é o que torna a divergência barulhenta.
--
-- SOBRE `timeout_milliseconds`: como na 0068, ele NÃO cancela o trabalho do
-- outro lado — passados 8 s o pg_net desiste da RESPOSTA e a função continua
-- rodando. Aqui isso é aceitável de propósito: o tick é idempotente por
-- construção (o motor recalcula o estado inteiro a cada rodada) e a trava de
-- prazo impede que a rodada abandonada e a próxima se sobreponham.
select cron.schedule(
  'dispatch-engine-tick',
  '10 seconds',
  $$
    select net.http_post(
      url     := 'https://zukydkodafdmhaulhxeh.supabase.co/functions/v1/dispatch-engine',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (
          select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
        )
      ),
      body    := '{"action":"tick"}'::jsonb,
      timeout_milliseconds := 8000
    )
    where exists (
      select 1 from public.trip_requests
       where status in ('REQUESTED','MATCHING','OFFERING')
    );
  $$
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Z. Asserções — falham alto se qualquer coisa acima ficar pela metade
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  -- Z.1 — a linha única da trava existe. Sem ela o `update` da A não acha nada,
  -- devolve `false` para SEMPRE e o tick nunca roda: o defeito que esta
  -- migration conserta voltaria, agora com uma trava por cima para escondê-lo.
  if (select count(*) from public.dispatch_tick_lease) <> 1 then
    raise exception '0071 quebrada: dispatch_tick_lease tem % linha(s), tem de ter exatamente 1',
      (select count(*) from public.dispatch_tick_lease);
  end if;

  -- Z.2 — a trava começa LIVRE. `-infinity` é sempre menor que `now()`; se o
  -- default mudar para `now()` numa edição futura, o primeiro tick só rodaria
  -- depois do prazo e ninguém notaria.
  if not exists (select 1 from public.dispatch_tick_lease
                  where id = true and locked_until < now()) then
    raise exception '0071 quebrada: a trava do tick nasceu TOMADA (locked_until >= now())';
  end if;

  -- Z.3 — o job existe E está ativo. Este é o ponto inteiro do arquivo: se
  -- `cron.schedule` recusou o intervalo em segundos (pg_cron antigo), é AQUI
  -- que se descobre, e não em produção com ofertas vencidas na tela.
  if not exists (select 1 from cron.job
                  where jobname = 'dispatch-engine-tick' and active) then
    raise exception '0071 quebrada: job dispatch-engine-tick ausente ou inativo. Confira se o pg_cron instalado aceita intervalo em segundos: select extversion from pg_extension where extname = ''pg_cron'';';
  end if;

  -- Z.4 — o comando REALMENTE agendado filtra os três estados. Confirma que o
  -- `cron.schedule` acima não foi aplicado numa versão anterior deste arquivo.
  --
  -- O QUE ESTA ASSERÇÃO **NÃO** FAZ, e uma versão anterior deste comentário
  -- mentia dizendo que fazia: ela NÃO amarra o SQL ao TypeScript. O Postgres
  -- não lê `index.ts`. Trocar `ACTIVE_DISPATCH` lá não faz esta linha falhar —
  -- ela só compara o comando agendado com o literal escrito neste mesmo
  -- arquivo, e migration roda uma vez, então nem o drift do SQL é pego depois.
  -- Quem amarra os dois lados é o teste
  -- `src/lib/__tests__/dispatchCronGate.test.ts`, que lê os dois arquivos e
  -- compara as listas a cada `npx jest`.
  if (select command from cron.job where jobname = 'dispatch-engine-tick')
       not like '%''REQUESTED'',''MATCHING'',''OFFERING''%' then
    raise exception '0071 quebrada: o portão do cron não filtra exatamente REQUESTED/MATCHING/OFFERING — tem de casar com ACTIVE_DISPATCH em supabase/functions/dispatch-engine/index.ts:78';
  end if;

  -- Z.5 — `authenticated` NÃO executa a trava. Se executasse, qualquer conta
  -- grátis chamaria `try_acquire_dispatch_tick(120)` e congelaria o despacho da
  -- operação inteira, sem escrever em nada e sem aparecer em log nenhum. É a
  -- asserção de maior raio de dano deste bloco.
  if has_function_privilege('authenticated', 'public.try_acquire_dispatch_tick(integer)', 'EXECUTE')
     or has_function_privilege('anon', 'public.try_acquire_dispatch_tick(integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.release_dispatch_tick(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.release_dispatch_tick(uuid)', 'EXECUTE') then
    raise exception '0071 quebrada: anon/authenticated podem executar a trava do tick — negação de despacho por qualquer conta';
  end if;

  -- Z.6 — o release exige token. Se `release_dispatch_tick()` sem argumento
  -- existir (versão anterior desta migration, aplicada antes desta correção),
  -- a Edge Function chamaria a sobrecarga errada e a cerca não valeria nada:
  -- em Postgres, adicionar parâmetro cria SOBRECARGA, não substitui.
  if exists (select 1 from pg_proc
              where pronamespace = 'public'::regnamespace
                and proname = 'release_dispatch_tick'
                and pronargs = 0) then
    raise exception '0071 quebrada: existe release_dispatch_tick() SEM token. Rode `drop function public.release_dispatch_tick();` — a versão sem cerca deixa um tick atrasado liberar a trava do sucessor';
  end if;

  -- Z.7 — o teto de `p_lease_seconds` está de pé.
  begin
    perform public.try_acquire_dispatch_tick(9999);
    raise exception '0071 quebrada: try_acquire_dispatch_tick aceitou 9999 s — o teto de 120 s sumiu';
  exception
    when others then
      if sqlerrm like '0071 quebrada%' then raise; end if;
  end;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- PROVAS PARA UM HUMANO RODAR (nenhuma delas rodou aqui)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- P1. O job está lá e rodando de 10 em 10 s:
--       select jobname, schedule, active from cron.job where jobname = 'dispatch-engine-tick';
--       select status, start_time, return_message
--         from cron.job_run_details
--        where jobid = (select jobid from cron.job where jobname = 'dispatch-engine-tick')
--        order by start_time desc limit 10;
--     ESPERADO: `succeeded` a cada 10 s. `failed` com "invalid schedule" significa
--     pg_cron sem suporte a intervalo em segundos — e aí o caminho é cair para
--     '* * * * *' (1 min) E baixar `dispatch_offer_ttl_seconds` para ~45 s, para
--     o TTL continuar maior que o período do tick.
--
-- P2. O portão realmente segura quando não há pedido ativo. Com a frota parada,
--     `cron.job_run_details` continua `succeeded` (o `select` rodou) mas
--     `net._http_response` NÃO ganha linha nova:
--       select count(*) from net._http_response where created > now() - interval '1 minute';
--     ESPERADO: 0 com zero trip_request ativo; > 0 com um pedido em OFFERING.
--
-- P3. A trava serializa. Em duas sessões, na mesma janela de 25 s:
--       select public.try_acquire_dispatch_tick(25);   -- sessão 1 → <uuid A>
--       select public.try_acquire_dispatch_tick(25);   -- sessão 2 → NULL
--       select public.release_dispatch_tick('<uuid A>');  -- → true
--       select public.try_acquire_dispatch_tick(25);   -- → <uuid B>, ≠ A
--
-- P3b. A CERCA do release segura (o furo que o token fecha). Numa sessão só:
--       select public.try_acquire_dispatch_tick(25);       -- → <uuid A>
--       update public.dispatch_tick_lease set locked_until = '-infinity';
--       select public.try_acquire_dispatch_tick(25);       -- → <uuid B> (o "sucessor")
--       select public.release_dispatch_tick('<uuid A>');   -- o tick atrasado volta
--     ESPERADO: false, e `locked_until` CONTINUA no futuro. Se vier true, o tick
--     atrasado liberou a trava do sucessor e dois ticks rodam concorrentes.
--
-- P4. O ciclo que o defeito impedia, ponta a ponta. Com `dispatch_engine_v2`
--     em true e um motorista online, peça uma corrida e NÃO aceite:
--       select status, expires_at, resolved_at from public.ride_offers
--        where trip_request_id = '<id>' order by offered_at;
--     ESPERADO: a primeira oferta vira EXPIRED até ~10 s depois de `expires_at`
--     e uma segunda linha PENDING aparece para o próximo motorista. Antes desta
--     migration a primeira linha ficava PENDING para sempre.
--
-- P5. O timeout global volta a existir:
--       select status from public.trip_requests where id = '<id>';
--     ESPERADO: `NO_DRIVERS` depois de `dispatch_global_timeout_seconds` (300 s)
--     sem aceite. Antes: `OFFERING` indefinidamente.
