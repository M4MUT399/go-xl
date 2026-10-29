-- ═════════════════════════════════════════════════════════════════════════════
-- 0076 — as duas policies do despacho v2 se chamam em círculo e abortam tudo
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Este NÃO é um buraco de segurança: é o contrário. Nenhum cliente autenticado
-- consegue ler `trip_requests` nem `ride_offers` — nem o dono da linha. Toda
-- consulta morre com `42P17 infinite recursion detected in policy`.
--
-- Descoberto atacando o banco, e o ataque que revelou foi o que FALHOU: eu
-- esperava que um motorista lesse o pedido que lhe foi ofertado e ele não leu.
--
-- ── O CÍRCULO ────────────────────────────────────────────────────────────────
--
-- A 0054 criou as duas juntas, cada uma consultando a tabela da outra:
--
--   trip_requests_select  →  exists (select 1 from ride_offers    …)
--   ride_offers_select_own →  exists (select 1 from trip_requests …)
--
-- As duas tabelas têm RLS. A subconsulta de uma dispara a policy da outra, que
-- dispara a policy da primeira. O Postgres detecta o ciclo no planejamento e
-- aborta a consulta INTEIRA — não é "devolve zero linhas", é erro.
--
-- Medido, todos os quatro papéis que deveriam funcionar:
--
--     passageiro dono lê o próprio trip_request  -> 42P17
--     motorista com oferta lê o trip_request     -> 42P17
--     motorista lê a PRÓPRIA oferta              -> 42P17
--     passageiro lê ofertas do próprio pedido    -> 42P17
--     service_role (dispatch-engine)             -> 1 linha  ← única que passa
--
-- O `service_role` escapa porque `trip_requests_service_all` é `using (true)`,
-- sem subconsulta. Por isso a Edge Function funciona e o app não: os dois lados
-- do motor v2 não estão no mesmo mundo.
--
-- ── O SEGUNDO DEFEITO, que estava escondido ATRÁS do primeiro ───────────────
--
-- A 0054:210 escreveu o ramo do motorista assim:
--
--     exists (select 1 from public.ride_offers o
--              where o.trip_request_id = id and o.driver_id = auth.uid())
--
-- O `id` sem qualificar resolve para o escopo MAIS INTERNO — `ride_offers.id`,
-- não `trip_requests.id`. O `pg_policies` mostra o resultado normalizado, e ele
-- é explícito: `o.trip_request_id = o.id`. A linha compara a oferta consigo
-- mesma, o que é falso sempre. O ramo do motorista é código morto.
--
-- A policy VIZINHA, escrita no mesmo arquivo dez linhas abaixo, qualifica
-- certo: `t.id = ride_offers.trip_request_id`. O padrão era conhecido; uma das
-- duas escapou. Consertar só a recursão deixaria este de pé, e o motorista
-- continuaria sem enxergar a oferta — agora sem nem um erro para acusar.
--
-- ── POR QUE NINGUÉM PERCEBEU EM PRODUÇÃO ────────────────────────────────────
--
-- Porque a flag `dispatch_engine_v2` é `false` por padrão
-- (`src/lib/systemConfig.ts:172`) e não há linha dela em `system_config`. O
-- motor v2 nunca foi ligado. Isto não está aberto hoje — está esperando.
--
-- E quando for ligado, não vai falhar alto. As quatro leituras do app
-- descartam o erro na desestruturação:
--
--     const { data: tr } = await supabase.from('trip_requests')…   // sem `error`
--
-- `data` vem null, `tripRequestId` vem undefined, e cada caminho segue pelo
-- ramo "não existe pedido":
--
--   · `useRide.ts:1734` — a eleição atômica do vencedor NUNCA é chamada, e
--     aceites simultâneos voltam a correr no caminho legado. É exatamente a
--     corrida que o motor v2 existe para eliminar.
--   · `useRide.ts:836` — o cancelamento não encerra o `trip_request`, e o tick
--     segue distribuindo corrida cancelada.
--   · `useRide.ts:1528` — o card da oferta nunca aparece para o motorista.
--
-- Três sintomas, nenhuma mensagem de erro, e a causa é uma policy. Ligar a flag
-- e observar "não funciona" não levaria ninguém até aqui.
--
-- ── O CONSERTO ──────────────────────────────────────────────────────────────
--
-- Tirar a subconsulta de dentro da policy e pô-la numa função `security
-- definer`, que roda com o privilégio do dono e portanto NÃO reentra na RLS. É
-- o mesmo recurso que a `is_driver()` já usa neste repositório desde a 0067 —
-- não é padrão novo.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── A. As duas travessias, agora fora do alcance da RLS ──────────────────────

