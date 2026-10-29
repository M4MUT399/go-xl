-- ═════════════════════════════════════════════════════════════════════════════
-- 0074 — aceitar corrida passa a exigir SER motorista na própria regra
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Hoje um passageiro NÃO consegue aceitar corrida alheia. Este arquivo não
-- conserta um buraco aberto: conserta o MOTIVO de ele estar fechado.
--
-- A policy de UPDATE de `rides` libera, entre outros ramos:
--
--     (status = 'requesting' and driver_id is null)
--
-- sem exigir nada de quem está atualizando. Lida sozinha, ela deixa qualquer
-- conta logada assumir qualquer corrida do pool. O que segura isso é um efeito
-- colateral do Postgres: um UPDATE com WHERE precisa LOCALIZAR a linha, e para
-- isso as policies de SELECT se aplicam. A de SELECT do pool é
-- `"Motorista vê o pool aberto"`, que exige `is_driver()`. Passageiro não
-- enxerga a linha, logo não atualiza a linha.
--
-- Isto foi verificado nos dois sentidos, executando:
--
--   · Bob (passageiro) tenta `update rides set driver_id = bob, status =
--     'accepted'` — sem `returning`, que é o que o supabase-js manda por
--     padrão: 0 linhas.
--   · Acrescentando UMA policy permissiva de SELECT em `rides`, o MESMO update
--     passa a afetar 1 linha e o sequestro acontece.
--
-- Ou seja: a segurança do UPDATE está guardada dentro da regra de LEITURA.
-- Qualquer futura policy de SELECT mais larga em `rides` — um painel de
-- suporte, uma tela de histórico, um relatório — reabre o sequestro à
-- distância, num arquivo que não fala de aceite e cujo autor não terá motivo
-- para desconfiar. Nada no repositório avisaria.
--
-- É o mesmo defeito de forma da 0067 (`{public}` funcionava porque
-- `auth.uid()` é NULL para anon) e da 0073 (a escrita indevida era barrada por
-- um trigger escrito para outro fim): a regra certa pelo motivo errado. Aqui o
-- conserto custa uma chamada de função numa policy.
--
-- NÃO muda o fluxo legítimo:
--   · motorista aceitando pelo app (`useRide.ts:1762`) roda como
--     `authenticated` e `is_driver()` devolve true para ele;
--   · o dispatch-engine roda com `service_role`, que não passa por RLS;
--   · passageiro cancelando a própria corrida continua entrando pelo ramo
--     `auth.uid() = passenger_id`, que não foi tocado.
-- ═════════════════════════════════════════════════════════════════════════════

drop policy if exists "Motorista aceita corrida" on public.rides;

create policy "Motorista aceita corrida" on public.rides
  for update
  to authenticated
  using (
    (select auth.uid()) = passenger_id
    or (select auth.uid()) = driver_id
    or (status = 'requesting' and driver_id is null and is_driver())
    or (status = 'scheduled'  and driver_id is null and is_driver())
  )
  with check (
    (select auth.uid()) = passenger_id
    or (select auth.uid()) = driver_id
    or (status = 'requesting' and driver_id is null and is_driver())
    or (status = 'scheduled'  and driver_id is null and is_driver())
  );

-- A policy tem de continuar declarando o papel — é a asserção Z.1 da 0067, e
-- recriar a policy é exatamente o jeito de perder isso sem perceber.
do $$
begin
  if exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'rides'
       and policyname = 'Motorista aceita corrida'
       and 'public' = any(roles)
  ) then
    raise exception '0074 incompleta: a policy voltou para {public} — P0-11 regrediria';
  end if;

  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'rides'
       and policyname = 'Motorista aceita corrida'
       and qual like '%is_driver()%'
  ) then
    raise exception '0074 incompleta: is_driver() não entrou na regra de aceite';
  end if;
end $$;
