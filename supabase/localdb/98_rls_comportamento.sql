-- ═════════════════════════════════════════════════════════════════════════════
-- COMPORTAMENTO DA RLS — o ataque prova o que a policy não prova
-- ═════════════════════════════════════════════════════════════════════════════
--
-- O 99_verificacao.sql confere a FORMA das regras: a policy existe, o papel é
-- `authenticated`, a reloption está lá. Este arquivo confere o EFEITO: um
-- usuário de verdade tenta alcançar o dado de outro e precisa falhar.
--
-- A distância entre as duas coisas não é teórica. Ela produziu três defeitos
-- nesta auditoria:
--
--   · a 0012 aplicou limpo por anos sem surtir efeito (P0-12);
--   · a 0067 exigia `{authenticated}` e ela própria deixava um `{public}`;
--   · `profiles_public` tinha todas as policies certas em `profiles` e mesmo
--     assim aceitava UPDATE e DELETE de qualquer conta logada, porque o acesso
--     nem passava pela RLS (P0-13, consertado na 0073).
--
-- Nenhum dos três é visível em `pg_policies`. Os três morrem aqui.
--
-- COMO FUNCIONA: `set local role authenticated` troca o papel de verdade — o
-- superusuário não está mais no comando, então a RLS se aplica. E
-- `request.jwt.claims` faz o papel do token que o PostgREST injetaria, que é a
-- mesma forma que `auth.uid()` lê em produção.
--
-- O QUE ELE NÃO PROVA: nada sobre o PostgREST em si (rota, parsing de filtro,
-- limite de linhas), nada sobre o GoTrue emitir esse claim, nada sobre
-- produção. É o Postgres respondendo a um papel, que é a camada onde a RLS mora
-- — e é justamente a camada que ninguém tinha exercitado.

do $$
declare
  alice uuid := 'aaaaaaaa-0000-4000-8000-000000000001';
  bob   uuid := 'bbbbbbbb-0000-4000-8000-000000000002';
  dave  uuid := 'dddddddd-0000-4000-8000-000000000003';
  corrida uuid;
  corrida_feita uuid;
  pedido  uuid;
  v_n     integer;
  v_erro  text;
