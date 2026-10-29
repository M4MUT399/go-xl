-- ═════════════════════════════════════════════════════════════════════════════
-- 0072 — public.rides_with_locations: reconstruir a view que a 0012 não conseguiu
-- ═════════════════════════════════════════════════════════════════════════════
--
-- POR QUE UMA MIGRATION NOVA E NÃO UM CONSERTO NA 0012
--
-- A 0012 já foi aplicada em produção, e o Supabase rastreia migration por nome:
-- editá-la não a faz rodar de novo. Só um arquivo novo muda o banco.
--
-- O QUE A 0012 TENTOU E POR QUE FALHOU
--
-- Ela usa `create or replace view` para re-expandir o `r.*` e passar a incluir
-- as colunas que a 0011 tinha acabado de adicionar. Não funciona: `create or
-- replace view` só consegue APENDAR colunas ao fim da lista. As colunas novas
-- de `rides` entram no MEIO — antes de `origin` e `destination`, que a view
-- acrescenta no fim — e o Postgres recusa a substituição. A 0012 aborta e
-- deixa a view exatamente como estava.
--
-- Isso não é leitura de SQL, é execução com controle, num Postgres 17.10 local:
--
--   rodada 1 (estado do repositório) → view com 20 colunas, sem driver_amount
--   rodada 2 (única mudança: drop + create) → 43 colunas, com driver_amount
--
-- E tem testemunha independente dentro do próprio app. O comentário em
-- src/screens/passenger/ActiveRideScreen.tsx:243-249 explica que aquela tela lê
-- a TABELA `rides` e não esta view, justamente porque a view não traz
-- driver_lat/lng/eta. Ou seja: a falha aconteceu em produção, foi contornada no
-- cliente, e a causa nunca foi identificada. Está identificada agora.
--
-- 23 colunas de `rides` estavam de fora, entre elas driver_amount, platform_fee,
-- payout_id, tip_amount, route_polyline e cancellation_reason.
--
-- ── SOBRE O `drop`: DE PROPÓSITO SEM `cascade` ───────────────────────────────
--
-- No banco local, `pg_depend` não acusa NENHUM objeto dependente desta view, e
-- nenhum arquivo do repositório a consulta (nenhum `from('rides_with_locations')`
-- em src/ nem em supabase/functions/). Mas o banco local é um dublê: não sabe de
-- objetos que alguém tenha criado pelo painel do Supabase.
--
-- Por isso `drop view` puro. Se existir em produção um dependente que este
-- repositório não conhece, esta migration FALHA e mostra o nome dele, dentro de
-- uma transação que reverte inteira. `cascade` faria o oposto: destruiria esse
-- objeto em silêncio. Falhar alto é recuperável; apagar em silêncio não é.

drop view if exists public.rides_with_locations;

create view public.rides_with_locations as
select
  r.*,
  json_build_object('lat', r.origin_lat, 'lng', r.origin_lng, 'address', r.origin_address) as origin,
  json_build_object('lat', r.destination_lat, 'lng', r.destination_lng, 'address', r.destination_address) as destination
from public.rides r;

-- A view NASCE de novo, então nasce sem o que a 0036 tinha configurado. Sem esta
-- linha, a view voltaria a rodar com os privilégios do owner e contornaria a RLS
-- de `rides` — reintroduzindo exatamente o defeito que a 0036 existe para
-- consertar. Recriar uma view é apagar as propriedades dela junto.
alter view public.rides_with_locations set (security_invoker = on);

-- Mesmo raciocínio para os grants, e aqui a recriação é uma oportunidade: o
-- privilege default do schema `public` fazia todo objeto novo nascer legível por
-- `anon` (a causa raiz que a 0067 documenta na seção PROVA, P0.b). `anon` não
-- tem por que enxergar corridas, e nada no repositório depende disso.
revoke all on public.rides_with_locations from anon;
grant select on public.rides_with_locations to authenticated, service_role;

-- ── Asserção — o arquivo prova o que promete, ou aborta ─────────────────────
do $$
declare
  v_faltando text;
  v_opts     text[];
begin
  select string_agg(c.column_name, ', ')
    into v_faltando
    from information_schema.columns c
   where c.table_schema = 'public'
     and c.table_name = 'rides'
     and c.column_name not in (
       select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'rides_with_locations'
     );

  if v_faltando is not null then
    raise exception '0072 incompleta: rides_with_locations ainda não expõe: %', v_faltando;
  end if;

  select c.reloptions into v_opts
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'rides_with_locations';

  if v_opts is null or not ('security_invoker=on' = any(v_opts)) then
    raise exception '0072 incompleta: a view perdeu security_invoker e passaria por cima da RLS de rides';
  end if;

  raise notice '0072: view reconstruída, todas as colunas de rides expostas, security_invoker ligado.';
end $$;
