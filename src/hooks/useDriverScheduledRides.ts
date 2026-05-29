import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import type { RideRecord } from '../types';

export function useDriverScheduledRides(driverId: string | undefined) {
  const [available, setAvailable] = useState<RideRecord[]>([]);   // sem motorista
  const [claimed, setClaimed] = useState<RideRecord[]>([]);       // confirmadas por mim
  const [loading, setLoading] = useState(true);
  const channelId = useRef(Math.random().toString(36).slice(2)).current;

  const refresh = useCallback(async () => {
    if (!driverId) return;
    setLoading(true);

    const [{ data: avail }, { data: mine }] = await Promise.all([
      supabase
        .from('rides')
        .select('*')
        .eq('status', 'scheduled')
        .is('driver_id', null)
        .order('scheduled_for', { ascending: true }),
      supabase
        .from('rides')
        .select('*')
        .eq('status', 'scheduled')
        .eq('driver_id', driverId)
        .order('scheduled_for', { ascending: true }),
    ]);

    setAvailable((avail as RideRecord[]) ?? []);
    setClaimed((mine as RideRecord[]) ?? []);
    setLoading(false);
  }, [driverId]);

  useEffect(() => { refresh(); }, [refresh]);

  // Atualiza quando corridas agendadas mudam (nova disponível ou alguém confirmou)
  useEffect(() => {
    if (!driverId) return;
    const channel = supabase
      .channel(`driver-sched-${driverId}-${channelId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rides', filter: `status=eq.scheduled` }, () => {
        refresh();
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [driverId, refresh]);

  return { available, claimed, loading, refresh };
}