begin
  -- ── Semeadura, como superusuário. Não é o app: é o banco. ────────────────
  insert into auth.users (id, email) values
    (alice, 'alice@rls.local'), (bob, 'bob@rls.local'), (dave, 'dave@rls.local')
  on conflict (id) do nothing;

  insert into public.profiles (id, full_name, phone, email, type) values
    (alice, 'Alice Vitima',   '+15550001', 'alice@rls.local', 'passenger'),
    (bob,   'Bob Atacante',   '+15550002', 'bob@rls.local',   'passenger'),
    (dave,  'Dave Motorista', '+15550003', 'dave@rls.local',  'driver')
  on conflict (id) do nothing;

  insert into public.rides (
    passenger_id, origin_lat, origin_lng, origin_address,
    destination_lat, destination_lng, destination_address, status
  ) values (
    alice, 28.4, -81.3, 'Casa da Alice', 28.43, -81.31, 'MCO', 'requesting'
  ) returning id into corrida;

  -- Posição REAL do Dave, ONLINE. É o alvo do ataque nº 5, e sem esta linha
  -- aquele ataque seria vazio: uma tabela sem linha devolve zero por si só e a
  -- asserção passaria num banco sem RLS nenhuma.
  --
  -- O `is_online = true` é o caso adversarial mais forte de propósito: era
  -- exatamente esta a condição da policy ampla que a 0069:711 removeu. Para
  -- gravá-lo é preciso passar pelo gate da 0038, que coage `is_online := false`
  -- para motorista sem Connect — daí as flags irem a true e VOLTAREM logo em
  -- seguida, deixando o perfil do Dave como o resto deste arquivo o espera. O
  -- claim de service_role é o que faz o guarda de dinheiro da 0065 deixar
  -- escrever as flags.
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  update public.profiles set stripe_charges_enabled = true, stripe_payouts_enabled = true where id = dave;
  insert into public.driver_locations (driver_id, lat, lng, heading, is_online, updated_at)
  values (dave, 28.5383, -81.3792, 90, true, now())
  on conflict (driver_id) do update set lat = 28.5383, lng = -81.3792, is_online = true;
  update public.profiles set stripe_charges_enabled = false, stripe_payouts_enabled = false where id = dave;
  perform set_config('request.jwt.claims', '', true);

  -- ── Bob entra. Conta comum de passageiro, nada de especial. ──────────────
  perform set_config('request.jwt.claims',
    json_build_object('sub', bob, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- 1. O perfil da vítima não se lê pela tabela. Este é o CONTROLE: se ele
  --    falhar, o ambiente está errado e nenhuma asserção abaixo significa nada.
  select count(*) into v_n from public.profiles where id = alice;
  if v_n <> 0 then
    raise exception 'rls: controle falhou — Bob leu profiles de Alice (% linhas). A RLS não está sendo aplicada; o resto deste arquivo não prova nada.', v_n;
  end if;

  -- 1b. …e o PRÓPRIO perfil ele lê. Sem esta asserção, revogar privilégio
  --     DEMAIS passaria como "seguro": um arquivo que só verifica ataque dá
  --     verde num banco em que ninguém consegue usar o aplicativo.
  select count(*) into v_n from public.profiles where id = bob;
  if v_n <> 1 then
    raise exception 'rls: Bob não lê o PRÓPRIO perfil (% linhas) — o app não abriria a conta dele', v_n;
  end if;

  -- 2. Nem a corrida dela, na tabela ou na view.
  select count(*) into v_n from public.rides where id = corrida;
  if v_n <> 0 then
    raise exception 'rls: Bob leu a corrida de Alice em `rides`';
  end if;

  select count(*) into v_n from public.rides_with_locations where id = corrida;
  if v_n <> 0 then
    raise exception 'rls: Bob leu a corrida de Alice por `rides_with_locations` — a view perdeu security_invoker';
  end if;

  -- 3. P0-13 — escrita por cima da RLS através de `profiles_public`.
  --    Antes da 0073 estas três linhas devolviam 1 cada uma.
  begin
    update public.profiles_public set full_name = 'INVADIDO' where id = alice;
    get diagnostics v_n = row_count;
    if v_n <> 0 then
      raise exception 'rls: P0-13 regrediu — Bob reescreveu o nome de Alice por profiles_public (% linhas)', v_n;
    end if;
  exception
    when insufficient_privilege then null;  -- é o desfecho correto
  end;

  begin
    update public.profiles_public set rating = 1.0 where id = alice;
    get diagnostics v_n = row_count;
    if v_n <> 0 then
      raise exception 'rls: P0-13 regrediu — Bob rebaixou a nota de Alice (% linhas)', v_n;
    end if;
  exception
    when insufficient_privilege then null;
  end;

  begin
    delete from public.profiles_public where id = bob;  -- a PRÓPRIA linha: o caso mais fácil
    get diagnostics v_n = row_count;
    if v_n <> 0 then
      raise exception 'rls: P0-13 regrediu — DELETE por profiles_public apagou % linha(s)', v_n;
    end if;
  exception
    when insufficient_privilege then null;
  end;

  -- 4. Sequestro de corrida por quem não é motorista.
  --    Sem `returning`, que é o que o supabase-js manda por padrão — com
  --    `returning` as policies de SELECT entram e mascarariam o resultado.
  update public.rides set driver_id = bob, status = 'accepted' where id = corrida;
  get diagnostics v_n = row_count;
  if v_n <> 0 then
    raise exception 'rls: um PASSAGEIRO aceitou corrida alheia (% linhas) — a policy de UPDATE de rides depende de is_driver() na policy de SELECT; alguém afrouxou uma das duas', v_n;
  end if;

  -- 5. Coordenada de motorista ONLINE, sem corrida ativa com o Bob. O que se
  --    exige aqui é o DESFECHO — Bob não obtém a coordenada —, não o mecanismo.
  --
  --    A distinção não é acadêmica, e foi esta asserção que a produziu. Ela
  --    nasceu exigindo o erro 42501: entre a 0069 e a 0080, quem barrava era o
  --    privilégio de coluna. Só que esse mesmo privilégio barrava também o
  --    `on conflict do update set lat = excluded.lat` do upsert do PostgREST, e
  --    nenhum motorista conseguia publicar posição (ver o cabeçalho da 0080).
  --    Com o privilégio devolvido, quem barra é a POLICY: a 0069:711 removeu o
  --    ramo amplo `is_online = true` e sobraram duas policies de SELECT, ambas
  --    ancoradas em auth.uid(). Bob não casa nenhuma das duas.
  --
  --    Escrita em cima do erro, a asserção teria falhado num banco SEGURO e
  --    empurrado o conserto de volta. Escrita em cima do desfecho, ela sobrevive
  --    à troca de mecanismo e continua pegando o que importa. A FORMA (nenhuma
  --    policy de leitura sem auth.uid()) é guardada à parte, na 99 §9b.
  --
  --    Nota sobre erro vs. zero linhas: se o privilégio for revogado de novo,
  --    isto levanta `insufficient_privilege` em vez de devolver zero — e o
  --    desfecho de segurança é o mesmo, então os dois passam. O que NÃO passa é
  --    Bob receber a coordenada.
  begin
    select count(*) into v_n from public.driver_locations
     where driver_id = dave and lat is not null;
    if v_n <> 0 then
      raise exception 'rls: Bob leu lat/lng de motorista online sem corrida ativa (% linhas) — a policy ampla `is_online = true` voltou a driver_locations', v_n;
    end if;
  exception
    when insufficient_privilege then null;  -- barrado pelo privilégio: mesmo desfecho
  end;

  -- ── Dave entra. É motorista de verdade; o pool aberto é para ele. ─────────
  reset role;
  perform set_config('request.jwt.claims',
    json_build_object('sub', dave, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into v_n from public.rides where id = corrida;
  if v_n <> 1 then
    raise exception 'rls: motorista NÃO enxerga o pool aberto (% linhas) — o app não teria como aceitar corrida nenhuma', v_n;
  end if;

  -- ── anon não é ninguém. ──────────────────────────────────────────────────
  reset role;
  perform set_config('request.jwt.claims', '', true);
  set local role anon;

  select count(*) into v_n from public.rides;
  if v_n <> 0 then
    raise exception 'rls: anon leu % corrida(s)', v_n;
  end if;

  v_erro := null;
  begin
    perform 1 from public.profiles_public;
    v_erro := 'passou';
  exception
    when insufficient_privilege then null;
  end;
  if v_erro is not null then
    raise exception 'rls: anon leu o diretório de usuários por profiles_public';
  end if;

  -- ══ RPCs: o guarda que se desligava por NÃO haver login (0075) ═══════════
  --
  -- `accept_trip_offer` conferia `auth.uid() is not null and auth.uid() <> ...`.
  -- Sem JWT, a primeira condição é falsa, o `and` corta, e a exceção nunca sai.
  -- O ataque não precisava de exploit: precisava de NÃO fazer login.
  reset role;
  perform set_config('request.jwt.claims', '', true);

  insert into public.trip_requests (ride_id, passenger_id, pickup_lat, pickup_lng, status)
  values (corrida, alice, 28.4, -81.3, 'OFFERING') returning id into pedido;

  insert into public.ride_offers (trip_request_id, driver_id, status, expires_at)
  values (pedido, dave, 'PENDING', now() + interval '5 minutes');

  -- 8. anon aceitando em nome do motorista. Devolvia 'ACCEPTED' antes da 0075.
  set local role anon;
  v_erro := null;
  begin
    perform public.accept_trip_offer(pedido, dave);
    v_erro := 'passou';
  exception
    when insufficient_privilege then null;
  end;
  if v_erro is not null then
    raise exception 'rls: anon aceitou corrida em nome de um motorista — a guarda da 0075 caiu';
  end if;

  -- 9. …e um usuário logado que não é o motorista, tampouco.
  reset role;
  perform set_config('request.jwt.claims',
    json_build_object('sub', bob, 'role', 'authenticated')::text, true);
  set local role authenticated;
  v_erro := null;
  begin
    perform public.accept_trip_offer(pedido, dave);
    v_erro := 'passou';
  exception
    when insufficient_privilege then null;
  end;
  if v_erro is not null then
    raise exception 'rls: um terceiro logado aceitou corrida em nome do motorista';
  end if;

  -- ══ Recursão entre policies (0076) ══════════════════════════════════════
  --
  -- `trip_requests_select` consultava `ride_offers` e vice-versa. Com RLS nas
  -- duas, o Postgres detecta o ciclo e aborta a consulta INTEIRA com 42P17 —
  -- inclusive para o dono da linha. Um ciclo de RLS não aparece em `pg_policies`
  -- nem em `pg_depend`: ele só existe na hora da consulta, então SÓ um teste de
  -- comportamento o encontra. Estas quatro asserções são a razão de este arquivo
  -- existir separado da 99.
  --
  -- Elas cobrem os dois sentidos: o que TEM de funcionar e não funcionava, e o
  -- que não pode passar a funcionar junto com o conserto.

  reset role;
  perform set_config('request.jwt.claims',
    json_build_object('sub', alice, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.trip_requests where id = pedido;
  if v_n <> 1 then
    raise exception 'rls: o passageiro DONO não lê o próprio trip_request (% linhas) — se o erro for 42P17, a recursão de policy da 0076 voltou', v_n;
  end if;

  reset role;
  perform set_config('request.jwt.claims',
    json_build_object('sub', dave, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.trip_requests where id = pedido;
  if v_n <> 1 then
    raise exception 'rls: o motorista COM oferta não lê o trip_request (% linhas) — o card de oferta nunca apareceria', v_n;
  end if;

  select count(*) into v_n from public.ride_offers where driver_id = dave;
  if v_n <> 1 then
    raise exception 'rls: o motorista não lê a PRÓPRIA oferta (% linhas)', v_n;
  end if;

  -- …e o conserto não pode ter aberto a porta para quem não tem oferta.
  reset role;
  perform set_config('request.jwt.claims',
    json_build_object('sub', bob, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.ride_offers where trip_request_id = pedido;
  if v_n <> 0 then
    raise exception 'rls: um terceiro leu as ofertas de um pedido alheio (% linhas)', v_n;
  end if;

  -- 10. Milhagem de jornada: o dado que a conformidade de horas usa.
  --     Chamada anônima gravava 999 milhas na ficha de qualquer motorista.
  reset role;
  set local role anon;
  v_erro := null;
  begin
    perform public.increment_driver_period_mileage(dave, current_date, 999, 0, 0, 999);
    v_erro := 'passou';
  exception
    when insufficient_privilege then null;
  end;
  if v_erro is not null then
    raise exception 'rls: anon gravou milhagem de jornada de um motorista';
  end if;

  -- 11. Legítimo preservado: o motorista incrementa a PRÓPRIA milhagem.
  --     Sem esta asserção, revogar demais passaria por conserto.
  reset role;
  perform set_config('request.jwt.claims',
    json_build_object('sub', dave, 'role', 'authenticated')::text, true);
  set local role authenticated;
  perform public.increment_driver_period_mileage(dave, current_date, 12, 0, 0, 12);

  select p1_miles into v_n from public.driver_period_daily_mileage
   where driver_id = dave and day = current_date;
  if coalesce(v_n, 0) <> 12 then
    raise exception 'rls: o motorista não consegue mais gravar a PRÓPRIA milhagem (% milhas) — o app pararia de registrar jornada', coalesce(v_n, 0);
  end if;

  -- 12. Legítimo preservado: o dispatch-engine (service_role) aceita de verdade.
  reset role;
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  set local role service_role;
  if public.accept_trip_offer(pedido, dave) <> 'ACCEPTED' then
    raise exception 'rls: o dispatch-engine não consegue mais eleger vencedor — nenhuma corrida seria aceita';
  end if;

  -- ══ Avaliação e registro da frota (0077) ════════════════════════════════
  --
  -- A policy de INSERT em `ratings` conferia só o remetente: Bob avaliava com 1
  -- estrela um motorista que nunca o levou, e avaliava a si mesmo com 5. E
  -- `vehicles` tinha `using (true)` para `authenticated` — a PLACA de toda a
  -- frota legível por qualquer conta grátis.
  --
  -- Aqui as duas metades importam igualmente: o ataque tem de morrer E a
  -- avaliação de verdade tem de continuar acontecendo.

  reset role;
  insert into public.rides (
    passenger_id, driver_id, origin_lat, origin_lng, origin_address,
    destination_lat, destination_lng, destination_address, status
  ) values (alice, dave, 28.4, -81.3, 'Casa da Alice', 28.43, -81.31, 'MCO', 'completed')
  returning id into corrida_feita;

  insert into public.vehicles (driver_id, model, plate, color, year)
  values (dave, 'Suburban', 'RLS-0077', 'Preto', 2025);

  perform set_config('request.jwt.claims',
    json_build_object('sub', bob, 'role', 'authenticated')::text, true);
  set local role authenticated;

  -- 13. A placa do motorista de outra pessoa.
  select count(*) into v_n from public.vehicles where driver_id = dave;
  if v_n <> 0 then
    raise exception 'rls: um terceiro leu a placa do veículo de um motorista com quem nunca andou (% linhas)', v_n;
  end if;

  -- 14. Avaliar um motorista usando corrida alheia.
  v_erro := null;
  begin
    insert into public.ratings (ride_id, from_user, to_user, score)
    values (corrida_feita, bob, dave, 1);
    v_erro := 'passou';
  exception
    when insufficient_privilege then null;
  end;
  if v_erro is not null then
    raise exception 'rls: um terceiro avaliou um motorista numa corrida de que não participou';
  end if;

  -- 15. …e avaliar a si mesmo.
  v_erro := null;
  begin
    insert into public.ratings (ride_id, from_user, to_user, score)
    values (corrida_feita, bob, bob, 5);
    v_erro := 'passou';
  exception
    when insufficient_privilege then null;
  end;
  if v_erro is not null then
    raise exception 'rls: um usuário avaliou a si mesmo';
  end if;

  -- Legítimos: quem andou junto lê o carro e avalia.
  reset role;
  perform set_config('request.jwt.claims',
    json_build_object('sub', alice, 'role', 'authenticated')::text, true);
  set local role authenticated;

  select count(*) into v_n from public.vehicles where driver_id = dave;
  if v_n <> 1 then
    raise exception 'rls: a passageira NÃO lê o veículo do próprio motorista (% linhas) — o card do carro ficaria vazio', v_n;
  end if;

  insert into public.ratings (ride_id, from_user, to_user, score)
  values (corrida_feita, alice, dave, 5);

  select count(*) into v_n from public.ratings where ride_id = corrida_feita;
  if v_n <> 1 then
    raise exception 'rls: a avaliação legítima não foi gravada (% linhas)', v_n;
  end if;

  -- ── Limpeza. O banco é descartável, mas deixar lixo faria a próxima ──────
  --    asserção de contagem mentir.
  reset role;
  delete from public.ratings  where ride_id = corrida_feita;
  delete from public.vehicles where driver_id = dave;
  delete from public.rides    where id = corrida_feita;
  delete from public.dispatch_events where trip_request_id = pedido;
  delete from public.ride_offers      where trip_request_id = pedido;
  delete from public.trip_requests    where id = pedido;
  delete from public.driver_period_daily_mileage where driver_id = dave;
  delete from public.driver_locations where driver_id = dave;
  delete from public.rides    where passenger_id = alice;
  delete from public.profiles where id in (alice, bob, dave);
  delete from auth.users      where id in (alice, bob, dave);

  raise notice 'comportamento da RLS: 18 ataques barrados, 9 acessos legítimos preservados.';
end $$;
