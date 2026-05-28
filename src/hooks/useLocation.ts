import { useState, useEffect } from 'react';
import * as ExpoLocation from 'expo-location';
import type { Coordinates } from '../types';

export function useLocation() {
  const [location, setLocation] = useState<Coordinates | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { status } = await ExpoLocation.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        setErrorMsg('Permissão de localização negada');
        setLoading(false);
        return;
      }

      const loc = await ExpoLocation.getCurrentPositionAsync({
        accuracy: ExpoLocation.Accuracy.High,
      });

      setLocation({ lat: loc.coords.latitude, lng: loc.coords.longitude });
      setLoading(false);
    })();
  }, []);

  async function refreshLocation(): Promise<Coordinates | null> {
    const loc = await ExpoLocation.getCurrentPositionAsync({
      accuracy: ExpoLocation.Accuracy.High,
    });
    const coords = { lat: loc.coords.latitude, lng: loc.coords.longitude };
    setLocation(coords);
    return coords;
  }

  return { location, errorMsg, loading, refreshLocation };
}
