-- Corridas agendadas visíveis para todos os motoristas em aba dedicada.
--
-- As políticas de RLS de public.rides nunca cobriam status='scheduled' — só
-- 'requesting'. Isso não gerava erro nenhum: consultas do app filtradas por
-- RLS simplesmente voltavam vazias ({data: [], error: null}), então a aba
-- "Agenda" do motorista (useDriverScheduledRides) e o popup de agendamento no
-- pool aberto (pendingScheduledRide) já estavam com a query certa no client,
-- mas o banco descartava as linhas antes de devolver.
--
-- Mesmo padrão hoje usado para 'requesting': libera SELECT/UPDATE de corridas
-- agendadas SEM motorista (driver_id is null) para qualquer motorista
-- autenticado — ele ainda precisa confirmar explicitamente (claimScheduledRide
-- / confirmScheduledRide), que já usa UPDATE condicional (driver_id is null)
-- para garantir um único vencedor em caso de corrida entre dois motoristas.

drop policy if exists "Motorista vê corridas disponíveis e suas" on public.rides;

create policy "Motorista vê corridas disponíveis e suas" on public.rides
  for select using (
    status = 'requesting'
    or (status = 'scheduled' and driver_id is null)
    or auth.uid() = driver_id
    or auth.uid() = passenger_id
  );

drop policy if exists "Motorista aceita corrida" on public.rides;

create policy "Motorista aceita corrida" on public.rides
  for update using (
    auth.uid() = passenger_id
    or auth.uid() = driver_id
    or (status = 'requesting' and driver_id is null)
    or (status = 'scheduled' and driver_id is null)
  );
