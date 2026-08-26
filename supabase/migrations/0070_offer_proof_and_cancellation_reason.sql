-- Duas coisas que faltavam para promessas de dinheiro pararem de ser furadas:
--
--   1. `public.ride_push_offers` — PROVA, escrita pelo servidor, de que uma
--      corrida do leque foi oferecida a um motorista. É o que autoriza o
--      `charge-ride` a deixar um motorista cobrar uma corrida que ainda não é
--      dele, COM `dispatch_engine_v2` DESLIGADA (o estado real de produção).
--
--   2. `rides.cancellation_reason` — para a varredura de corridas cobradas e
--      abandonadas poder ENCERRAR a corrida em vez de deixá-la para sempre no
--      leque, com a tela do passageiro procurando motorista para uma viagem
--      estornada meia hora antes.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 1) ride_push_offers — POR QUE UMA TABELA NOVA
-- ─────────────────────────────────────────────────────────────────────────────
-- `charge-ride` precisa deixar um motorista cobrar uma corrida sem dono, porque
-- `acceptRide` cobra ANTES de gravar `driver_id` de propósito (useRide.ts:1624
-- cobra, :1668-1678 grava): se o cartão recusa, a corrida não é tomada. Essa
-- carve-out, sozinha, é "QUALQUER motorista cobra QUALQUER corrida aberta" — e
-- qualquer pessoa se cadastra como motorista.
--
-- A tentativa anterior de fechar isso exigia oferta viva em `ride_offers`, mas
-- só quando `dispatch_engine_v2` estivesse ligada. A flag tem default false
-- (src/lib/systemConfig.ts:172) e nenhuma migration a liga — 0054:5 diz
-- textualmente que nada escreve nas tabelas do motor enquanto ela estiver OFF.
-- Resultado: a exigência nunca rodava.
--
-- Por que NÃO dá para reusar `ride_offer_events` (0023): a policy de insert dela
-- é `with check (auth.uid() = driver_id)` — o PRÓPRIO MOTORISTA escreve. Usá-la
-- como prova de autorização seria deixar o atacante assinar o próprio
-- salvo-conduto. Esta tabela aqui não tem policy de insert para `authenticated`:
-- só o `send-ride-push` (service_role), depois de já ter verificado que quem
-- chamou é o PASSAGEIRO da corrida.
--
-- ⚠️ ESTA TABELA NÃO AUTORIZA MAIS NADA — E A TRAVA DE ORDEM SUMIU COM ISSO.
--
-- Ela chegou a ser a prova exigida pelo `charge-ride`, e esse desenho durou uma
-- rodada. Dois defeitos, ambos reais: a lista de ofertados vinha do CLIENTE
-- (todo motorista `is_online` ganhava direito de cobrança off-session naquele
-- cartão por 2 h), e o conjunto que via o card pelo realtime não era o mesmo
-- conjunto provado — corrida pedida sem ninguém online nascia com ZERO linhas e
-- todo aceite posterior levava 403 para sempre.
--
-- Hoje a autorização é derivada no `charge-ride` no instante do aceite, sobre
-- fatos que o motorista não escreve, e a exclusividade vem de uma reserva
-- atômica (_shared/chargeAuth.ts). Estas linhas respondem "para quem o telefone
-- tocou?" — pergunta de AUDITORIA. Consequência prática: aplicar esta migration
-- fora de ordem não recusa aceite nenhum; no máximo a auditoria fica vazia até
-- ela entrar.

-- Mesmo motivo da 0066/0068 e PRIMEIRA instrução do arquivo: `set` de sessão
-- (sem `local`) cobre todas as instruções abaixo em qualquer modo de aplicação —
-- `supabase db push`, `psql -f` e o editor SQL do painel. O `alter table` de
-- `rides` mais abaixo pega ACCESS EXCLUSIVE: sem timeout, uma corrida em
-- andamento segurando a tabela põe a migração numa fila que bloqueia TODA
-- leitura/escrita de `rides` atrás dela.
set lock_timeout = '3s';

create table if not exists public.ride_push_offers (
  ride_id    uuid        not null references public.rides(id)    on delete cascade,
  driver_id  uuid        not null references public.profiles(id) on delete cascade,
  offered_at timestamptz not null default now(),

  -- Chave composta em vez de `id` sintético + índice único: a linha É o par.
  -- Serve de índice para a consulta do charge-ride, que filtra pelos dois.
  primary key (ride_id, driver_id)
);

-- Retenção/limpeza olham por data; a consulta de autorização também compara
-- `offered_at` contra um corte.
create index if not exists ride_push_offers_offered_at_idx
  on public.ride_push_offers (offered_at);

alter table public.ride_push_offers enable row level security;

-- Leitura: o próprio motorista vê o que lhe foi oferecido; admins veem tudo.
-- Deliberadamente NÃO existe policy de INSERT/UPDATE/DELETE para `authenticated`.
-- Com RLS ligada e sem policy, a operação é NEGADA — que é o ponto inteiro desta
-- tabela: se o motorista pudesse escrever aqui, a prova não provaria nada.
drop policy if exists ride_push_offers_select_own_or_admin on public.ride_push_offers;
create policy ride_push_offers_select_own_or_admin
  on public.ride_push_offers for select
  to authenticated
  using (
    auth.uid() = driver_id
    or exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.is_admin = true
    )
  );

-- Escrita apenas pelo servidor (send-ride-push, service_role). Explícita mesmo
-- sendo redundante — service_role já ignora RLS — para o arquivo declarar quem é
-- o único escritor pretendido.
drop policy if exists ride_push_offers_service_all on public.ride_push_offers;
create policy ride_push_offers_service_all
  on public.ride_push_offers for all
  to service_role
  using (true)
  with check (true);

-- ─────────────────────────────────────────────────────────────────────────────
-- 2) rides.cancellation_reason
-- ─────────────────────────────────────────────────────────────────────────────
-- A varredura (`sweep-stale-requesting`) deixava `status` intacto e chamava isso
-- de estado consistente. Não era: a corrida ficava `requesting` + `paid = false`
-- + `driver_id` nulo, ou seja, no leque para sempre, com o app do passageiro
-- mostrando "procurando motorista" para uma viagem estornada 30 min antes —
-- nada re-notifica motoristas (`notifyOnlineDrivers` só dispara na solicitação
-- e na ativação).
--
-- Agora a varredura encerra a corrida como 'cancelled' DENTRO da mesma reserva
-- condicional que libera o estorno, e marca a autoria aqui. Marcar a autoria não
-- é enfeite: é o que permite a compensação desfazer APENAS o cancelamento que
-- ela mesma fez, se o estorno não se concretizar.
--
-- Texto livre, sem CHECK, de propósito: os cancelamentos existentes do app
-- (useRide.ts:777 e :962) gravam só `status = 'cancelled'` e continuam válidos
-- com a coluna nula. Um CHECK com uma lista fechada transformaria qualquer
-- motivo novo numa migração — e o primeiro valor a existir é o desta varredura.
alter table public.rides
  add column if not exists cancellation_reason text;

comment on column public.rides.cancellation_reason is
  'Autoria/motivo do cancelamento quando ele NÃO foi um toque do usuário. '
  'Valor conhecido: ''stale_requesting_sweep'' (sweep-stale-requesting encerrou e '
  'estornou uma corrida cobrada e abandonada). Nulo nos cancelamentos manuais.';

-- Índice parcial para a compensação da varredura, que filtra por `status`
-- 'cancelled' + este motivo. No caso normal tem ZERO linha.
create index if not exists rides_sweep_cancelled_idx
  on public.rides (cancellation_reason)
  where cancellation_reason is not null;
