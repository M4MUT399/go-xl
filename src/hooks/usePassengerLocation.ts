// usePassengerLocation — posição ao vivo do PASSAGEIRO até o embarque (0090).
//
// Pedido do Edson (26/10/2026), com o print da Uber como referência: os dois
// lados se veem se mexendo no mapa até o embarque. O carro já aparecia para o
// passageiro (rides.driver_lat/lng); aqui mora o inverso.
//
//   • usePublishPassengerLocation — app do PASSAGEIRO. Observa o GPS e grava
//     rides.passenger_lat/lng/location_at enquanto `active` (accepted /
//     driver_en_route). Para sozinho no embarque: depois disso o passageiro
//     está dentro do carro e a posição dele é a do motorista.
//   • usePassengerLiveLocation — app do MOTORISTA. Lê essa posição da corrida
//     (poll curto, mesmo padrão de backstop do resto do app) e descarta fix
//     velho: um ponto de 10 min atrás na calçada errada atrapalha mais do que
//     o pino do endereço.

import { useEffect, useRef, useState } from 'react';
import * as Location from 'expo-location';
import { supabase } from '../lib/supabase';
import { shouldPublishFix, type PublishGateConfig, type PublishMark } from '../lib/nav/publishGate';

export interface LiveLatLng {
  lat: number;
  lng: number;
}

/** Cadência do passageiro: anda a pé, então distância curta e heartbeat folgado. */
const PASSENGER_PUBLISH_GATE: PublishGateConfig = {
  minIntervalMs: 3000,
  maxIntervalMs: 20_000,
  minDistanceM: 8,
};

/** Posição do passageiro mais velha que isto não é desenhada para o motorista. */
export const PASSENGER_LOCATION_MAX_AGE_MS = 3 * 60_000;

/** Statuses em que o passageiro está esperando o carro. */
export const PASSENGER_PUBLISH_STATUSES = ['accepted', 'driver_en_route'] as const;

export function usePublishPassengerLocation(rideId: string | undefined, active: boolean): LiveLatLng | null {
  const [me, setMe] = useState<LiveLatLng | null>(null);
  const lastRef = useRef<PublishMark | null>(null);

  useEffect(() => {
    if (!rideId || !active) return;
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;
    lastRef.current = null;

    (async () => {
      try {
        const perm = await Location.getForegroundPermissionsAsync();
        if (perm.status !== 'granted' || cancelled) return;
        sub = await Location.watchPositionAsync(
          { accuracy: Location.Accuracy.High, timeInterval: 3000, distanceInterval: 5 },
          (fix) => {
            const next = { lat: fix.coords.latitude, lng: fix.coords.longitude };
            setMe(next);
            const now = Date.now();
            if (!shouldPublishFix(lastRef.current, next, now, PASSENGER_PUBLISH_GATE)) return;
            lastRef.current = { ...next, atMs: now };
            supabase
              .from('rides')
              .update({
                passenger_lat: next.lat,
                passenger_lng: next.lng,
                passenger_location_at: new Date(now).toISOString(),
              })
              .eq('id', rideId)
              .then(({ error }) => {
                // Falhou: deixa o próximo fix tentar de novo em vez de esperar o heartbeat.
                if (error) lastRef.current = null;
              });
          },
        );
        if (cancelled) sub.remove();
      } catch {
        // best-effort — sem GPS o motorista segue vendo o pino do endereço
      }
    })();

    return () => {
      cancelled = true;
      sub?.remove();
    };
  }, [rideId, active]);

  return active ? me : null;
}

export function usePassengerLiveLocation(rideId: string | undefined, enabled: boolean): LiveLatLng | null {
  const [pos, setPos] = useState<LiveLatLng | null>(null);

  useEffect(() => {
    if (!rideId || !enabled) {
      setPos(null);
      return;
    }
    let alive = true;
    const read = async () => {
      const { data, error } = await supabase
        .from('rides')
        .select('passenger_lat,passenger_lng,passenger_location_at')
        .eq('id', rideId)
        .maybeSingle();
      if (!alive || error) return;
      const at = data?.passenger_location_at ? Date.parse(data.passenger_location_at) : NaN;
      const fresh = Number.isFinite(at) && Date.now() - at <= PASSENGER_LOCATION_MAX_AGE_MS;
      if (fresh && data?.passenger_lat != null && data?.passenger_lng != null) {
        setPos({ lat: data.passenger_lat, lng: data.passenger_lng });
      } else {
        setPos(null);
      }
    };
    read();
    const interval = setInterval(read, 4000);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [rideId, enabled]);

  return pos;
}
