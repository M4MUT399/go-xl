import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';

export interface NearbyDriver {
  driver_id: string;
  lat: number;
  lng: number;
  heading: number | null;
}

interface DriverLocationRow {
  driver_id: string;
  lat: number;
  lng: number;
  heading: number | null;
  is_online: boolean;
}

export function useNearbyDrivers(enabled = true) {
  const [drivers, setDrivers] = useState<NearbyDriver[]>([]);

  const fetchDrivers = useCallback(async () => {
    const { data } = await supabase
      .from('driver_locations')
      .select('driver_id, lat, lng, heading')
      .eq('is_online', true);
    setDrivers((data as NearbyDriver[]) ?? []);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setDrivers([]);
      return;
    }

    fetchDrivers();

    // Polling a cada 8s — garante atualização mesmo sem realtime (REPLICA IDENTITY pode não estar ativo)
    const poll = setInterval(fetchDrivers, 8000);

    const channel = supabase
      .channel('nearby-drivers')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'driver_locations' },
        (payload) => {
          const row = (payload.new ?? payload.old) as DriverLocationRow;
          if (!row?.driver_id) return;

          // DELETE ou ficou offline → remove do mapa
          if (payload.eventType === 'DELETE' || row.is_online === false) {
            setDrivers((prev) => prev.filter((d) => d.driver_id !== row.driver_id));
            return;
          }

          // Se lat/lng não vieram (REPLICA IDENTITY não estava ativo ainda) → re-fetch completo
          if (row.lat == null || row.lng == null) {
            fetchDrivers();
            return;
          }

          // Atualiza ou adiciona com dados completos
          const next: NearbyDriver = {
            driver_id: row.driver_id,
            lat: row.lat,
            lng: row.lng,
            heading: row.heading,
          };
          setDrivers((prev) => {
            const exists = prev.some((d) => d.driver_id === row.driver_id);
            return exists
              ? prev.map((d) => (d.driver_id === row.driver_id ? next : d))
              : [...prev, next];
          });
        }
      )
      .subscribe();

    return () => {
      clearInterval(poll);
      supabase.removeChannel(channel);
    };
  }, [enabled, fetchDrivers]);

  return { drivers, refresh: fetchDrivers };
}
