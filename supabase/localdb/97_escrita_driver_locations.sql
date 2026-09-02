-- ═════════════════════════════════════════════════════════════════════════════
-- O MOTORISTA CONSEGUE PUBLICAR POSIÇÃO? — prova sem mock
-- ═════════════════════════════════════════════════════════════════════════════
--
-- POR QUE ESTE ARQUIVO EXISTE. Todo teste do "Online que volta sozinho" é
-- mockado: eles provam que `decideStatusRevert` decide certo e que o payload
-- tem o formato esperado. Nenhum prova que a escrita CHEGA AO BANCO sob os
-- GRANTs e a RLS reais — e o mock devolve sucesso justamente no caminho que o
-- Postgres recusava com 42501 (ver o cabeçalho da migration 0080).
--
-- Aqui não há mock nenhum. É o Postgres, com o schema e as 80 migrations
-- aplicados, executando O COMANDO QUE O PostgREST EMITE, sob o papel
-- `authenticated` de verdade, com `request.jwt.claims` no lugar do JWT — a mesma
-- forma que `auth.uid()` lê em produção.
--
-- ─── O SQL ABAIXO É ESCRITO À MÃO, DE PROPÓSITO ─────────────────────────────
-- Ele não é gerado pelo app nem derivado do código dele. É a transcrição do que
-- o PostgREST monta para um `supabase.from('driver_locations').upsert({...})
-- .select('is_online')`: `insert ... on conflict (<pk>) do update set <col> =
-- excluded.<col>` para cada coluna do payload, com `returning` só das colunas
-- pedidas no `.select`. Montar a entrada com a mesma fórmula que o código usa
-- para interpretá-la não provaria nada.
--
-- ─── O QUE ELE NÃO PROVA — leia antes de citar ──────────────────────────────
--   · Nada sobre PRODUÇÃO. Este é um banco descartável construído do repositório.
--     Quem responde por produção é `supabase/scripts/diagnostico_driver_locations.sql`,
--     que o dono roda no SQL Editor.
--   · Nada sobre o PostgREST em si: se ele emite exatamente este SQL é
--     conhecimento sobre o PostgREST, não medição deste banco. O que está
--     medido é o efeito DESTE comando sobre ESTAS regras.
--   · Nada sobre o aparelho, o GPS, ou a build instalada.
-- ═════════════════════════════════════════════════════════════════════════════

do $$
declare
  dave   uuid := 'ddaa0000-0000-4000-8000-000000000001';  -- motorista habilitado
  zico   uuid := 'ddaa0000-0000-4000-8000-000000000002';  -- motorista SEM Stripe Connect
  nina   uuid := 'ddaa0000-0000-4000-8000-000000000003';  -- passageira EM corrida com o Dave
  bob    uuid := 'ddaa0000-0000-4000-8000-000000000004';  -- conta logada qualquer
  corrida uuid;
  v_online boolean;
  v_n      integer;
  v_agora  timestamptz := now();
