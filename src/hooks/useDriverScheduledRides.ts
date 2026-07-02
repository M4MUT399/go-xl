import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { sendPushAsync } from '../lib/notifications';
import { getConfig } from '../lib/systemConfig';
import type { RideRecord } from '../types';

// ─── Notificações ─────────────────────────────────────────────────────────────

async function notifyPassengerDriverReleased(passengerId: string, rideId: string) {
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

/** Notifica o passageiro que o horário do agendamento passou sem aceite de motorista. */
async function notifyPassengerScheduleExpired(passengerId: string, rideId: string) {
  const { data } = await supabase
    .from('profiles')
    .select('push_token')
    .eq('id', passengerId)
    .single();

  const token = (data as { push_token: string | null } | null)?.push_token;
  if (token) {
    await sendPushAsync([{
      to: token,
      title: '⏰ Agendamento não confirmado',
      body: 'Nenhum motorista aceitou seu agendamento a tempo. Solicite uma nova corrida.',
      data: { type: 'schedule_expired', rideId },
    }]);
  }

  // Broadcast direto — funciona sem push token (passageiro com app aberto)
  const ch = supabase.channel(`pax-notify-${passengerId}`);
  await new Promise<void>((resolve) => {
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        ch.send({ type: 'broadcast', event: 'schedule_expired', payload: { rideId } })
          .then(() => { supabase.removeChannel(ch); resolve(); })
          .catch(() => { supabase.removeChannel(ch); resolve(); });
      }
    });
    setTimeout(() => { supabase.removeChannel(ch); resolve(); }, 5000);
  });
}

/**
 * Cancela rides agendadas que já passaram do horário sem ter motorista.
 * Notifica cada passageiro afetado.
 * Idempotente — pode ser chamada com frequência sem efeitos colaterais.
 */
async function expireOldScheduledRides() {
  const now = new Date().toISOString();

  const { data: expired } = await supabase
    .from('rides')
    .select('id, passenger_id')
    .eq('status', 'scheduled')
    .is('driver_id', null)
    .lt('scheduled_for', now);

  if (!expired || expired.length === 0) return;

  const rides = expired as { id: string; passenger_id: string }[];
  const ids = rides.map((r) => r.id);

  // Cancela em batch — condição dupla garante idempotência
  await supabase
    .from('rides')
    .update({ status: 'cancelled' })
    .in('id', ids)
    .eq('status', 'scheduled')
    .is('driver_id', null)
    .lt('scheduled_for', now);

  // Notifica cada passageiro (fire-and-forget)
  for (const ride of rides) {
    notifyPassengerScheduleExpired(ride.passenger_id, ride.id);
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useDriverScheduledRides(driverId: string | undefined) {
  const [available, setAvailable] = useState<RideRecord[]>([]);   // sem motorista, dentro da janela
  const [claimed, setClaimed] = useState<RideRecord[]>([]);       // confirmadas por mim
  const [loading, setLoading] = useState(true);
  const channelId = useRef(Math.random().toString(36).slice(2)).current;

  const refresh = useCallback(async () => {
    if (!driverId) return;
    setLoading(true);

    // 1) Expira rides vencidos antes de atualizar a lista
    await expireOldScheduledRides();

    // Antecedência dinâmica (min) — configurável por jurisdição, fallback 60.
    const leadMinutes = await getConfig('scheduled_ride_lead_minutes');
    const now = new Date();
    const windowEnd = new Date(now.getTime() + leadMinutes * 60_000);

    const [{ data: avail }, { data: mine }] = await Promise.all([
      supabase
        .from('rides')
        .select('*')
        .eq('status', 'scheduled')
        .is('driver_id', null)
        // Janela dinâmica: já passou? não mostra. Além da antecedência? também não.
        .gte('scheduled_for', now.toISOString())
        .lte('scheduled_for', windowEnd.toISOString())
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

  // Verifica expiração a cada 60s — garante que rides que vencem enquanto a tela está aberta desapareçam
  useEffect(() => {
    const interval = setInterval(() => { refresh(); }, 60_000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Realtime — recarrega quando qualquer ride agendada muda
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
