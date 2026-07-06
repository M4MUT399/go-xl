import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { sendPushAsync } from '../lib/notifications';
import { KM_TO_MILES, formatCurrency } from '../lib/format';
import { getSurgeInfo, applyMultiplier } from '../lib/surge';
import { calculateSplit } from '../lib/split';
import { estimateTollAmount } from '../lib/tolls';
import { estimateAirportFees } from '../lib/airportFees';
import { getRoute } from '../lib/routing';
import { logRideOfferEvent } from '../lib/rideOfferEvents';
import { canReceiveNewRideOffer } from '../lib/rideDispatch';
import { reportError } from '../lib/errorReporting';
import { withTimeout } from '../lib/withTimeout';
import type { Ride, RideStatus, Location, RideRecord } from '../types';
export type { SurgeInfo } from '../lib/surge';

const SUPABASE_URL     = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const CHARGE_RIDE_URL  = `${SUPABASE_URL}/functions/v1/charge-ride`;
const REFUND_RIDE_URL  = `${SUPABASE_URL}/functions/v1/refund-ride`;
const TIP_RIDE_URL     = `${SUPABASE_URL}/functions/v1/tip-ride`;

/** Cobra o cartão do passageiro via Edge Function (off-session). */
async function chargeRide(rideId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    // getSession e fetch NÃO têm timeout nativo — sem os withTimeout abaixo, uma
    // rede ruim deixava o aceite pendurado para sempre (tela travada no Android).
    const { data: { session } } = await withTimeout(
      supabase.auth.getSession(),
      8000,
      'Não foi possível validar sua sessão. Verifique a conexão.'
    );
    const res = await withTimeout(
      fetch(CHARGE_RIDE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token ?? ''}`,
        },
        body: JSON.stringify({ rideId }),
      }),
      20000,
      'A cobrança demorou demais. Tente novamente.'
    );
    const json = await res.json() as { success?: boolean; already_paid?: boolean; error?: string };
    if (json.success || json.already_paid) return { ok: true };
    return { ok: false, error: json.error ?? 'Pagamento recusado' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Cobra gorjeta do passageiro via Edge Function (off-session). */
export async function tipRide(rideId: string, amountCents: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(TIP_RIDE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session?.access_token ?? ''}`,
      },
      body: JSON.stringify({ rideId, amountCents }),
    });
    const json = await res.json() as { success?: boolean; already_tipped?: boolean; error?: string };
    if (json.success || json.already_tipped) return { ok: true };
    return { ok: false, error: json.error ?? 'Erro ao processar gorjeta' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Extorna o pagamento de uma corrida via Edge Function. */
async function refundRide(rideId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(REFUND_RIDE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session?.access_token ?? ''}`,
      },
      body: JSON.stringify({ rideId }),
    });
    const json = await res.json() as { success?: boolean; no_charge?: boolean; error?: string };
    if (json.success) return { ok: true };
    return { ok: false, error: json.error ?? 'Erro ao extornar' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function notifyOnlineDrivers(
  destination: string,
  price: number,
  destinationCoords?: { lat: number; lng: number }
) {
  const { data: online } = await supabase
    .from('driver_locations')
    .select('driver_id')
    .eq('is_online', true);

  let driverIds = ((online as { driver_id: string }[]) ?? []).map((d) => d.driver_id);
  if (driverIds.length === 0) return;

  // Não incomoda motoristas já a caminho/em corrida com outro passageiro —
  // salvo se o destino desta nova chamada for igual (ou a até 1km) do
  // destino final da corrida ativa deles, ou se faltarem <=5min para
  // terminá-la (mesma regra usada no realtime — ver canReceiveNewRideOffer).
  const { data: busyRows } = await supabase
    .from('rides')
    .select('driver_id, status, destination_lat, destination_lng, destination_address, driver_eta_min')
    .in('driver_id', driverIds)
    .in('status', ['accepted', 'driver_en_route', 'in_progress']);

  const busyByDriver = new Map<string, { status: string; destination_lat?: number; destination_lng?: number; destination_address?: string; driver_eta_min?: number }>();
  for (const r of (busyRows as { driver_id?: string; status: string; destination_lat?: number; destination_lng?: number; destination_address?: string; driver_eta_min?: number }[]) ?? []) {
    if (r.driver_id) busyByDriver.set(r.driver_id, r);
  }

  driverIds = driverIds.filter((id) =>
    canReceiveNewRideOffer(busyByDriver.get(id) ?? null, {
      destination_address: destination,
      destination_lat: destinationCoords?.lat,
      destination_lng: destinationCoords?.lng,
    })
  );
  if (driverIds.length === 0) return;

  const { data: drivers } = await supabase
    .from('profiles')
    .select('push_token')
    .in('id', driverIds);

  const tokens = ((drivers as { push_token: string | null }[]) ?? [])
    .map((d) => d.push_token)
    .filter((t): t is string => !!t);

  await sendPushAsync(
    tokens.map((to) => ({
      to,
      title: '🚗 Nova corrida Executive XL',
      body: `Destino: ${destination} • ${formatCurrency(price)}`,
      data: { type: 'new_ride' },
    }))
  );
}

/** Notifica apenas o motorista vinculado ao QR code (não transmite para todos). */
async function notifySpecificDriver(driverId: string, destination: string, price: number) {
  const { data } = await supabase
    .from('profiles')
    .select('push_token')
    .eq('id', driverId)
    .single();

  const token = (data as { push_token: string | null })?.push_token;
  if (token) {
    await sendPushAsync([{
      to: token,
      title: '📲 Corrida via QR Code — Executive XL',
      body: `Passageiro solicitou pelo seu QR. Destino: ${destination} • ${formatCurrency(price)}`,
      data: { type: 'new_ride' },
    }]);
  }
}

/** Notifica o motorista vinculado ao QR code sobre um AGENDAMENTO (não uma corrida imediata). */
async function notifySpecificDriverScheduled(driverId: string, destination: string, price: number, scheduledFor: Date) {
  const { data } = await supabase
    .from('profiles')
    .select('push_token')
    .eq('id', driverId)
    .single();

  const token = (data as { push_token: string | null })?.push_token;
  if (token) {
    const when = `${scheduledFor.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${scheduledFor.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
    await sendPushAsync([{
      to: token,
      title: '🗓️📲 Agendamento via QR Code — Executive XL',
      body: `Passageiro agendou pelo seu QR para ${when}. Destino: ${destination} • ${formatCurrency(price)}`,
      data: { type: 'new_scheduled_ride' },
    }]);
  }
}

/**
 * Broadcast direto para o motorista específico (não precisa de push token).
 * Usado como fallback confiável no Expo Go / desenvolvimento.
 */
async function broadcastToDriver(driverId: string, ride: object) {
  const channelName = `driver-notify-${driverId}`;
  const ch = supabase.channel(channelName);

  await new Promise<void>((resolve) => {
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        ch.send({
          type: 'broadcast',
          event: 'new_qr_ride',
          payload: { ride },
        }).then(() => { supabase.removeChannel(ch); resolve(); })
          .catch(() => { supabase.removeChannel(ch); resolve(); });
      }
    });
    setTimeout(() => { supabase.removeChannel(ch); resolve(); }, 5000);
  });
}

