-- ═════════════════════════════════════════════════════════════════════════════
-- A TRAVA DE VERSÃO RECUSA A BUILD VELHA? — prova sem mock
-- ═════════════════════════════════════════════════════════════════════════════
--
-- A migration 0081 se auto-verifica, mas só até certo ponto: as asserções dela
-- provam que a comparação numérica está certa e que o trigger foi pendurado.
-- Não provam que uma INSERÇÃO REAL cai. "Instalou" e "recusa" são coisas
-- diferentes — a 0012 aplicou por anos sem surtir efeito nenhum.
--
-- Aqui não há mock. É o Postgres com as 81 migrations, rodando `insert into
-- rides` sob o papel `authenticated` de verdade, com `request.jwt.claims` e
-- `request.headers` no lugar do JWT e dos cabeçalhos HTTP — a mesma forma que o
-- PostgREST preenche em produção.
--
-- ── O QUE TORNA ESTE TESTE NÃO-CIRCULAR ───────────────────────────────────
--
-- Todo caso de bloqueio exige que o erro seja `GOXL_UPDATE_REQUIRED`. Sem isso
-- o teste seria uma armadilha: `rides` tem sete colunas NOT NULL, e um INSERT
-- incompleto falharia igual — dando "bloqueou" para um trigger que nem foi
-- consultado. Foi exatamente o que aconteceu na primeira versão desta sonda.
--
-- ── O QUE ELE NÃO PROVA ───────────────────────────────────────────────────
--   · Nada sobre PRODUÇÃO: este é um banco descartável construído do repositório.
--   · Nada sobre o app MANDAR o cabeçalho. Que `src/lib/supabase.ts` carimba
--     `x-goxl-version` é verificado pelo teste de unidade do cliente; aqui só
--     se mede o que o banco faz com o cabeçalho que chega.
--   · Nada sobre a tela de atualização, que é React.
--
-- Ao final, a config volta ao estado INERTE em que a 0081 a semeou, e as
-- corridas de teste são removidas — este arquivo roda antes do 99_verificacao.

-- ─── Um passageiro para ser dono das corridas de teste ───────────────────────
insert into public.profiles (id, full_name, type, phone, email)
values ('11111111-1111-1111-1111-111111111111', 'Trava Teste', 'passenger',
        '+15550000000', 'trava@teste.local')
on conflict (id) do nothing;

-- ─── A sonda ─────────────────────────────────────────────────────────────────
--
-- Devolve 'ok' se o INSERT passou, ou a mensagem do erro. Função temporária:
-- morre com a sessão, não suja o schema que o 99 vai conferir.
create or replace function pg_temp.tentar_corrida(p_papel text, p_versao text)
returns text
language plpgsql
as $fn$
declare
  v_erro text;
begin
  begin
    if p_papel is null then
      perform set_config('request.jwt.claims', '', true);
    else
      perform set_config('request.jwt.claims',
        json_build_object('role', p_papel,
                          'sub', '11111111-1111-1111-1111-111111111111')::text, true);
    end if;

    perform set_config('request.headers',
      case when p_versao is null then '{}'
           else json_build_object('x-goxl-version', p_versao)::text end, true);

    -- O papel do BANCO, não só o claim: assim a RLS de `rides` também vale, e a
    -- prova é a do caminho real. O `reset role` aparece nos DOIS caminhos de
    -- saída porque `set local role` dentro de função persiste até o fim da
    -- transação — sem ele, os UPDATEs de config lá embaixo rodariam como
    -- `authenticated` e morreriam na política de escrita do system_config.
    if p_papel = 'authenticated' then
      set local role authenticated;
    end if;

    insert into public.rides (passenger_id, status, price,
                              origin_lat, origin_lng, origin_address,
                              destination_lat, destination_lng, destination_address)
    values ('11111111-1111-1111-1111-111111111111', 'requesting', 25.00,
            28.4230, -81.3041, 'MCO',
            28.5383, -81.3792, 'Downtown Orlando');

    reset role;
    return 'ok';
  exception when others then
    v_erro := SQLERRM;
    reset role;
    return v_erro;
  end;
end $fn$;

-- ─── Os casos ────────────────────────────────────────────────────────────────
do $$
declare
  r         text;
  v_falhas  int := 0;
