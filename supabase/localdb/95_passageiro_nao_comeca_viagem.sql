-- ═════════════════════════════════════════════════════════════════════════════
-- O PASSAGEIRO CONSEGUE COMEÇAR A VIAGEM? — prova sem mock
-- ═════════════════════════════════════════════════════════════════════════════
--
-- A 0082 se auto-verifica só até onde dá: as asserções dela provam que o trigger
-- foi pendurado e que a função não ficou aberta. Não provam que um UPDATE REAL
-- cai — e "instalou" e "recusa" são coisas diferentes.
--
-- Aqui é o Postgres com as 82 migrations, rodando o UPDATE que o app do
-- passageiro emite, sob o papel `authenticated` e com `request.jwt.claims` no
-- lugar do JWT.
--
-- NÃO-CIRCULAR: todo caso de bloqueio exige que o erro seja
-- `GOXL_PASSENGER_CANNOT_START`. `rides` tem colunas NOT NULL e políticas de
-- RLS; sem exigir o motivo, um UPDATE recusado por outra razão contaria como
-- sucesso e o trigger poderia nem ter sido consultado.

insert into public.profiles (id, full_name, type, phone, email)
values ('44444444-4444-4444-4444-444444444444', 'Passageiro Teste', 'passenger',
        '+15550000001', 'pax@teste.local'),
       ('55555555-5555-5555-5555-555555555555', 'Motorista Teste', 'driver',
        '+15550000002', 'drv@teste.local')
on conflict (id) do nothing;

create or replace function pg_temp.nova_agendada(p_driver uuid)
returns uuid
language plpgsql
as $fn$
declare v_id uuid;
begin
  insert into public.rides (passenger_id, driver_id, status, price, scheduled_for,
                            origin_lat, origin_lng, origin_address,
                            destination_lat, destination_lng, destination_address)
  values ('44444444-4444-4444-4444-444444444444', p_driver, 'scheduled', 45.46,
          now() + interval '2 days',
          28.4230, -81.3041, 'MCO',
          28.5383, -81.3792, 'College Park')
  returning id into v_id;
  return v_id;
end $fn$;

/** Tenta mudar o status como um papel. Devolve 'ok' ou a mensagem do erro. */
create or replace function pg_temp.tenta_status(p_ride uuid, p_papel text, p_uid uuid, p_novo text)
returns text
language plpgsql
as $fn$
declare v_erro text;
begin
  begin
    if p_papel is null then
      perform set_config('request.jwt.claims', '', true);
    else
      perform set_config('request.jwt.claims',
        json_build_object('role', p_papel, 'sub', p_uid)::text, true);
    end if;
    update public.rides set status = p_novo where id = p_ride;
    return 'ok';
  exception when others then
    v_erro := SQLERRM;
    return v_erro;
  end;
end $fn$;

do $$
declare
  r        text;
  v_ride   uuid;
  v_falhas int := 0;
  PAX      constant uuid := '44444444-4444-4444-4444-444444444444';
  DRV      constant uuid := '55555555-5555-5555-5555-555555555555';
begin
  -- 1. O CASO DO RYAN: passageiro tocando "start trip" numa agendada que já tem
  --    motorista. Era isto que cobrava e sumia com o agendamento.
  v_ride := pg_temp.nova_agendada(DRV);
  r := pg_temp.tenta_status(v_ride, 'authenticated', PAX, 'accepted');
  if r not like '%GOXL_PASSENGER_CANNOT_START%' then
    v_falhas := v_falhas + 1;
    raise warning 'FALHOU passageiro→accepted deveria ser barrado, veio: %', r;
  end if;
  if (select status from public.rides where id = v_ride) <> 'scheduled' then
    v_falhas := v_falhas + 1;
    raise warning 'FALHOU o agendamento não sobreviveu ao toque';
  end if;

  -- 2. O outro ramo do mesmo botão: agendada SEM motorista virando 'requesting'.
  v_ride := pg_temp.nova_agendada(null);
  r := pg_temp.tenta_status(v_ride, 'authenticated', PAX, 'requesting');
  if r not like '%GOXL_PASSENGER_CANNOT_START%' then
    v_falhas := v_falhas + 1;
    raise warning 'FALHOU passageiro→requesting deveria ser barrado, veio: %', r;
  end if;

  r := pg_temp.tenta_status(v_ride, 'authenticated', PAX, 'in_progress');
  if r not like '%GOXL_PASSENGER_CANNOT_START%' then
    v_falhas := v_falhas + 1;
    raise warning 'FALHOU passageiro→in_progress deveria ser barrado, veio: %', r;
  end if;

  -- 3. CANCELAR CONTINUA SENDO DIREITO DELE. Barrar isto seria trocar um
  --    defeito por outro pior: passageiro preso numa corrida que não quer.
  v_ride := pg_temp.nova_agendada(DRV);
  r := pg_temp.tenta_status(v_ride, 'authenticated', PAX, 'cancelled');
  if r <> 'ok' then
    v_falhas := v_falhas + 1;
    raise warning 'FALHOU passageiro→cancelled deveria PASSAR, veio: %', r;
  end if;

  -- 4. O MOTORISTA continua começando a corrida — é dele que ela é.
  v_ride := pg_temp.nova_agendada(DRV);
  r := pg_temp.tenta_status(v_ride, 'authenticated', DRV, 'accepted');
  if r <> 'ok' then
    v_falhas := v_falhas + 1;
    raise warning 'FALHOU motorista→accepted deveria PASSAR, veio: %', r;
  end if;

  -- 5. Manutenção nunca cai.
  v_ride := pg_temp.nova_agendada(DRV);
  r := pg_temp.tenta_status(v_ride, 'service_role', PAX, 'accepted');
  if r <> 'ok' then
    v_falhas := v_falhas + 1;
    raise warning 'FALHOU service_role deveria PASSAR, veio: %', r;
  end if;

  v_ride := pg_temp.nova_agendada(DRV);
  r := pg_temp.tenta_status(v_ride, null, null, 'accepted');
  if r <> 'ok' then
    v_falhas := v_falhas + 1;
    raise warning 'FALHOU sem claims (psql/migration) deveria PASSAR, veio: %', r;
  end if;

  -- 6. Corrida que NÃO estava agendada não é assunto deste trigger.
  v_ride := pg_temp.nova_agendada(DRV);
  update public.rides set status = 'accepted' where id = v_ride;
  r := pg_temp.tenta_status(v_ride, 'authenticated', PAX, 'in_progress');
  if r like '%GOXL_PASSENGER_CANNOT_START%' then
    v_falhas := v_falhas + 1;
    raise warning 'FALHOU o trigger mordeu fora de scheduled: %', r;
  end if;

  -- 7. UPDATE que não mexe no status passa (editar horário, notas).
  v_ride := pg_temp.nova_agendada(DRV);
  begin
    perform set_config('request.jwt.claims',
      json_build_object('role','authenticated','sub',PAX)::text, true);
    update public.rides set scheduled_for = now() + interval '3 days' where id = v_ride;
  exception when others then
    v_falhas := v_falhas + 1;
    raise warning 'FALHOU update sem mudar status deveria PASSAR: %', SQLERRM;
  end;

  if v_falhas > 0 then
    raise exception 'passageiro/começar viagem: % caso(s) fora do esperado', v_falhas;
  end if;
  raise notice 'passageiro não começa a viagem: 9/9 casos como esperado.';
end $$;

delete from public.rides where passenger_id = '44444444-4444-4444-4444-444444444444';
delete from public.profiles where id in ('44444444-4444-4444-4444-444444444444',
                                         '55555555-5555-5555-5555-555555555555');
