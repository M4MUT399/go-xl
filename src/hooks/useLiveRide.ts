// useLiveRide — a corrida da tela de navegação do MOTORISTA, viva.
//
// A DriverNavigateScreen recebia a corrida por `route.params` e nunca mais a
// relia: o que mudasse no banco durante a viagem não chegava à tela. Desde
// 29/10/2026 o passageiro pode mudar destino e incluir paradas em curso
// (update-ride-route), e a espera no embarque depende de `driver_arrived_at` —
// então os campos que mudam durante a corrida são relidos a cada 4 s e
// mesclados por cima do objeto inicial. Só gera um objeto novo quando algum
// campo de fato mudou, para não re-renderizar a tela de navegação à toa.

import { useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { Ride } from '../types';

const LIVE_FIELDS = [
  'status', 'price', 'distance_km', 'duration_min',
  'destination_lat', 'destination_lng', 'destination_address',
  'stops', 'route_change_count', 'driver_arrived_at', 'boarded_at',
  'wait_fee_amount', 'wait_fee_minutes',
] as const;

export function useLiveRide(initial: Ride, enabled = true): Ride {
  const [ride, setRide] = useState<Ride>(initial);
  const rideRef = useRef(ride);
  rideRef.current = ride;

  useEffect(() => {
    if (!enabled || !initial.id) return;
    let alive = true;
    const read = async () => {
      const { data, error } = await supabase
        .from('rides')
        .select(LIVE_FIELDS.join(','))
        .eq('id', initial.id)
        .maybeSingle();
      if (!alive || error || !data) return;
      const row = data as unknown as Record<string, unknown>;
      const cur = rideRef.current as unknown as Record<string, unknown>;
      const changed = LIVE_FIELDS.some((k) => JSON.stringify(row[k] ?? null) !== JSON.stringify(cur[k] ?? null));
      if (changed) setRide((prev) => ({ ...prev, ...(row as Partial<Ride>) }));
    };
    read();
    const interval = setInterval(read, 4000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [initial.id, enabled]);

  return ride;
}

/** Paradas da corrida (0091), já normalizadas. */
export interface RideStop {
  lat: number;
  lng: number;
  address?: string;
  done_at?: string | null;
}

export function rideStops(ride: Pick<Ride, 'stops'>): RideStop[] {
  const raw = (ride as { stops?: unknown }).stops;
  return Array.isArray(raw)
    ? (raw as RideStop[]).filter((s) => Number.isFinite(s?.lat) && Number.isFinite(s?.lng))
    : [];
}

/** Índice da próxima parada ainda não feita, ou -1. */
export function nextStopIndex(ride: Pick<Ride, 'stops'>): number {
  return rideStops(ride).findIndex((s) => !s.done_at);
}
