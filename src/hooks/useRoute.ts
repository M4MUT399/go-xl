import { useState, useEffect } from 'react';
import { getRoute, getRouteViaDirections, RouteResult } from '../lib/routing';
import { useFeatureFlag } from './useFeatureFlag';

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

  useEffect(() => {
    if (!origin || !dest) {
      setRoute(null);
      return;
    }
    let cancelled = false;
    setLoading(true);

    (async () => {
      let result: RouteResult | null = null;
      if (directionsV2) {
        result = await getRouteViaDirections(origin, dest);
      }
      // Fallback seguro: sem a flag, ou se a Google falhar/não retornar rota.
      if (!result) {
        result = await getRoute(origin, dest);
      }
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
