import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { Vehicle } from '../types';

export type VehicleInput = Omit<Vehicle, 'id' | 'driver_id'>;

export function useVehicle(driverId: string | undefined) {
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchVehicle = useCallback(async () => {
    if (!driverId) return;
    setLoading(true);
    const { data } = await supabase
      .from('vehicles')
      .select('*')
      .eq('driver_id', driverId)
      .maybeSingle();
    setVehicle((data as Vehicle) ?? null);
    setLoading(false);
  }, [driverId]);

  useEffect(() => {
    fetchVehicle();
  }, [fetchVehicle]);

  const saveVehicle = useCallback(
    async (input: VehicleInput): Promise<{ error: string | null }> => {
      if (!driverId) return { error: 'Motorista não identificado' };

      const payload = { ...input, driver_id: driverId };
      const { data, error } = vehicle
        ? await supabase.from('vehicles').update(payload).eq('id', vehicle.id).select().single()
        : await supabase.from('vehicles').insert(payload).select().single();

      if (error) return { error: error.message };
      setVehicle(data as Vehicle);
      return { error: null };
    },
    [driverId, vehicle]
  );

  return { vehicle, loading, saveVehicle, refresh: fetchVehicle };
}

export function useDriverVehicle(driverId: string | undefined) {
  const [vehicle, setVehicle] = useState<Vehicle | null>(null);

  useEffect(() => {
    if (!driverId) {
      setVehicle(null);
      return;
    }
    supabase
      .from('vehicles')
      .select('*')
      .eq('driver_id', driverId)
      .maybeSingle()
      .then(({ data }) => setVehicle((data as Vehicle) ?? null));
  }, [driverId]);

  return vehicle;
}