begin
  -- ── Semeadura, como superusuário. Não é o app: é o banco. ────────────────
  insert into auth.users (id, email) values
    (dave, 'dave@pos.local'), (zico, 'zico@pos.local'),
    (nina, 'nina@pos.local'), (bob,  'bob@pos.local');

  -- `role = service_role` no claim porque `guard_profile_insert_privileges`
  -- (0065) zera as flags de Stripe de todo INSERT que não venha da service key
  -- — é o guarda de dinheiro fazendo o trabalho dele. Sem isto o Dave nasceria
  -- inelegível e o teste mediria a coerção do trigger 0038, não o privilégio.
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);

  insert into public.profiles (id, full_name, phone, email, type,
                               stripe_charges_enabled, stripe_payouts_enabled) values
    (dave, 'Dave Motorista', '+15559001', 'dave@pos.local', 'driver',    true,  true),
    (zico, 'Zico Sem Repasse','+15559002', 'zico@pos.local', 'driver',    false, false),
    (nina, 'Nina Passageira','+15559003', 'nina@pos.local', 'passenger', false, false),
    (bob,  'Bob Logado',     '+15559004', 'bob@pos.local',  'passenger', false, false);

  -- Uma posição para o Dave, gravada pelo BANCO (não pelo app): é o alvo que os
  -- ataques de leitura mais abaixo tentam colher.
  insert into public.driver_locations (driver_id, lat, lng, heading, is_online, updated_at)
  values (dave, 28.4177, -81.3081, 90, true, v_agora);

  insert into public.rides (
    passenger_id, driver_id, origin_lat, origin_lng, origin_address,
    destination_lat, destination_lng, destination_address, status
  ) values (
    nina, dave, 28.41, -81.30, 'Universal', 28.43, -81.31, 'MCO', 'accepted'
  ) returning id into corrida;

  -- ══ 1. O CAMINHO REAL: o motorista publica posição ════════════════════════
  --    Este é o comando de `DriverRideContext.tsx:327` e `:535`, e é o único
  --    ponto do app que cria a linha e carimba `updated_at` — sem ele o
  --    motorista não entra em leque de despacho nenhum.
  perform set_config('request.jwt.claims',
    json_build_object('sub', dave, 'role', 'authenticated')::text, true);
  set local role authenticated;

  insert into public.driver_locations
    ("driver_id", "lat", "lng", "heading", "is_online", "updated_at")
  values (dave, 28.5383, -81.3792, 45, true, v_agora)
  on conflict ("driver_id") do update set
    "driver_id"  = excluded."driver_id",
    "lat"        = excluded."lat",
    "lng"        = excluded."lng",
    "heading"    = excluded."heading",
    "is_online"  = excluded."is_online",
    "updated_at" = excluded."updated_at"
  returning "is_online" into v_online;

  reset role;

  if v_online is distinct from true then
    raise exception 'escrita: o upsert de posição não deixou o motorista online (devolveu %)', v_online;
  end if;

  -- E a posição chegou de verdade — não basta o comando não ter errado.
  -- Literais escritos à mão, conferidos contra o que foi enviado.
  select count(*) into v_n from public.driver_locations
   where driver_id = dave and lat = 28.5383 and lng = -81.3792 and is_online = true;
  if v_n <> 1 then
    raise exception 'escrita: a coordenada nova não está na tabela (% linhas)', v_n;
  end if;

  -- ══ 2. CAUSAÇÃO: sem o grant da 0080, o MESMO comando morre em 42501 ══════
  --    Correlação não bastaria. Aqui a única variável que muda é o privilégio
  --    de coluna que a 0080 devolve — tudo o mais (policy, trigger, payload,
  --    papel) fica idêntico. Revogado, o comando tem de falhar; devolvido, tem
  --    de passar. É esta seção que transforma "funciona" em "funciona POR ISTO".
  revoke select (lat, lng, heading) on public.driver_locations from authenticated;

  perform set_config('request.jwt.claims',
    json_build_object('sub', dave, 'role', 'authenticated')::text, true);
  set local role authenticated;

  begin
    insert into public.driver_locations
      ("driver_id", "lat", "lng", "heading", "is_online", "updated_at")
    values (dave, 28.6, -81.4, 45, true, v_agora)
    on conflict ("driver_id") do update set
      "driver_id"  = excluded."driver_id",
      "lat"        = excluded."lat",
      "lng"        = excluded."lng",
      "heading"    = excluded."heading",
      "is_online"  = excluded."is_online",
      "updated_at" = excluded."updated_at"
    returning "is_online" into v_online;

    raise exception 'escrita: o upsert PASSOU sem o grant da 0080 — a causa do 42501 não é o privilégio de coluna, e o diagnóstico da 0080 está errado';
  exception
    when insufficient_privilege then null;  -- 42501: é exatamente o desfecho esperado
  end;

  reset role;
  grant select (lat, lng, heading) on public.driver_locations to authenticated;

  -- ══ 3. O UPDATE simples (caminho sem fix de GPS) continua passando ════════
  --    `DriverRideContext.tsx:543`. Ele nunca dependeu do grant — é justamente
  --    por isso que o motorista conseguia mexer na chave e mesmo assim não
  --    receber corrida: o status ia, a posição não.
  perform set_config('request.jwt.claims',
    json_build_object('sub', dave, 'role', 'authenticated')::text, true);
  set local role authenticated;
  update public.driver_locations set is_online = true
   where driver_id = dave returning is_online into v_online;
  reset role;

  if v_online is distinct from true then
    raise exception 'escrita: o UPDATE só de status não passou (devolveu %)', v_online;
  end if;

  -- ══ 4. O upsert SEM coordenada morre em 23502 ═════════════════════════════
  --    É o diagnóstico do conserto anterior (4a86047), confirmado aqui contra o
  --    Postgres: `lat`/`lng` são NOT NULL sem default e o `on conflict` valida a
  --    tupla PROPOSTA antes de resolver o conflito — mesmo com a linha do
  --    motorista já existindo, como está o caso agora.
  perform set_config('request.jwt.claims',
    json_build_object('sub', dave, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.driver_locations ("driver_id", "is_online")
    values (dave, true)
    on conflict ("driver_id") do update set
      "driver_id" = excluded."driver_id", "is_online" = excluded."is_online";
    raise exception 'escrita: o upsert SEM coordenada passou — o diagnóstico de NOT NULL do 4a86047 caducou e o app pode voltar a fazer upsert sem fix';
  exception
    when not_null_violation then null;  -- 23502: é o desfecho esperado
  end;
  reset role;

  -- ══ 5. O trigger da 0038 continua coagindo quem não tem repasse ══════════
  --    Sucesso SEM erro e com `is_online` false: é a recusa silenciosa que o
  --    `.select('is_online')` do app existe para enxergar.
  perform set_config('request.jwt.claims',
    json_build_object('sub', zico, 'role', 'authenticated')::text, true);
  set local role authenticated;
  insert into public.driver_locations
    ("driver_id", "lat", "lng", "heading", "is_online", "updated_at")
  values (zico, 28.5, -81.4, 0, true, v_agora)
  on conflict ("driver_id") do update set
    "driver_id" = excluded."driver_id", "lat" = excluded."lat", "lng" = excluded."lng",
    "heading" = excluded."heading", "is_online" = excluded."is_online",
    "updated_at" = excluded."updated_at"
  returning "is_online" into v_online;
  reset role;

  if v_online is distinct from false then
    raise exception 'escrita: motorista sem Stripe Connect ficou online (devolveu %) — o gate da 0038 caiu', v_online;
  end if;

  -- ══ 6. Ninguém escreve a linha de outro motorista ════════════════════════
  perform set_config('request.jwt.claims',
    json_build_object('sub', zico, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into public.driver_locations
      ("driver_id", "lat", "lng", "heading", "is_online", "updated_at")
    values (dave, 1, 1, 0, true, v_agora)
    on conflict ("driver_id") do update set
      "driver_id" = excluded."driver_id", "lat" = excluded."lat", "lng" = excluded."lng",
      "heading" = excluded."heading", "is_online" = excluded."is_online",
      "updated_at" = excluded."updated_at";
    raise exception 'escrita: Zico reescreveu a posição do Dave — a RLS de escrita caiu';
  exception
    when insufficient_privilege then null;
  end;
  reset role;

  -- ══ 7. O grant da 0080 NÃO reabre a colheita da frota ════════════════════
  --    Esta é a asserção que sustenta a alínea (b) do cabeçalho da 0080: quem
  --    fecha a frota agora é a POLICY, não o privilégio de coluna. Bob é uma
  --    conta logada comum, com o mesmo papel `authenticated` do motorista.
  --    Precisa ser ZERO LINHAS — e sem erro, porque o privilégio existe: o que
  --    o barra é a RLS.
  perform set_config('request.jwt.claims',
    json_build_object('sub', bob, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.driver_locations where lat is not null;
  reset role;
  if v_n <> 0 then
    raise exception 'vazamento: conta logada comum colheu % posição(ões) da frota', v_n;
  end if;

  -- ══ 8. …e o passageiro EM CORRIDA continua vendo o carro dele ════════════
  --    O contrapeso da 7. Um arquivo que só verifica ataque dá verde num banco
  --    em que ninguém consegue usar o aplicativo.
  perform set_config('request.jwt.claims',
    json_build_object('sub', nina, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.driver_locations
   where driver_id = dave and lat = 28.5383;
  reset role;
  if v_n <> 1 then
    raise exception 'regressão: a passageira em corrida NÃO lê a posição do próprio motorista (% linhas) — o carro some do mapa dela', v_n;
  end if;

  -- ══ 9. O motorista lê a PRÓPRIA posição ══════════════════════════════════
  perform set_config('request.jwt.claims',
    json_build_object('sub', dave, 'role', 'authenticated')::text, true);
  set local role authenticated;
  select count(*) into v_n from public.driver_locations where driver_id = dave and lat = 28.5383;
  reset role;
  if v_n <> 1 then
    raise exception 'regressão: o motorista não lê a própria posição (% linhas)', v_n;
  end if;

  -- ── Limpeza. O banco é descartável, mas deixar lixo faria a próxima ──────
  --    asserção de contagem mentir.
  delete from public.rides            where id = corrida;
  delete from public.driver_locations where driver_id in (dave, zico);
  delete from public.profiles         where id in (dave, zico, nina, bob);
  delete from auth.users              where id in (dave, zico, nina, bob);

  raise notice 'escrita em driver_locations: publicação de posição OK, causação do 42501 demonstrada, frota segue fechada.';
end $$;