async function notifyPassenger(passengerId: string, price?: number, etaMin?: number | null) {
  const { data } = await supabase
    .from('profiles')
    .select('push_token')
    .eq('id', passengerId)
    .single();

  const token = (data as { push_token: string | null })?.push_token;
  if (token) {
    const etaPhrase = etaMin ? ` Chegando em ${etaMin} min.` : ' Motorista a caminho!';
    const body = price
      ? `${formatCurrency(price)} cobrado do seu cartão.${etaPhrase}`
      : `Seu Executive XL foi confirmado.${etaPhrase}`;
    await sendPushAsync([
      {
        to: token,
        title: '💳 Pagamento confirmado — Motorista a caminho!',
        body,
        data: { type: 'ride_accepted' },
      },
    ]);
  }
}

/**
 * Envia um Broadcast Supabase diretamente para o canal do passageiro.
 * Não depende de WAL, RLS ou push token — basta o passageiro ter o app aberto.
 */
async function broadcastToPassenger(passengerId: string, rideId: string) {
  const channelName = `pax-notify-${passengerId}`;
  const ch = supabase.channel(channelName);

  await new Promise<void>((resolve) => {
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        ch.send({
          type: 'broadcast',
          event: 'schedule_confirmed',
          payload: { rideId },
        }).then(() => {
          supabase.removeChannel(ch);
          resolve();
        }).catch(() => {
          supabase.removeChannel(ch);
          resolve();
        });
      }
    });

    // timeout de segurança: se não conectar em 5s, desiste
    setTimeout(() => { supabase.removeChannel(ch); resolve(); }, 5000);
  });
}

/**
 * Avisa o passageiro que a corrida foi aceita pelo motorista.
 * Usa Broadcast (não depende de WAL/RLS/push) no canal pax-notify-${passengerId}.
 */
async function broadcastRideAccepted(passengerId: string, ride: object) {
  const channelName = `pax-notify-${passengerId}`;
  const ch = supabase.channel(channelName);

  await new Promise<void>((resolve) => {
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        ch.send({
          type: 'broadcast',
          event: 'ride_accepted',
          payload: { ride },
        }).then(() => {
          supabase.removeChannel(ch);
          resolve();
        }).catch(() => {
          supabase.removeChannel(ch);
          resolve();
        });
      }
    });
    setTimeout(() => { supabase.removeChannel(ch); resolve(); }, 5000);
  });
}

/**
 * Avisa TODOS os motoristas online que uma corrida foi aceita, para que o
 * overlay de chamada saia da tela dos outros (a corrida "some da fila").
 * Canal compartilhado `ride-offers`; o motorista que aceitou vai no payload
 * (`by`) para não se auto-limpar/duplicar log.
 */
