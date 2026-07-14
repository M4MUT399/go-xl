import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { broadcastRideRevoked } from './useRide';
import type { RideRecord } from '../types';

// ─── Notificações ─────────────────────────────────────────────────────────────

/**
 * Chama a Edge Function `send-ride-push` (mesmo mecanismo de useRide.ts) — o
 * push de corrida não lê mais push_token no client nem manda título/corpo
 * livre, só `kind` + `rideId`. Best-effort: falhas são engolidas.
 */
async function invokeRidePush(kind: string, rideId: string): Promise<void> {
  try {
    await supabase.functions.invoke('send-ride-push', { body: { kind, rideId } });
  } catch {
    // push é best-effort — nunca deve derrubar o fluxo de corrida
  }
}

async function notifyPassengerDriverReleased(passengerId: string, rideId: string) {
  await invokeRidePush('driver_released', rideId);

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
  await invokeRidePush('schedule_expired', rideId);

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

  // Notifica cada passageiro (fire-and-forget) e revoga a oferta para TODOS os
  // motoristas — mesmo mecanismo único das Tarefas 3 e 4 (ride_offer_revoked),
  // motivo 'expired': quem tiver o card do agendamento na aba "Agenda" o remove
  // na hora, sem depender do poll de 60s.
  for (const ride of rides) {
    notifyPassengerScheduleExpired(ride.passenger_id, ride.id);
    broadcastRideRevoked(ride.id, 'expired');
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

    const now = new Date();

    const [{ data: avail }, { data: mine }] = await Promise.all([
      supabase
        .from('rides')
        .select('*')
        .eq('status', 'scheduled')
        .is('driver_id', null)
        // Mostra TODOS os agendamentos futuros ainda sem motorista — o motorista
        // pode confirmar com qualquer antecedência (não apenas na última hora).
        // Sem isso, agendamentos distantes nunca apareciam para aceitar, e a
        // corrida jamais ficava confirmada para ambos.
        .gte('scheduled_for', now.toISOString())
        .order('scheduled_for', { ascending: true }),
      supabase
        .from('rides')
        .select('*')
        .eq('status', 'scheduled')
        .eq('driver_id', driverId)
        // Exclui agendamentos travados por QR que ainda aguardam a decisão do
        // motorista (accepted_at IS NULL) — esses só devem aparecer no popup
        // de aceitar/recusar (DriverHomeScreen), não em "Minhas corridas" como
        // se já estivessem confirmados. Ver confirmQrScheduledRide/useRide.ts.
        .not('accepted_at', 'is', null)
        .order('scheduled_for', { ascending: true }),
    ]);

    const availRides = (avail as RideRecord[]) ?? [];
    const mineRides = (mine as RideRecord[]) ?? [];

    // Busca nome + foto + avaliação de todos os passageiros das duas listas de
    // uma vez só (evita N consultas por card) e anexa em cada ride — os cards da
    // aba "Agenda" precisam identificar quem solicitou a corrida.
    const passengerIds = Array.from(
      new Set([...availRides, ...mineRides].map((r) => r.passenger_id).filter(Boolean))
    );
    type PassengerInfo = { full_name: string | null; avatar_url: string | null; rating: number | null };
    let profileById = new Map<string, PassengerInfo>();
    if (passengerIds.length > 0) {
      const { data: profs } = await supabase
        .from('profiles_public')
        .select('id, full_name, avatar_url, rating')
        .in('id', passengerIds);
      profileById = new Map(
        ((profs as { id: string; full_name: string | null; avatar_url: string | null; rating: number | null }[]) ?? [])
          .map((p) => [p.id, { full_name: p.full_name, avatar_url: p.avatar_url, rating: p.rating }])
      );
    }
    const withNames = (rides: RideRecord[]) =>
      rides.map((r) => {
        const info = profileById.get(r.passenger_id);
        return {
          ...r,
          passenger_name: info?.full_name ?? null,
          passenger_avatar_url: info?.avatar_url ?? null,
          passenger_rating: info?.rating ?? null,
        };
      });

    setAvailable(withNames(availRides));
    setClaimed(withNames(mineRides));
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

  // Broadcast "corrida agendada reivindicada" (mesmo canal 'ride-offers' usado
  // por acceptRide/confirmScheduledRide/claimScheduledRide em useRide.ts) —
  // remove o card da lista de disponíveis dos DEMAIS motoristas na hora, sem
  // depender do postgres_changes acima (precisa de REPLICA IDENTITY FULL,
  // pouco confiável no Expo Go) nem do poll de 60s.
  useEffect(() => {
    if (!driverId) return;
    // Remove o card da lista de disponíveis quando a oferta é revogada por
    // QUALQUER motivo — mecanismo único das Tarefas 3 e 4 (ride_offer_revoked:
    // taken | cancelled | expired). Continua escutando o evento legado
    // `ride_taken` para builds antigas que só o emitem.
    const removeFromAvailable = (rideId: string | undefined) => {
      if (!rideId) return;
      setAvailable((prev) => prev.filter((r) => r.id !== rideId));
    };
    const ch = supabase
      .channel('ride-offers')
      .on('broadcast', { event: 'ride_offer_revoked' }, ({ payload }) => {
        removeFromAvailable(payload?.rideId as string | undefined);
      })
      .on('broadcast', { event: 'ride_taken' }, ({ payload }) => {
        removeFromAvailable(payload?.rideId as string | undefined);
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [driverId]);

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
