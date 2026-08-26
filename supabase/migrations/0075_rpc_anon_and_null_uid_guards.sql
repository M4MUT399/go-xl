-- ═════════════════════════════════════════════════════════════════════════════
-- 0075 — o guarda de autorização era desligado por NÃO fazer login
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Mesma raiz da 0073, uma classe de objeto ao lado. Lá era `alter default
-- privileges … grant all on TABLES`, que dava escrita nas views a quem só
-- deveria ler. Aqui é a linha irmã — `grant all on FUNCTIONS to anon,
-- authenticated` —, que dá EXECUTE em toda função nova de `public` a um
-- chamador que nem sessão tem. Nenhuma migration jamais revogou isso.
--
-- Sozinho, o EXECUTE não seria grave: as funções conferem quem chama. O
-- problema é COMO duas delas conferem.
--
-- ── O ATAQUE, como foi rodado ────────────────────────────────────────────────
--
-- A guarda, idêntica nas duas:
--
--     if auth.uid() is not null and auth.uid() <> p_driver_id then
--       raise exception 'não autorizado: só o próprio motorista pode ...'
--
-- `auth.uid()` é NULL quando não há JWT. Para `anon` a primeira condição é
-- falsa, o `and` corta, e a exceção nunca é levantada. O guarda se desliga
-- sozinho justamente para quem não se identificou.
--
-- Dois motoristas com oferta PENDING no mesmo pedido. O atacante tenta aceitar
-- no lugar da vítima:
--
--     como authenticated (logado) -> 42501 'não autorizado: só o próprio
--                                    motorista pode aceitar'
--     como anon (o MESMO ataque, sem login) -> 'ACCEPTED'
--
-- E o efeito não para no retorno. Estado depois da chamada anônima:
--
--     ride_offers   vítima   -> ACCEPTED     (ela nunca tocou em nada)
--     ride_offers   atacante -> REVOKED
--     trip_requests          -> ACCEPTED, accepted_by = vítima
--     dispatch_events        -> ACCEPTED, driver_id = vítima
--
-- A última linha é a pior: a trilha de auditoria REGISTRA que a vítima aceitou.
-- Um motorista passa a ter corrida atribuída sem ter aceitado — e o banco diz
-- que aceitou. As ofertas de todos os outros são revogadas no mesmo golpe.
--
-- Na `increment_driver_period_mileage` a mesma porta grava dado de jornada:
-- chamada anônima com `p_driver_id` da vítima e delta 999 gravou
-- `p1_miles = 999, estimated_miles = 999` na ficha dela. Isso alimenta o
-- controle de horas de direção — o dado que a conformidade TNC da Flórida usa.
--
-- ── POR QUE A LEITURA NÃO PEGOU, DOZE VEZES ─────────────────────────────────
--
-- Porque a linha está CERTA para o leitor que assume sessão. Ela protege o caso
-- que o revisor imagina (um motorista logado tentando agir por outro) e falha
-- no caso que ninguém imagina, que é não haver login nenhum. O `is not null`
-- foi escrito para deixar o `service_role` passar — e `service_role` também tem
-- `auth.uid()` nulo. A intenção estava certa; o teste do papel é que estava
-- errado.
--
-- E o repositório JÁ TEM o jeito certo, em seis funções. A `apply_driver_split`
-- faz exatamente a distinção que falta aqui:
--
--     v_role text := auth.role();
--     if v_role is not null and v_role <> 'service_role' and (...) then raise
--
-- Isto aqui é alinhar as duas retardatárias com a casa, não inventar padrão.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── A. `accept_trip_offer` ───────────────────────────────────────────────────
-- Só o corpo do guarda muda. Toda a lógica de compare-and-set, idempotência,
-- revogação dos perdedores e evento de despacho fica byte a byte igual — não é
-- hora de mexer no motor de disputa.

