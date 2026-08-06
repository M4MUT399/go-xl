-- Permite ao passageiro ver a localização do motorista durante uma corrida ativa,
-- independente do campo is_online (garante rastreamento na tela ActiveRide).
create policy "Passageiro vê localização do motorista ativo" on public.driver_locations
  for select using (
    exists (
      select 1 from public.rides r
      where r.driver_id = driver_locations.driver_id
        and r.passenger_id = auth.uid()
        and r.status in ('accepted', 'driver_en_route', 'in_progress')
    )
  );
