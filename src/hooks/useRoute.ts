import { useState, useEffect, useRef } from 'react';
import { getRoute, getRouteViaDirections, RouteResult } from '../lib/routing';
import { useFeatureFlag } from './useFeatureFlag';
import { startTiming } from '../lib/fieldMetrics';

export function useRoute(
  origin: { lat: number; lng: number } | null | undefined,
  dest: { lat: number; lng: number } | null | undefined,
  // Fase 2 (B3): mudar este valor força um RECÁLCULO da rota mesmo sem mudança
  // de origem/destino — usado para a cadência periódica (~45 s) que renova o
  // ETA com trânsito. `undefined` = comportamento legado (só recalcula quando
  // origin/dest mudam).
  refreshKey?: number
) {
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [loading, setLoading] = useState(false);
  // Fase 1: com a flag LIGADA, tenta a Google Directions (ETA com trânsito +
  // geometria por-step) e cai no OSRM se ela falhar. DESLIGADA → OSRM direto
  // (comportamento legado). Rollout por jurisdição após QA.
  const directionsV2 = useFeatureFlag('directions_v2');

  // Só para rotular a métrica: o que fez ESTE cálculo acontecer. Um desvio de
  // rota chega aqui como `origin_change` (DriverNavigateScreen chama
  // setRouteOrigin ao detectar off-route), e é assim que a régua de reroute
  // consegue ser lida sem um caminho de código separado.
  const anterior = useRef<{ key: string; refreshKey?: number } | null>(null);

  useEffect(() => {
    if (!origin || !dest) {
      setRoute(null);
      return;
    }
    let cancelled = false;
    setLoading(true);

    const key = `${origin.lat},${origin.lng}|${dest.lat},${dest.lng}`;
    const prev = anterior.current;
    const trigger = !prev
      ? 'initial'
      : prev.key !== key
        ? 'origin_change'
        : prev.refreshKey !== refreshKey
          ? 'refresh'
          : 'remount';
    anterior.current = { key, refreshKey };

    (async () => {
      // Cronômetro do que o MOTORISTA espera, não de uma chamada isolada: a
      // tentativa na Google e a queda no OSRM são uma espera só.
      const fim = startTiming('route_compute');
      let result: RouteResult | null = null;
      let fellBack = false;
      if (directionsV2) {
        result = await getRouteViaDirections(origin, dest);
      }
      // Fallback seguro: sem a flag, ou se a Google falhar/não retornar rota.
      if (!result) {
        fellBack = directionsV2;
        result = await getRoute(origin, dest);
      }
      // Registrada mesmo com `cancelled`: a espera aconteceu de verdade, e
      // descartá-la tiraria da série justamente os cálculos mais lentos, que
      // são os que o usuário abandona.
      fim({ trigger, fellBack, got: !!result });
      if (!cancelled) {
        setRoute(result);
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [origin?.lat, origin?.lng, dest?.lat, dest?.lng, directionsV2, refreshKey]);

  return { route, loading };
}