create or replace function public.accept_trip_offer(p_trip_request_id uuid, p_driver_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_updated int;
  v_existing text;
  v_role text := auth.role();
begin
  -- O papel decide, não a ausência de uid. `service_role` (dispatch-engine)
  -- passa; qualquer outro tem de PROVAR ser o motorista, e quem não tem uid
  -- nenhum não prova nada. Antes, `auth.uid() is null` valia como passe livre.
  if v_role is distinct from 'service_role'
     and (auth.uid() is null or auth.uid() <> p_driver_id) then
    raise exception 'não autorizado: só o próprio motorista pode aceitar'
      using errcode = 'insufficient_privilege';
  end if;

  -- Idempotência: se este motorista já venceu, reconfirma sem efeitos colaterais.
  select status into v_existing
    from public.ride_offers
   where trip_request_id = p_trip_request_id and driver_id = p_driver_id;
  if v_existing = 'ACCEPTED' then
    return 'ACCEPTED';
  end if;

  -- Compare-and-set atômico no pedido: só o primeiro casa a condição.
  update public.trip_requests
     set status = 'ACCEPTED', accepted_by = p_driver_id
   where id = p_trip_request_id
     and status = 'OFFERING'
     and accepted_by is null
     and exists (
       select 1 from public.ride_offers o
        where o.trip_request_id = p_trip_request_id
          and o.driver_id = p_driver_id
          and o.status = 'PENDING'
     );
  get diagnostics v_updated = row_count;

  if v_updated = 0 then
    return 'TRIP_NO_LONGER_AVAILABLE';
  end if;

  -- Vencedor: marca a própria oferta.
  update public.ride_offers
     set status = 'ACCEPTED', resolved_at = now()
   where trip_request_id = p_trip_request_id and driver_id = p_driver_id;

  -- Perdedores (leque/broadcast): revoga as demais ofertas pendentes do pedido.
  update public.ride_offers
     set status = 'REVOKED', resolved_at = now()
   where trip_request_id = p_trip_request_id
     and driver_id <> p_driver_id
     and status = 'PENDING';

  insert into public.dispatch_events (trip_request_id, driver_id, event, meta)
  values (p_trip_request_id, p_driver_id, 'ACCEPTED', '{}'::jsonb);

  return 'ACCEPTED';
end;
$function$;

-- ── B. `increment_driver_period_mileage` ─────────────────────────────────────

create or replace function public.increment_driver_period_mileage(
  p_driver_id uuid, p_day date,
  p_p1_delta numeric, p_p2_delta numeric, p_p3_delta numeric, p_estimated_delta numeric
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_role text := auth.role();
begin
  if v_role is distinct from 'service_role'
     and (auth.uid() is null or auth.uid() <> p_driver_id) then
    raise exception 'não autorizado: só o próprio motorista pode incrementar sua milhagem'
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.driver_period_daily_mileage (driver_id, day, p1_miles, p2_miles, p3_miles, estimated_miles)
  values (
    p_driver_id,
    p_day,
    greatest(p_p1_delta, 0),
    greatest(p_p2_delta, 0),
    greatest(p_p3_delta, 0),
    greatest(p_estimated_delta, 0)
  )
  on conflict (driver_id, day) do update
    set p1_miles        = public.driver_period_daily_mileage.p1_miles + greatest(excluded.p1_miles, 0),
        p2_miles        = public.driver_period_daily_mileage.p2_miles + greatest(excluded.p2_miles, 0),
        p3_miles        = public.driver_period_daily_mileage.p3_miles + greatest(excluded.p3_miles, 0),
        estimated_miles = public.driver_period_daily_mileage.estimated_miles + greatest(excluded.estimated_miles, 0);
end;
$function$;

-- ── C. Tirar `anon` de TODA função de `public` ───────────────────────────────
--
-- Consertar as duas guardas resolve as duas. Esta seção resolve a classe: hoje
-- `anon` executa doze RPCs de `public` só porque ninguém revogou o default, e
-- duas delas fazem coisa que nenhum anônimo deveria fazer nem com guarda certa:
--
--   · `ensure_driver_period_transitions_partition(date)` executa DDL. Chamada
--     anônima com três datas de 2031 CRIOU as três partições, com cinco índices
--     cada. A data é livre, então o catálogo cresce sem teto e sem login.
--   · `resolve_config_bool/numeric` são SECURITY DEFINER e passam por cima do
--     `is_public = true` que a policy de `system_config` impõe. Conferido: o
--     SELECT direto de `anon` na chave `period_audit_v1_enabled` devolve nada, e
--     a RPC devolve o valor. É bypass de um controle deliberado — e entre as
--     chaves não-públicas está `background_check_provider = 'mock'`.
--
-- Nenhuma tela pré-login chama RPC: conferido, as cinco `.rpc()` do app
-- (`accept_driver_disclosure`, `apply_driver_split`, `confirm_driver_before_boarding`,
-- `increment_driver_period_mileage`, `nearby_online_drivers`) rodam com sessão.
-- O único caminho público de verdade, a `resolve-driver-code`, usa
-- `SUPABASE_SERVICE_ROLE_KEY` por dentro (`index.ts:90,400`) e não passa por
-- `anon`. Revogar não tira função de ninguém.
--
-- Funções de GATILHO ficam de fora: o Postgres recusa chamá-las diretamente, e
-- o privilégio delas é conferido na criação do gatilho, não a cada disparo.
-- Mexer nelas seria risco sem ganho.

do $$
declare
  r record;
  v_n integer := 0;
begin
  for r in
    select p.oid::regprocedure as assinatura
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
       and pg_get_function_result(p.oid) <> 'trigger'
       and has_function_privilege('anon', p.oid, 'EXECUTE')
  loop
    -- `public` junto com `anon`, e não é redundância: o Postgres concede
    -- EXECUTE ao pseudopapel PUBLIC em TODA função nova, e `revoke … from anon`
    -- não tira isso — `anon` continua alcançando pela herança. Nenhuma função
    -- de hoje está nesse estado (conferido), mas a próxima nasce assim.
    execute format('revoke execute on function %s from public, anon', r.assinatura);
    v_n := v_n + 1;
  end loop;
  raise notice '0075: EXECUTE de anon/PUBLIC revogado em % função(ões) de public.', v_n;
end $$;

-- `accept_trip_offer` também sai de `authenticated`: quem a chama é o
-- dispatch-engine com `service_role` (`dispatch-engine/index.ts:555`), e não
-- existe uma só `.rpc('accept_trip_offer')` no app. Com o guarda da seção A
-- corrigido ela já estaria protegida; tirar o privilégio é a segunda tranca,
-- que não depende de o corpo da função continuar certo.
revoke execute on function public.accept_trip_offer(uuid, uuid) from authenticated;

-- ── D. A trava, para a próxima função não nascer aberta ──────────────────────
--
-- Igual à seção B da 0073, e pelo mesmo motivo: o default privilege continua
-- ligado, então a próxima função criada em `public` nasce executável por `anon`
-- outra vez. A asserção não conserta — obriga quem criar a decidir e a escrever
-- a exceção aqui, com o motivo.

do $$
declare
  v_bad text;
begin
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and pg_get_function_result(p.oid) <> 'trigger'
     and has_function_privilege('anon', p.oid, 'EXECUTE');

  if v_bad is not null then
    raise exception '0075 incompleta: anon ainda executa: %. Se você acabou de criar esta função e já revogou de `anon`, falta o PUBLIC: `revoke execute on function <f> from public, anon`.', v_bad;
  end if;
end $$;

-- ── E. E que as duas guardas consertadas não voltem ao formato antigo ────────

do $$
declare
  v_bad text;
begin
  select string_agg(p.proname, ', ') into v_bad
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prokind = 'f'
     and pg_get_functiondef(p.oid) ~* 'auth\.uid\(\)\s+is\s+not\s+null\s+and';

  if v_bad is not null then
    raise exception '0075 incompleta: guarda que se auto-desliga com uid nulo em: %', v_bad;
  end if;
end $$;

comment on function public.accept_trip_offer(uuid, uuid) is
  'Elege atomicamente o vencedor de um pedido e revoga as ofertas perdedoras. Chamada só pelo dispatch-engine com service_role. A autorização testa auth.role(), NÃO a ausência de auth.uid(): até a 0075 a guarda usava `auth.uid() is not null and ...`, e uma chamada sem login passava direto — aceitando corrida em nome de outro motorista e gravando o aceite dele em dispatch_events.';
