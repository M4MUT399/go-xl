-- Tarefa 6: aceite ÚNICO de corrida agendada — trava de vencedor único no BANCO.
--
-- O app já faz o aceite de forma atômica (UPDATE condicional
-- `driver_id is null AND status = 'scheduled'` + checagem de RETORNO em
-- claimScheduledRide/confirmScheduledRide). O bloqueio de linha do Postgres
-- durante o UPDATE já garante que, entre dois motoristas simultâneos, apenas o
-- primeiro encontra driver_id NULL — o segundo casa 0 linhas e recebe "corrida
-- já atribuída".
--
-- Esta migração adiciona uma GARANTIA independente do cliente: um trigger que
-- rejeita qualquer tentativa de REATRIBUIR uma corrida de um motorista para
-- OUTRO diretamente (driver_id: X -> Y, ambos não nulos e diferentes). Assim,
-- mesmo um caminho de código com bug (ou um cliente antigo) que faça UPDATE sem
-- a condição `driver_id is null` NÃO consegue "roubar" um agendamento já
-- confirmado. As transições legítimas continuam livres:
--   • NULL -> motorista  (reivindicar/aceitar)
--   • motorista -> NULL   (liberar / release)
--   • motorista -> mesmo motorista (idempotência: re-toque, gravar accepted_at)
--
-- Reatribuir de fato = liberar (X->NULL) e então outro reivindica (NULL->Y),
-- que é exatamente o fluxo de `release` + `claimScheduledRide`.

create or replace function public.enforce_single_ride_driver()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE'
     and old.driver_id is not null
     and new.driver_id is not null
     and new.driver_id <> old.driver_id then
    raise exception
      'corrida % já está atribuída ao motorista % — libere antes de reatribuir',
      old.id, old.driver_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_enforce_single_ride_driver on public.rides;

create trigger trg_enforce_single_ride_driver
  before update of driver_id on public.rides
  for each row
  execute function public.enforce_single_ride_driver();