async function broadcastRideTaken(rideId: string, by: string | undefined) {
  const ch = supabase.channel('ride-offers');
  await new Promise<void>((resolve) => {
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        ch.send({
          type: 'broadcast',
          event: 'ride_taken',
          payload: { rideId, by },
        }).then(() => {
          supabase.removeChannel(ch);
          resolve();
        }).catch(() => {
          supabase.removeChannel(ch);
          resolve();
        });
      }
    });
    setTimeout(() => { supabase.removeChannel(ch); resolve(); }, 5000);
  });
}

async function notifyPassengerScheduleConfirmed(passengerId: string) {
  const { data } = await supabase
    .from('profiles')
    .select('push_token')
    .eq('id', passengerId)
    .single();

  const token = (data as { push_token: string | null })?.push_token;
  if (token) {
    await sendPushAsync([
      {
        to: token,
        title: '🗓️ Motorista confirmado!',
        body: 'Um motorista aceitou seu agendamento. Você pode ver os detalhes na tela de corridas agendadas.',
        data: { type: 'schedule_confirmed' },
      },
    ]);
  }
}

/** Avisa o passageiro que o motorista NÃO confirmou o agendamento travado por QR. */
async function notifyPassengerScheduleRejected(passengerId: string) {
  const { data } = await supabase
    .from('profiles')
    .select('push_token')
    .eq('id', passengerId)
    .single();

  const token = (data as { push_token: string | null })?.push_token;
  if (token) {
    await sendPushAsync([
      {
        to: token,
        title: '🗓️ Agendamento não confirmado',
        body: 'O motorista não pôde confirmar seu agendamento. Estamos procurando outro motorista para você.',
        data: { type: 'schedule_rejected' },
      },
    ]);
  }
}

/** Notifica o passageiro (push) que a corrida foi concluída. */
export async function notifyPassengerRideCompleted(passengerId: string, price?: number) {
  const { data } = await supabase
    .from('profiles')
    .select('push_token')
    .eq('id', passengerId)
    .single();

  const token = (data as { push_token: string | null })?.push_token;
  if (token) {
    const body = price
      ? `Valor: ${formatCurrency(price)}. Avalie o motorista e deixe uma gorjeta! 🌟`
      : 'Sua corrida Executive XL foi concluída. Avalie o motorista!';
    await sendPushAsync([
      {
        to: token,
        title: '🏁 Corrida finalizada!',
        body,
        data: { type: 'ride_completed' },
      },
    ]);
  }
}

const PRICE_PER_MILE = 2.5;
const BASE_PRICE = 8.0;
const MIN_PRICE = 15.0;
const AVG_SPEED_MPH = 30;

export function estimatePrice(distanceKm: number, surgeMultiplier = 1.0) {
  const miles = distanceKm * KM_TO_MILES;
  const base = Math.max(BASE_PRICE + miles * PRICE_PER_MILE, MIN_PRICE);
  return applyMultiplier(base, surgeMultiplier);
}

export function estimateDuration(distanceKm: number) {
  const miles = distanceKm * KM_TO_MILES;
  return Math.ceil((miles / AVG_SPEED_MPH) * 60);
}

