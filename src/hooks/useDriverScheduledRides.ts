import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { sendPushAsync } from '../lib/notifications';
import type { RideRecord } from '../types';

async function notifyPassengerDriverReleased(passengerId: string, rideId: string) {
  // Push (best-effort — precisa de EAS token)
  const { data } = await supabase
    .from('profiles')
    .select('push_token')
    .eq('id', passengerId)
    .single();

  const token = (data as { push_token: string | null } | null)?.push_token;
  if (token) {
    await sendPushAsync([{
      to: token,
      title: '⚠️ Motorista cancelou o agendamento',
      body: 'O motorista liberou sua corrida agendada. Aguarde nova confirmação ou solicite agora.',
      data: { type: 'driver_released', rideId },
    }]);
  }

  // Broadcast direto — funciona sem permissão de push
  const ch = supabase.channel(`pax-notify-${passengerId}`);
  await new Promise<void>((resolve) => {
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        ch.send({ type: 'broadcast', event: 'driver_released', payload: { rideId } })
          .then(() => { supabase.removeChannel(ch); resolve(); })
          .catch(() => { supabase.removeChannel(ch); resolve(); });
      }
    });
    setTimeout(() => { supabase.removeChannel(ch); resolve(); }, 5000);
  });
}

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

  const release = useCallback(async (rideId: string): Promise<boolean> => {
    // Fetch passenger before releasing so we can notify them
    const { data: rideData } = await supabase
      .from('rides')
      .select('passenger_id')
      .eq('id', rideId)
      .single();

    const { error } = await supabase
      .from('rides')
      .update({ driver_id: null })
      .eq('id', rideId)
      .eq('driver_id', driverId ?? '')
      .eq('status', 'scheduled');

    if (!error) {
      await refresh();
      const passengerId = (rideData as { passenger_id: string } | null)?.passenger_id;
      if (passengerId) {
        notifyPassengerDriverReleased(passengerId, rideId); // fire-and-forget
      }
    }
    return !error;
  }, [driverId, refresh]);

  return { available, claimed, loading, refresh, release };
}
