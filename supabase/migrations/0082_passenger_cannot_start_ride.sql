-- ═════════════════════════════════════════════════════════════════════════════
-- 0082 — o PASSAGEIRO não começa a viagem
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ── O CASO REAL ────────────────────────────────────────────────────────────
--
-- 04/09/2026, 07:17. Um passageiro escreve ao motorista:
--
--   "I accidentally hit start trip lol and it looks like it canceled the trip
--    for tonight. Do I need to put it back in? It looks like it already will
--    probably bill it. I'm not sure what to do. I'm sorry."
--
-- A corrida era MCO → College Park, sexta 23:38, US$ 45,46. Ele encostou num
-- botão do próprio card do agendamento, na tela dele. O `activate` do app fazia,
-- nessa ordem: cobrava o cartão e mudava `rides.status` de 'scheduled' para
-- 'accepted'. Mudado o status, o agendamento sai da lista de agendados — foi o
-- "it canceled the trip" que ele descreveu. Um toque, sem confirmação nenhuma,
-- enquanto o botão de CANCELAR ao lado pedia confirmação em duas variantes.
--
-- ── POR QUE ISTO É REGRA DE SERVIDOR, E NÃO SÓ DE TELA ────────────────────
--
-- O botão saiu de src/screens/passenger/ScheduledRidesScreen.tsx no mesmo
-- commit. Isso conserta quem ATUALIZAR o app — e mais ninguém.
--
-- Ontem esta mesma lição custou dias: a App Store servia uma build de nove dias
-- antes e ela consultava uma coluna que uma migration havia removido. O alcance
-- de uma regra não é o HEAD, é todo binário em campo. O app do Ryan tem o botão
-- agora e vai continuar tendo até ele atualizar. Por isso a proibição mora aqui.
--
-- ── O QUE MUDA E O QUE NÃO MUDA ───────────────────────────────────────────
--
-- BARRADO: o passageiro tirar a PRÓPRIA corrida de 'scheduled' para qualquer
-- status que não seja 'cancelled'.
--
-- INTACTO, de propósito:
--   • cancelar continua sendo direito do passageiro ('scheduled' → 'cancelled');
--   • o MOTORISTA continua começando a corrida (confirmScheduledRide /
--     confirmQrScheduledRide, e o banner scheduledBanner.startRoute);
--   • agendamento sem motorista segue no leque pelas políticas de 0041 e 0074;
--   • service_role (Edge Functions), psql, migrations e jobs passam sempre;
--   • qualquer UPDATE que NÃO mexa no status (editar horário, notas) passa.
--
-- ── O QUE ISTO NÃO CONSERTA ───────────────────────────────────────────────
--
-- No app antigo o `activate` COBRA ANTES de mudar o status. Este trigger barra a
-- mudança, não a cobrança que já saiu. Num app velho, o toque acidental passa a
-- cobrar cedo uma corrida que CONTINUA AGENDADA e vai acontecer — `charge-ride`
-- é idempotente por corrida (`charge_<rideId>`), então não cobra de novo depois.
-- É um defeito de MOMENTO da cobrança, não de valor, e o agendamento sobrevive,
-- que era o prejuízo maior. Fechar também a cobrança exige mexer em
-- `charge-ride`, o caminho do dinheiro, e isso é decisão à parte.

create or replace function public.enforce_passenger_cannot_start_ride()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_papel text;
  v_uid   uuid;
begin
  -- Só interessa transição de status a partir de 'scheduled'.
  if new.status is not distinct from old.status then
    return new;
  end if;
  if old.status <> 'scheduled' then
    return new;
  end if;

  -- Só usuário do app é barrado. O papel do CHAMADOR vem de `request.jwt.claims`,
  -- que o PostgREST preenche por requisição; `current_user` aqui dentro seria o
  -- dono da função (SECURITY DEFINER), e usar isso seria o bug.
  v_papel := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role',
    ''
  );
  if v_papel <> 'authenticated' then
    return new;
  end if;

  begin
    v_uid := auth.uid();
  exception when others then
    return new;
  end;

  if v_uid is null or v_uid <> old.passenger_id then
    -- Não é o passageiro desta corrida (é o motorista, ou o pool). As políticas
    -- de 0041/0074 já decidem o que ele pode; aqui não é o lugar.
    return new;
  end if;

  -- É o passageiro. Cancelar continua sendo direito dele.
  if new.status = 'cancelled' then
    return new;
  end if;

  raise exception
    'GOXL_PASSENGER_CANNOT_START: passageiro não pode mudar a corrida agendada de scheduled para %',
    new.status
    using errcode = 'P0001',
          hint = 'Quem começa a corrida é o motorista. O passageiro pode cancelar.';
end $$;

comment on function public.enforce_passenger_cannot_start_ride() is
  'Impede o passageiro de tirar a própria corrida de status scheduled (exceto para cancelled). Existe porque o botão "start trip" do app do passageiro cobrava e destruía o agendamento num toque, e binários já instalados continuam com ele. Ver migration 0082.';

revoke all on function public.enforce_passenger_cannot_start_ride() from public, anon;

drop trigger if exists trg_passenger_cannot_start_ride on public.rides;
create trigger trg_passenger_cannot_start_ride
  before update on public.rides
  for each row
  execute function public.enforce_passenger_cannot_start_ride();

-- ─── Asserções ───────────────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_trigger
     where tgname = 'trg_passenger_cannot_start_ride'
       and tgrelid = 'public.rides'::regclass
       and not tgisinternal
  ) then
    raise exception '0082 incompleta: o trigger não ficou em rides';
  end if;

  if has_function_privilege('anon', 'public.enforce_passenger_cannot_start_ride()', 'execute') then
    raise exception '0082 incompleta: a função nova continua executável por anon';
  end if;

  raise notice '0082: passageiro não tira mais a corrida de scheduled (só cancelar).';
end $$;
