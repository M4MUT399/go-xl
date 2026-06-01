import { useState, useEffect, useCallback, useRef } from 'react';
import * as ExpoLocation from 'expo-location';
import type { Coordinates } from '../types';

export type LocationStatus = 'loading' | 'ready' | 'denied' | 'error';

interface UseLocationOptions {
  /** Quando true, inicia watchPositionAsync e atualiza a posição continuamente. */
  watch?: boolean;
}

export function useLocation(options?: UseLocationOptions) {
  const watchEnabled = options?.watch ?? false;

  const [location, setLocation] = useState<Coordinates | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [status, setStatus] = useState<LocationStatus>('loading');
  const watchRef = useRef<ExpoLocation.LocationSubscription | null>(null);

  const load = useCallback(async () => {
    setStatus('loading');
    setErrorMsg(null);
    try {
      const { status: perm } = await ExpoLocation.requestForegroundPermissionsAsync();
      if (perm !== 'granted') {
        setErrorMsg('Permissão de localização negada');
        setStatus('denied');
        return;
      }

      // 1) Posição em cache SÓ se for recente (<60s) e precisa (<100m)
      try {
        const last = await ExpoLocation.getLastKnownPositionAsync({
          maxAge: 60000,
          requiredAccuracy: 100,
        });
        if (last) setLocation({ lat: last.coords.latitude, lng: last.coords.longitude });
      } catch {
        // ignora — segue para a posição precisa
      }

      // 2) Posição precisa única (ponto de partida)
      const loc = await ExpoLocation.getCurrentPositionAsync({
        accuracy: ExpoLocation.Accuracy.High,
      });
      setLocation({ lat: loc.coords.latitude, lng: loc.coords.longitude });
      setStatus('ready');
    } catch {
      setErrorMsg('Não foi possível obter sua localização');
      setStatus((prev) => (prev === 'loading' ? 'error' : prev));
    }
  }, []);

  // Carrega posição inicial ao montar
  useEffect(() => {
    let mounted = true;
    (async () => {
      if (mounted) await load();
    })();
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Inicia/para watchPositionAsync conforme watchEnabled
  useEffect(() => {
    if (!watchEnabled) return;

    let active = true;
    ExpoLocation.requestForegroundPermissionsAsync().then(({ status: perm }) => {
      if (perm !== 'granted' || !active) return;

      ExpoLocation.watchPositionAsync(
        {
          accuracy: ExpoLocation.Accuracy.High,
          distanceInterval: 15,   // atualiza ao mover ≥15 m
          timeInterval: 5000,     // ou a cada 5 s (o que vier primeiro)
        },
        (pos) => {
          setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude });
          setStatus('ready');
        }
      ).then((sub) => {
        if (active) {
          watchRef.current = sub;
        } else {
          sub.remove();
        }
      });
    });

    return () => {
      active = false;
      watchRef.current?.remove();
      watchRef.current = null;
    };
  }, [watchEnabled]);

  async function refreshLocation(): Promise<Coordinates | null> {
    try {
      const loc = await ExpoLocation.getCurrentPositionAsync({
        accuracy: ExpoLocation.Accuracy.High,
      });
      const coords = { lat: loc.coords.latitude, lng: loc.coords.longitude };
      setLocation(coords);
      return coords;
    } catch {
      return null;
    }
  }

  const loading = status === 'loading';

  return { location, errorMsg, status, loading, refreshLocation, retry: load };
}