export function usePassengerRide(passengerId: string | undefined) {
  const [activeRide, setActiveRide] = useState<Ride | null>(null);

  useEffect(() => {
    if (!passengerId) return;

    const channel = supabase
      .channel('passenger-ride')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'rides',
          filter: `passenger_id=eq.${passengerId}`,
        },
        (payload) => {
          const ride = payload.new as Ride;
          if (['requesting', 'accepted', 'driver_en_route', 'in_progress'].includes(ride.status)) {
            setActiveRide(ride);
          } else {
            setActiveRide(null);
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [passengerId]);

  const requestRide = useCallback(async (
    origin: Location,
    destination: Location,
    routeInfo?: { distanceKm: number; durationMin: number },
    options?: { lockedDriverId?: string }
  ): Promise<Ride | null> => {
    if (!passengerId) return null;

    const distanceKm = routeInfo?.distanceKm ?? haversineDistance(
      { lat: origin.lat, lng: origin.lng },
      { lat: destination.lat, lng: destination.lng }
    );
    const { multiplier } = await getSurgeInfo();
    const fare = estimatePrice(distanceKm, multiplier);
    const duration = routeInfo?.durationMin ?? estimateDuration(distanceKm);
    // Pedágio (P5): 0 por padrão. Repassado integralmente ao motorista — o split
    // 80/20 incide só sobre a tarifa, então toll=0 mantém o comportamento atual.
    const { amount: toll } = await estimateTollAmount({
      origin: { lat: origin.lat, lng: origin.lng },
      destination: { lat: destination.lat, lng: destination.lng },
      distanceKm,
    });
    // Taxa de aeroporto/porto (P6): 0 por padrão. Regulatória → recolhida pela
    // plataforma (entra no platform_fee), não no motorista.
    const { total: venueFee } = await estimateAirportFees(
      { lat: origin.lat, lng: origin.lng },
      { lat: destination.lat, lng: destination.lng },
    );
    const price = Math.round((fare + toll + venueFee) * 100) / 100;
    const split = calculateSplit(fare);
    const driverAmount = Math.round((split.driverAmount + toll) * 100) / 100;
    const platformFee = Math.round((split.platformFee + venueFee) * 100) / 100;

    const insertPayload = {
      passenger_id: passengerId,
      origin_lat: origin.lat,
      origin_lng: origin.lng,
      origin_address: origin.address,
      destination_lat: destination.lat,
      destination_lng: destination.lng,
      destination_address: destination.address,
      status: 'requesting' as RideStatus,
      price,
      distance_km: distanceKm,
      duration_min: duration,
      toll_amount: toll,
      airport_port_fee: venueFee,
      driver_amount: driverAmount,
      platform_fee: platformFee,
      // QR: pré-vincula o motorista; ele ainda precisa aceitar
      ...(options?.lockedDriverId ? { driver_id: options.lockedDriverId } : {}),
    };

    const { error: insertError } = await supabase
      .from('rides')
      .insert(insertPayload);

    if (insertError) {
      reportError(insertError, { op: 'requestRide.insert', passengerId });
      return null;
    }

    // SELECT separado — evita problema de RLS no RETURNING pós-insert
    const { data, error: selectError } = await supabase
      .from('rides')
      .select('*')
      .eq('passenger_id', passengerId)
      .eq('status', 'requesting')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (selectError || !data) {
      reportError(selectError, { op: 'requestRide.select', passengerId });
      return null;
    }

    setActiveRide(data as Ride);
    if (options?.lockedDriverId) {
      // Broadcast in-app (confiável mesmo sem push token no Expo Go)
      broadcastToDriver(options.lockedDriverId, data);
      // Push remoto como reforço (funciona em produção)
      notifySpecificDriver(options.lockedDriverId, destination.address, price);
    } else {
      notifyOnlineDrivers(destination.address, price, { lat: destination.lat, lng: destination.lng });
    }
    return data as Ride;
  }, [passengerId]);

  const scheduleRide = useCallback(async (
    origin: Location,
    destination: Location,
    scheduledFor: Date,
    routeInfo?: { distanceKm: number; durationMin: number },
    options?: { lockedDriverId?: string }
  ): Promise<Ride | null> => {
    if (!passengerId) return null;

    const distanceKm = routeInfo?.distanceKm ?? haversineDistance(
      { lat: origin.lat, lng: origin.lng },
      { lat: destination.lat, lng: destination.lng }
    );
    const fare = estimatePrice(distanceKm);
    const duration = routeInfo?.durationMin ?? estimateDuration(distanceKm);
    // Pedágio (P5): mesma regra do requestRide — pass-through ao motorista, 0 por padrão.
    const { amount: toll } = await estimateTollAmount({
      origin: { lat: origin.lat, lng: origin.lng },
      destination: { lat: destination.lat, lng: destination.lng },
      distanceKm,
    });
    // Taxa de aeroporto/porto (P6): regulatória → recolhida pela plataforma, 0 por padrão.
    const { total: venueFee } = await estimateAirportFees(
      { lat: origin.lat, lng: origin.lng },
      { lat: destination.lat, lng: destination.lng },
    );
    const price = Math.round((fare + toll + venueFee) * 100) / 100;
    const split = calculateSplit(fare);
    const driverAmount = Math.round((split.driverAmount + toll) * 100) / 100;
    const platformFee = Math.round((split.platformFee + venueFee) * 100) / 100;

    const { data, error } = await supabase
      .from('rides')
      .insert({
        passenger_id: passengerId,
        origin_lat: origin.lat,
        origin_lng: origin.lng,
        origin_address: origin.address,
        destination_lat: destination.lat,
        destination_lng: destination.lng,
        destination_address: destination.address,
        status: 'scheduled' as RideStatus,
        price,
        distance_km: distanceKm,
        duration_min: duration,
        toll_amount: toll,
        airport_port_fee: venueFee,
        scheduled_for: scheduledFor.toISOString(),
        driver_amount: driverAmount,
        platform_fee: platformFee,
        // QR: pré-vincula o motorista; ele ainda precisa aceitar/recusar o agendamento
        ...(options?.lockedDriverId ? { driver_id: options.lockedDriverId } : {}),
      })
      .select()
      .single();

    if (error) return null;
    if (options?.lockedDriverId) {
      // Broadcast in-app (confiável mesmo sem push token no Expo Go)
      broadcastToDriver(options.lockedDriverId, data);
      // Push remoto como reforço (funciona em produção)
      notifySpecificDriverScheduled(options.lockedDriverId, destination.address, price, scheduledFor);
    } else {
      // Notifica motoristas online imediatamente — igual ao requestRide
      notifyOnlineDrivers(destination.address, price, { lat: destination.lat, lng: destination.lng });
    }
    return data as Ride;
  }, [passengerId]);

  const cancelRide = useCallback(async (rideId: string) => {
    // Extorna o pagamento se a corrida já tiver sido cobrada
    await refundRide(rideId);
    await supabase
      .from('rides')
      .update({ status: 'cancelled' as RideStatus })
      .eq('id', rideId);
    setActiveRide(null);
  }, []);

  return { activeRide, requestRide, scheduleRide, cancelRide };
}

export function useScheduledRides(passengerId: string | undefined) {
  const [rides, setRides] = useState<RideRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!passengerId) return;
    setLoading(true);
    const { data } = await supabase
      .from('rides')
      .select('*')
      .eq('passenger_id', passengerId)
      .eq('status', 'scheduled')
      .order('scheduled_for', { ascending: true });
    setRides((data as RideRecord[]) ?? []);
    setLoading(false);
  }, [passengerId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const activate = useCallback(async (rideId: string): Promise<Ride | null> => {
    // Verifica se já tem motorista pré-confirmado
    const { data: current } = await supabase
      .from('rides').select('driver_id,destination_address,price').eq('id', rideId).single();
    const preAssigned = !!(current as { driver_id?: string })?.driver_id;

    const nextStatus: RideStatus = preAssigned ? 'accepted' : 'requesting';
    const extra = preAssigned ? { accepted_at: new Date().toISOString() } : {};

    const { data } = await supabase
      .from('rides')
      .update({ status: nextStatus, ...extra })
      .eq('id', rideId)
      .select()
      .single();
    await refresh();

    if (data) {
      const ride = data as Ride;
      if (preAssigned) {
        // Notifica o motorista pré-confirmado
        notifyPassenger(ride.passenger_id); // reutiliza lógica de push
      } else {
        const dest = ride.destination_address ?? ride.destination?.address ?? 'Destino';
        const destLat = ride.destination_lat ?? ride.destination?.lat;
        const destLng = ride.destination_lng ?? ride.destination?.lng;
        notifyOnlineDrivers(dest, Number(ride.price) || 0, destLat != null && destLng != null ? { lat: destLat, lng: destLng } : undefined);
      }
    }
    return (data as Ride) ?? null;
  }, [refresh]);

  const claimScheduledRide = useCallback(async (rideId: string, driverId: string): Promise<boolean> => {
    const { error } = await supabase
      .from('rides')
      // accepted_at marca a decisão do motorista — reivindicar do pool aberto
      // já É a confirmação, então grava junto (mesma semântica usada pelo
      // fluxo de agendamento travado por QR, ver confirmQrScheduledRide).
      .update({ driver_id: driverId, accepted_at: new Date().toISOString() })
      .eq('id', rideId)
      .is('driver_id', null) // apenas se ainda sem motorista (evita dupla confirmação)
      .eq('status', 'scheduled');
    return !error;
  }, []);

  const cancel = useCallback(async (rideId: string) => {
    await supabase.from('rides').update({ status: 'cancelled' as RideStatus }).eq('id', rideId);
    await refresh();
  }, [refresh]);

  return { rides, loading, refresh, activate, cancel, claimScheduledRide };
}

export function useDriverRide(driverId: string | undefined) {
  const [pendingRide, setPendingRide] = useState<Ride | null>(null);
  const [pendingScheduledRide, setPendingScheduledRide] = useState<Ride | null>(null);
  const [activeRide, setActiveRide] = useState<Ride | null>(null);
  const channelId = useRef(Math.random().toString(36).slice(2)).current;
  const pendingRideIdRef = useRef<string | null>(null);
  const pendingScheduledRideIdRef = useRef<string | null>(null);
  const activeRideRef = useRef<Ride | null>(null);

  // Mantém ref sincronizada para usar dentro de setInterval sem stale closure
  useEffect(() => {
    pendingRideIdRef.current = pendingRide?.id ?? null;
  }, [pendingRide?.id]);

  useEffect(() => {
    pendingScheduledRideIdRef.current = pendingScheduledRide?.id ?? null;
  }, [pendingScheduledRide?.id]);

  // Mantém ref da corrida ativa sincronizada — usada para decidir, fora de
  // qualquer closure de handler, se uma NOVA chamada de corrida pode chegar
  // ao motorista (ver canReceiveNewRideOffer): uma vez que ele inicia o
  // deslocamento de uma corrida (agendada ou não), fica bloqueado para novas
  // chamadas até faltar <=5min para terminar, salvo destino igual/perto (1km).
  useEffect(() => {
    activeRideRef.current = activeRide;
  }, [activeRide]);

  // Descarta o popup de agendamento automaticamente quando o horário passa
  useEffect(() => {
    if (!pendingScheduledRide?.scheduled_for) return;
    const scheduledAt = new Date(pendingScheduledRide.scheduled_for).getTime();
    const msUntilExpiry = scheduledAt - Date.now();
    if (msUntilExpiry <= 0) {
      setPendingScheduledRide(null);
      return;
    }
    const timer = setTimeout(() => setPendingScheduledRide(null), msUntilExpiry);
    return () => clearTimeout(timer);
  }, [pendingScheduledRide?.scheduled_for]);

  // ─── Fetch inicial ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!driverId) return;

    // Corrida QR pendente já criada (caso motorista abra o app depois do passageiro)
    supabase
      .from('rides')
      .select('*')
      .eq('driver_id', driverId)
      .eq('status', 'requesting')
      .maybeSingle()
      .then(({ data }) => {
        if (data && canReceiveNewRideOffer(activeRideRef.current, data as Ride)) {
          setPendingRide(data as Ride);
        }
      });

    (async () => {
      // Agendamento travado por QR aguardando a decisão deste motorista — tem
      // prioridade sobre o pool aberto e NÃO respeita a janela de 1h (o
      // passageiro escolheu este motorista especificamente e precisa de uma
      // resposta o quanto antes).
      const { data: qrScheduled } = await supabase
        .from('rides')
        .select('*')
        .eq('driver_id', driverId)
        .eq('status', 'scheduled')
        .is('accepted_at', null)
        .order('scheduled_for', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (qrScheduled) {
        setPendingScheduledRide(qrScheduled as Ride);
        return;
      }

      // Corrida agendada disponível no pool aberto — apenas dentro da janela de 1h
      const now = new Date();
      const windowEnd = new Date(now.getTime() + 60 * 60 * 1000);
      const { data: poolRide } = await supabase
        .from('rides')
        .select('*')
        .eq('status', 'scheduled')
        .is('driver_id', null)
        .gte('scheduled_for', now.toISOString())
        .lte('scheduled_for', windowEnd.toISOString())
        .order('scheduled_for', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (poolRide) setPendingScheduledRide(poolRide as Ride);
    })();
  }, [driverId]);

  // ─── Polling: verifica corrida QR a cada 4s ─────────────────────────────────
  // Garante entrega mesmo quando realtime não dispara (ex.: sem REPLICA IDENTITY FULL)
  useEffect(() => {
    if (!driverId) return;

    const interval = setInterval(async () => {
      const { data } = await supabase
        .from('rides')
        .select('*')
        .eq('driver_id', driverId)
        .eq('status', 'requesting')
        .maybeSingle();

      if (
        data &&
        (data as Ride).id !== pendingRideIdRef.current &&
        canReceiveNewRideOffer(activeRideRef.current, data as Ride)
      ) {
        setPendingRide(data as Ride);
      }
    }, 4000);

    return () => clearInterval(interval);
  }, [driverId]);

  // ─── Polling: verifica agendamento QR-travado aguardando decisão a cada 4s ──
  // Mesmo motivo do polling acima — garante entrega mesmo sem realtime, já que
  // este caso NÃO depende da janela de 1h (precisa aparecer assim que criado).
  useEffect(() => {
    if (!driverId) return;

    const interval = setInterval(async () => {
      const { data } = await supabase
        .from('rides')
        .select('*')
        .eq('driver_id', driverId)
        .eq('status', 'scheduled')
        .is('accepted_at', null)
        .order('scheduled_for', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (data && (data as Ride).id !== pendingScheduledRideIdRef.current) {
        setPendingScheduledRide(data as Ride);
      }
    }, 4000);

    return () => clearInterval(interval);
  }, [driverId]);

  // ─── Realtime ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!driverId) return;

    const channel = supabase
      .channel(`driver-ride-${driverId}-${channelId}`)
      // Corridas normais (sem motorista pré-fixado)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'rides',
          filter: `status=eq.requesting`,
        },
        (payload) => {
          const ride = payload.new as Ride;
          if ((!ride.driver_id || ride.driver_id === driverId) && canReceiveNewRideOffer(activeRideRef.current, ride)) {
            setPendingRide(ride);
          }
        }
      )
      // Nova corrida agendada — aparece como card de pedido apenas se estiver na janela de 1h
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'rides',
          filter: `status=eq.scheduled`,
        },
        (payload) => {
          const ride = payload.new as Ride;
          if (ride.driver_id === driverId) {
            // Agendamento travado por QR para ESTE motorista — avisa sempre,
            // sem restrição de janela de 1h (ele precisa decidir já).
            setPendingScheduledRide(ride);
            return;
          }
          if (!ride.driver_id && ride.scheduled_for) {
            const now = Date.now();
            const scheduledAt = new Date(ride.scheduled_for).getTime();
            const inWindow = scheduledAt >= now && scheduledAt <= now + 60 * 60 * 1000;
            if (inWindow) setPendingScheduledRide(ride);
          }
        }
      )
      // Corridas agendadas ativadas chegam como UPDATE (scheduled→requesting)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'rides',
          filter: `status=eq.requesting`,
        },
        (payload) => {
          const ride = payload.new as Ride;
          if (!ride.driver_id && canReceiveNewRideOffer(activeRideRef.current, ride)) setPendingRide(ride);
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'rides',
          filter: `driver_id=eq.${driverId}`,
        },
        (payload) => {
          const ride = payload.new as Ride;
          if (['accepted', 'driver_en_route', 'in_progress'].includes(ride.status)) {
            setActiveRide(ride);
            setPendingRide(null);
          } else {
            setActiveRide(null);
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [driverId]);

  // ─── Broadcast "corrida aceita por outro motorista" ──────────────────────────
  // Modelo de dispatch em leque: a mesma corrida em 'requesting' aparece para
  // todos os motoristas online. Quando um aceita, os postgres_changes filtrados
  // por driver_id NÃO disparam para os demais (a corrida agora pertence a outro),
  // então o overlay ficaria preso. Este canal compartilhado resolve isso: ao
  // aceitar, broadcastRideTaken avisa todos; quem tiver essa corrida como
  // pendente limpa o overlay na hora.
  useEffect(() => {
    if (!driverId) return;
    const ch = supabase
      .channel('ride-offers')
      .on('broadcast', { event: 'ride_taken' }, ({ payload }) => {
        const rideId = payload?.rideId as string | undefined;
        const by = payload?.by as string | undefined;
        if (!rideId || by === driverId) return; // ignora o próprio aceite
        if (rideId === pendingRideIdRef.current) {
          setPendingRide(null);
          logRideOfferEvent(rideId, driverId, 'taken_by_other', { reason: 'broadcast' });
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [driverId]);

  const acceptRide = useCallback(async (
    rideId: string,
    driverLocation?: { lat: number; lng: number } | null
  ): Promise<Ride | null | 'payment_error'> => {
    // 0) Cobra o cartão do passageiro ANTES de aceitar.
    //    Se o pagamento falhar, o motorista vê o erro e a corrida permanece em 'requesting'.
    const charge = await chargeRide(rideId);
    if (!charge.ok) {
      reportError(charge.error, { op: 'acceptRide.charge', rideId });
      logRideOfferEvent(rideId, driverId, 'failed', { reason: 'payment_error' });
      return 'payment_error';
    }

    // 1) UPDATE (sem RETURNING — o .select().single() falha silenciosamente em alguns casos)
    //    withTimeout: a escrita do supabase-js pode ficar pendurada em rede instável.
    let updateError: unknown = null;
    try {
      const res = await withTimeout(
        supabase
          .from('rides')
          .update({ driver_id: driverId, status: 'accepted' as RideStatus, accepted_at: new Date().toISOString() })
          .eq('id', rideId)
          .eq('status', 'requesting')
          // Aceita apenas se a corrida não estiver travada para outro motorista
          .or(`driver_id.is.null,driver_id.eq.${driverId}`),
        12000,
        'A confirmação da corrida demorou demais.'
      );
      updateError = res.error;
    } catch (e) {
      updateError = e;
    }

    if (updateError) {
      reportError(updateError, { op: 'acceptRide.update', rideId });
      logRideOfferEvent(rideId, driverId, 'taken_by_other', { reason: 'update_error' });
      return null;
    }

    // 1b) A corrida agora é DEFINITIVAMENTE deste motorista: o UPDATE atômico
    //     com .eq('status','requesting') garante um único vencedor. Avisa os
    //     OUTROS motoristas AGORA para que o overlay de chamada — e o som —
    //     parem imediatamente. Não espera o SELECT/telemetria abaixo, que
    //     podem levar vários segundos e deixariam o alerta tocando nos demais.
    broadcastRideTaken(rideId, driverId);

    // 2) SELECT separado para confirmar e obter a corrida atualizada
    let data: unknown = null;
    let selectError: unknown = null;
    try {
      const res = await withTimeout(
        supabase
          .from('rides')
          .select('*')
          .eq('id', rideId)
          .eq('driver_id', driverId)
          .eq('status', 'accepted')
          .single(),
        12000,
        'A confirmação da corrida demorou demais.'
      );
      data = res.data;
      selectError = res.error;
    } catch (e) {
      selectError = e;
    }

    if (selectError || !data) {
      reportError(selectError, { op: 'acceptRide.select', rideId });
      logRideOfferEvent(rideId, driverId, 'taken_by_other', { reason: 'select_failed' });
      return null;
    }

    let ride = data as Ride;

    // 3) Calcula o ETA até o embarque para gravar em rides — assim o passageiro
    //    recebe o tempo estimado junto com o aviso de "motorista a caminho".
    //    IMPORTANTE: isso é 100% fire-and-forget agora. O motorista precisa ver o
    //    mapa com a rota traçada IMEDIATAMENTE ao aceitar — nenhuma chamada de
    //    rede (OSRM/telemetria) pode segurar o retorno de acceptRide/a navegação
    //    para DriverNavigateScreen, que já calcula e desenha a própria rota ao
    //    montar (usando a localização do motorista salva no aceite como origem).
    if (driverLocation && ride.origin_lat != null && ride.origin_lng != null) {
      const originForRoute = driverLocation;
      const destForRoute = { lat: ride.origin_lat, lng: ride.origin_lng };
      getRoute(originForRoute, destForRoute)
        .then((path) => {
          if (!path) return;
          const telemetry = {
            driver_lat: originForRoute.lat,
            driver_lng: originForRoute.lng,
            driver_eta_min: path.durationMin,
            driver_eta_km: path.distanceKm,
          };
          return withTimeout(
            supabase.from('rides').update(telemetry).eq('id', rideId),
            8000,
            'telemetry timeout'
          );
        })
        .catch(() => {
          // Sem ETA inicial — DriverNavigateScreen ainda vai calcular e gravar o seu.
        });
    }

    setActiveRide(ride);
    setPendingRide(null);

    // Auditoria: aceite confirmado.
    logRideOfferEvent(rideId, driverId, 'accepted');

    // Remove a chamada da fila dos OUTROS motoristas online.
    broadcastRideTaken(rideId, driverId);

    // Confirmação ao passageiro: broadcast direto (confiável) + push como fallback
    broadcastRideAccepted(ride.passenger_id, ride);
    notifyPassenger(ride.passenger_id, ride.price, ride.driver_eta_min);

    return ride;
  }, [driverId]);

  const confirmScheduledRide = useCallback(async (rideId: string): Promise<boolean> => {
    const { data, error } = await supabase
      .from('rides')
      // accepted_at marca a decisão do motorista — reivindicar do pool aberto
      // já É a confirmação, então grava junto. Isso mantém accepted_at com o
      // mesmo significado ("motorista confirmou") tanto aqui quanto no fluxo
      // de agendamento travado por QR (confirmQrScheduledRide) — evitando que
      // uma corrida recém-reivindicada seja confundida com uma ainda aguardando
      // decisão nas checagens de polling/realtime abaixo.
      .update({ driver_id: driverId, accepted_at: new Date().toISOString() })
      .eq('id', rideId)
      .is('driver_id', null)
      .eq('status', 'scheduled')
      .select()
      .single();

    if (error || !data) return false;
    setPendingScheduledRide(null);

    const ride = data as Ride;

    // Broadcast direto para o passageiro (mais confiável que push/postgres_changes)
    broadcastToPassenger(ride.passenger_id, ride.id);

    // Tenta push remoto como fallback (só funciona se o passageiro tiver token EAS)
    notifyPassengerScheduleConfirmed(ride.passenger_id);

    return true;
  }, [driverId]);

  /**
   * Confirma um agendamento que já veio TRAVADO para este motorista (via QR
   * code do passageiro) — diferente de `confirmScheduledRide` (que reivindica
   * uma corrida do pool aberto, ainda sem motorista). Aqui `driver_id` já é
   * deste motorista desde a criação; só falta gravar `accepted_at` para sair
   * do estado "aguardando decisão".
   */
  const confirmQrScheduledRide = useCallback(async (rideId: string): Promise<boolean> => {
    const { data, error } = await supabase
      .from('rides')
      .update({ accepted_at: new Date().toISOString() })
      .eq('id', rideId)
      .eq('driver_id', driverId)
      .eq('status', 'scheduled')
      .is('accepted_at', null)
      .select()
      .single();

    if (error || !data) return false;
    setPendingScheduledRide(null);

    const ride = data as Ride;
    // Broadcast direto para o passageiro (mais confiável que push/postgres_changes)
    broadcastToPassenger(ride.passenger_id, ride.id);
    // Tenta push remoto como fallback
    notifyPassengerScheduleConfirmed(ride.passenger_id);

    return true;
  }, [driverId]);

  /**
   * Recusa um agendamento travado por QR: libera `driver_id` de volta para
   * `null`, devolvendo a corrida ao pool aberto para outros motoristas, e
   * avisa o passageiro que este motorista não pôde confirmar.
   */
  const rejectScheduledRide = useCallback(async (rideId: string): Promise<boolean> => {
    const { data, error } = await supabase
      .from('rides')
      .update({ driver_id: null })
      .eq('id', rideId)
      .eq('driver_id', driverId)
      .eq('status', 'scheduled')
      .is('accepted_at', null)
      .select()
      .single();

    if (error || !data) return false;
    setPendingScheduledRide(null);

    const ride = data as Ride;
    notifyPassengerScheduleRejected(ride.passenger_id);

    return true;
  }, [driverId]);

  const updateRideStatus = useCallback(async (rideId: string, status: RideStatus) => {
    await supabase
      .from('rides')
      .update({ status, ...(status === 'completed' ? { completed_at: new Date().toISOString() } : {}) })
      .eq('id', rideId);
  }, []);

  return {
    pendingRide, pendingScheduledRide,
    activeRide, acceptRide, confirmScheduledRide,
    confirmQrScheduledRide, rejectScheduledRide,
    updateRideStatus, setPendingRide, setPendingScheduledRide,
    refundRide,
  };
}

function haversineDistance(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
