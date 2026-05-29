import { useState, useEffect, useCallback } from 'react';
import * as ExpoLocation from 'expo-location';
import type { Coordinates } from '../types';

export type LocationStatus = 'loading' | 'ready' | 'denied' | 'error';

export function useLocation() {
  const [location, setLocation] = useState<Coordinates | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [status, setStatus] = useState<LocationStatus>('loading');

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

      // 1) Posição em cache SÓ se for recente (<60s) e precisa (<100m),
      // para evitar mostrar um lugar antigo (ex.: onde o celular esteve antes)
      try {
        const last = await ExpoLocation.getLastKnownPositionAsync({
          maxAge: 60000,
          requiredAccuracy: 100,
        });
        if (last) setLocation({ lat: last.coords.latitude, lng: last.coords.longitude });
      } catch {
        // ignora — segue para a posição precisa
      }

      // 2) Posição precisa (alta precisão)
      const loc = await ExpoLocation.getCurrentPositionAsync({
        accuracy: ExpoLocation.Accuracy.High,
      });
      setLocation({ lat: loc.coords.latitude, lng: loc.coords.longitude });
      setStatus('ready');
    } catch {
      setErrorMsg('Não foi possível obter sua localização');
      // se já temos uma posição em cache, mantém como pronta
      setStatus((prev) => (location ? 'ready' : 'error'));
    }
  }, [location]);

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
