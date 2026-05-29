import { useState, useEffect } from 'react';
import { getRoute, RouteResult } from '../lib/routing';

export function useRoute(
  origin: { lat: number; lng: number } | null | undefined,
  dest: { lat: number; lng: number } | null | undefined
) {
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!origin || !dest) {
      setRoute(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    getRoute(origin, dest).then((r) => {
      if (!cancelled) {
        setRoute(r);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [origin?.lat, origin?.lng, dest?.lat, dest?.lng]);

  return { route, loading };
}