begin
  -- 1. INERTE — o estado em que a 0081 nasce. Nada pode mudar hoje.
  r := pg_temp.tentar_corrida('authenticated', null);
  if r <> 'ok' then
    v_falhas := v_falhas + 1;
    raise warning 'FALHOU inerte/sem cabeçalho: %', r;
  end if;

  r := pg_temp.tentar_corrida('authenticated', '1.0.0');
  if r <> 'ok' then
    v_falhas := v_falhas + 1;
    raise warning 'FALHOU inerte/1.0.0: %', r;
  end if;

  -- 2. LIGADA em 1.0.10.
  update public.system_config
     set value = value || jsonb_build_object('enforceServer', true, 'min', '1.0.10')
   where key = 'min_app_version' and jurisdiction = 'global';

  -- 2a. Sem cabeçalho: é TODA build publicada antes da 0081, incluindo a 1.0.0
  -- do Motorola em campo. Este é o caso de uso, não um caso de erro.
  r := pg_temp.tentar_corrida('authenticated', null);
  if r not like '%GOXL_UPDATE_REQUIRED%' then
    v_falhas := v_falhas + 1;
    raise warning 'FALHOU ligada/sem cabeçalho — esperava GOXL_UPDATE_REQUIRED, veio: %', r;
  end if;

  r := pg_temp.tentar_corrida('authenticated', '1.0.0');
  if r not like '%GOXL_UPDATE_REQUIRED%' then
    v_falhas := v_falhas + 1;
    raise warning 'FALHOU ligada/1.0.0 — esperava GOXL_UPDATE_REQUIRED, veio: %', r;
  end if;

  -- 2b. A ARMADILHA DO TEXTO. Como string, '1.0.9' > '1.0.10'. Se a comparação
  -- algum dia virar textual, este é o caso que grita.
  r := pg_temp.tentar_corrida('authenticated', '1.0.9');
  if r not like '%GOXL_UPDATE_REQUIRED%' then
    v_falhas := v_falhas + 1;
    raise warning 'FALHOU ligada/1.0.9 — comparação virou texto? veio: %', r;
  end if;

  -- 2c. Quem está em dia não pode cair.
  foreach r in array array['1.0.10', '1.0.11', '1.1.0', '2.0.0'] loop
    declare v_res text;
    begin
      v_res := pg_temp.tentar_corrida('authenticated', r);
      if v_res <> 'ok' then
        v_falhas := v_falhas + 1;
        raise warning 'FALHOU ligada/% deveria passar, veio: %', r, v_res;
      end if;
    end;
  end loop;

  -- 2d. Manutenção nunca cai: service_role e conexão sem claims (psql, migration,
  -- job) passam mesmo sem cabeçalho nenhum.
  r := pg_temp.tentar_corrida('service_role', null);
  if r <> 'ok' then
    v_falhas := v_falhas + 1;
    raise warning 'FALHOU ligada/service_role deveria passar: %', r;
  end if;

  r := pg_temp.tentar_corrida(null, null);
  if r <> 'ok' then
    v_falhas := v_falhas + 1;
    raise warning 'FALHOU ligada/sem claims deveria passar: %', r;
  end if;

  -- 3. Config torta NÃO vira trava acidental.
  update public.system_config
     set value = value || jsonb_build_object('enforceServer', true, 'min', 'sei la')
   where key = 'min_app_version' and jurisdiction = 'global';
  r := pg_temp.tentar_corrida('authenticated', '1.0.0');
  if r <> 'ok' then
    v_falhas := v_falhas + 1;
    raise warning 'FALHOU min ilegível deveria falhar ABERTO: %', r;
  end if;

  -- A string "true" não é o booleano true. O cliente (lerConfigTrava) exige
  -- `=== true`; se o servidor aceitasse a string, as duas metades discordariam e
  -- o usuário veria um erro cru em vez da tela de atualização.
  update public.system_config
     set value = value || jsonb_build_object('enforceServer', 'true', 'min', '1.0.10')
   where key = 'min_app_version' and jurisdiction = 'global';
  r := pg_temp.tentar_corrida('authenticated', '1.0.0');
  if r <> 'ok' then
    v_falhas := v_falhas + 1;
    raise warning 'FALHOU enforceServer como string deveria falhar ABERTO: %', r;
  end if;

  -- 4. Sem a linha de config: falha aberto.
  update public.system_config
     set value = value - 'enforceServer'
   where key = 'min_app_version' and jurisdiction = 'global';
  r := pg_temp.tentar_corrida('authenticated', '1.0.0');
  if r <> 'ok' then
    v_falhas := v_falhas + 1;
    raise warning 'FALHOU config sem enforceServer deveria falhar ABERTO: %', r;
  end if;

  if v_falhas > 0 then
    raise exception 'trava de versão: % caso(s) fora do esperado', v_falhas;
  end if;

  raise notice 'trava de versão: 14/14 casos como esperado (bloqueios conferidos por GOXL_UPDATE_REQUIRED).';
end $$;

-- ─── Limpeza: o 99 confere o estado final ────────────────────────────────────
delete from public.rides
 where passenger_id = '11111111-1111-1111-1111-111111111111';
delete from public.profiles
 where id = '11111111-1111-1111-1111-111111111111';

-- Devolve a config ao estado INERTE em que a 0081 a semeou.
update public.system_config
   set value = value || jsonb_build_object('enforceServer', false, 'min', '0.0.0')
 where key = 'min_app_version' and jurisdiction = 'global';

do $$
begin
  if (select value->>'min' from public.system_config
       where key = 'min_app_version' and jurisdiction = 'global') <> '0.0.0'
     or (select (value->>'enforceServer')::boolean from public.system_config
          where key = 'min_app_version' and jurisdiction = 'global') is not false then
    raise exception 'o teste da trava não devolveu a config ao estado inerte';
  end if;
end $$;