create or replace function public.has_ride_offer_on(p_trip_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_catalog'
as $$
  select exists (
    select 1
      from public.ride_offers o
     where o.trip_request_id = p_trip_request_id
       and o.driver_id = (select auth.uid())
  );
$$;

create or replace function public.is_trip_request_passenger(p_trip_request_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_catalog'
as $$
  select exists (
    select 1
      from public.trip_requests t
     where t.id = p_trip_request_id
       and t.passenger_id = (select auth.uid())
  );
$$;

-- Regra da 0075: `public` junto com `anon`, senão o EXECUTE herdado do
-- pseudopapel PUBLIC deixa a função alcançável por quem não tem sessão — e
-- estas duas são `security definer`, ou seja, leem por cima da RLS.
revoke execute on function public.has_ride_offer_on(uuid)          from public, anon;
revoke execute on function public.is_trip_request_passenger(uuid)  from public, anon;
grant  execute on function public.has_ride_offer_on(uuid)          to authenticated, service_role;
grant  execute on function public.is_trip_request_passenger(uuid)  to authenticated, service_role;

-- ── B. As policies, sem o círculo e sem o `id` ambíguo ───────────────────────
--
-- O ramo do admin continua consultando `profiles` direto, de propósito: a
-- policy de `profiles` é `auth.uid() = id`, não menciona nenhuma destas duas
-- tabelas, então não há ciclo. Trocá-la por função seria mexer no que funciona.

drop policy if exists trip_requests_select on public.trip_requests;
create policy trip_requests_select on public.trip_requests
  for select to authenticated
  using (
    (select auth.uid()) = passenger_id
    or (select auth.uid()) = accepted_by
    or public.has_ride_offer_on(id)
    or exists (select 1 from public.profiles p
                where p.id = (select auth.uid()) and p.is_admin = true)
  );

drop policy if exists ride_offers_select_own on public.ride_offers;
create policy ride_offers_select_own on public.ride_offers
  for select to authenticated
  using (
    (select auth.uid()) = driver_id
    or public.is_trip_request_passenger(trip_request_id)
    or exists (select 1 from public.profiles p
                where p.id = (select auth.uid()) and p.is_admin = true)
  );

-- ── C. Que nenhuma das duas volte a consultar a outra ────────────────────────
--
-- A asserção olha o TEXTO das policies, e é o único jeito estrutural de pegar
-- isto: um ciclo de RLS não aparece em `pg_depend` nem em `pg_policies` como
-- propriedade — ele só se manifesta na hora da consulta. A prova de verdade é
-- comportamental e mora em `supabase/localdb/98_rls_comportamento.sql`.

do $$
declare
  v_bad text;
begin
  select string_agg(format('%s.%s', tablename, policyname), ', ') into v_bad
    from pg_policies
   where schemaname = 'public'
     and (
       (tablename = 'trip_requests'  and qual ~* '\mride_offers\M')
       or (tablename = 'ride_offers' and qual ~* '\mtrip_requests\M')
     );

  if v_bad is not null then
    raise exception '0076 incompleta: policy volta a consultar a outra tabela e o ciclo de RLS retorna: %', v_bad;
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'trip_requests'
       and policyname = 'trip_requests_select'
       and qual like '%has_ride_offer_on%'
  ) then
    raise exception '0076 incompleta: o ramo do motorista não passa mais por has_ride_offer_on — o ramo morto da 0054 pode ter voltado';
  end if;
end $$;

comment on function public.has_ride_offer_on(uuid) is
  'Existe oferta deste trip_request para auth.uid()? SECURITY DEFINER de propósito: chamada de DENTRO da policy de trip_requests, e uma subconsulta comum ali reentraria na RLS de ride_offers, que por sua vez consulta trip_requests — o ciclo que dava 42P17 em toda leitura autenticada até a 0076.';
