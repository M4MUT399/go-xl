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

      // Descobre se o motorista JÁ tem veículo — inclusive quando o estado local
      // ainda não carregou. Sem isso, um save com `vehicle` nulo por corrida de
      // carregamento criaria uma 2ª linha para o mesmo motorista (duplicidade).
      let existingId = vehicle?.id;
      if (!existingId) {
        const { data: existing } = await supabase
          .from('vehicles')
          .select('id')
          .eq('driver_id', driverId)
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle();
        existingId = (existing as { id: string } | null)?.id;
      }

      const { data, error } = existingId
        ? await supabase.from('vehicles').update(payload).eq('id', existingId).select().single()
        : await supabase.from('vehicles').insert(payload).select().single();

      if (error) {
        // 23505 = unique_violation (índice vehicles_driver_plate_unique): o mesmo
        // motorista tentou cadastrar a MESMA placa de novo. Sinaliza p/ a tela.
        const dup = error.code === '23505' || /duplicate|unique/i.test(error.message);
        return { error: dup ? 'DUPLICATE' : error.message };
      }
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
