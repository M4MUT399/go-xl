import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { sendPushAsync } from '../lib/notifications';
import { KM_TO_MILES, formatCurrency } from '../lib/format';
import { getSurgeInfo, applyMultiplier } from '../lib/surge';
import { calculateSplit } from '../lib/split';
import type { Ride, RideStatus, Location, RideRecord } from '../types';
export type { SurgeInfo } from '../lib/surge';

async function notifyOnlineDrivers(destination: string, price: number) {
  const { data: online } = await supabase
    .from('driver_locations')
    .select('driver_id')
    .eq('is_online', true);

  const driverIds = ((online as { driver_id: string }[]) ?? []).map((d) => d.driver_id);
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

async function notifyPassenger(passengerId: string) {
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
        title: '✅ Motorista a caminho!',
        body: 'Seu Executive XL foi confirmado e está indo até você.',
        data: { type: 'ride_accepted' },
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
    routeInfo?: { distanceKm: number; durationMin: number }
  ): Promise<Ride | null> => {
    if (!passengerId) return null;

    const distanceKm = routeInfo?.distanceKm ?? haversineDistance(
      { lat: origin.lat, lng: origin.lng },
      { lat: destination.lat, lng: destination.lng }
    );
    const { multiplier } = await getSurgeInfo();
    const price = estimatePrice(distanceKm, multiplier);
    const duration = routeInfo?.durationMin ?? estimateDuration(distanceKm);
    const { driverAmount, platformFee } = calculateSplit(price);

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
        status: 'requesting' as RideStatus,
        price,
        distance_km: distanceKm,
        duration_min: duration,
        driver_amount: driverAmount,
        platform_fee: platformFee,
      })
      .select()
      .single();

    if (error) return null;
    setActiveRide(data as Ride);
    notifyOnlineDrivers(destination.address, price);
    return data as Ride;
  }, [passengerId]);

  const scheduleRide = useCallback(async (
    origin: Location,
    destination: Location,
    scheduledFor: Date,
    routeInfo?: { distanceKm: number; durationMin: number }
  ): Promise<Ride | null> => {
    if (!passengerId) return null;

    const distanceKm = routeInfo?.distanceKm ?? haversineDistance(
      { lat: origin.lat, lng: origin.lng },
      { lat: destination.lat, lng: destination.lng }
    );
    const price = estimatePrice(distanceKm);
    const duration = routeInfo?.durationMin ?? estimateDuration(distanceKm);
    const { driverAmount, platformFee } = calculateSplit(price);

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
        scheduled_for: scheduledFor.toISOString(),
        driver_amount: driverAmount,
        platform_fee: platformFee,
      })
      .select()
      .single();

    if (error) return null;
    // Notifica motoristas online imediatamente — igual ao requestRide
    notifyOnlineDrivers(destination.address, price);
    return data as Ride;
  }, [passengerId]);

  const cancelRide = useCallback(async (rideId: string) => {
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
        notifyOnlineDrivers(dest, Number(ride.price) || 0);
      }
    }
    return (data as Ride) ?? null;
  }, [refresh]);

  const claimScheduledRide = useCallback(async (rideId: string, driverId: string): Promise<boolean> => {
    const { error } = await supabase
      .from('rides')
      .update({ driver_id: driverId })
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

  // Fetch inicial: pega a corrida agendada mais próxima ainda sem motorista
  useEffect(() => {
    if (!driverId) return;
    supabase
      .from('rides')
      .select('*')
      .eq('status', 'scheduled')
      .is('driver_id', null)
      .order('scheduled_for', { ascending: true })
      .limit(1)
      .single()
      .then(({ data }) => {
        if (data) setPendingScheduledRide(data as Ride);
      });
  }, [driverId]);

  useEffect(() => {
    if (!driverId) return;

    const channel = supabase
      .channel(`driver-ride-${driverId}-${channelId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'rides',
          filter: `status=eq.requesting`,
        },
        (payload) => setPendingRide(payload.new as Ride)
      )
      // Nova corrida agendada — aparece como card de pedido para o motorista aceitar
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
          if (!ride.driver_id) setPendingScheduledRide(ride);
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
          if (!ride.driver_id) setPendingRide(ride);
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

  const acceptRide = useCallback(async (rideId: string): Promise<Ride | null> => {
    const { data, error } = await supabase
      .from('rides')
      .update({ driver_id: driverId, status: 'accepted' as RideStatus, accepted_at: new Date().toISOString() })
      .eq('id', rideId)
      .eq('status', 'requesting')
      .select()
      .single();

    if (error) return null;
    setActiveRide(data as Ride);
    setPendingRide(null);
    notifyPassenger((data as Ride).passenger_id);
    return data as Ride;
  }, [driverId]);

  const confirmScheduledRide = useCallback(async (rideId: string): Promise<boolean> => {
    const { data, error } = await supabase
      .from('rides')
      .update({ driver_id: driverId })
      .eq('id', rideId)
      .is('driver_id', null)
      .eq('status', 'scheduled')
      .select()
      .single();

    if (error || !data) return false;
    setPendingScheduledRide(null);
    // Notifica o passageiro que seu motorista foi confirmado
    notifyPassenger((data as Ride).passenger_id);
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
    updateRideStatus, setPendingRide, setPendingScheduledRide,
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
