import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { sendPushAsync } from '../lib/notifications';
import type { Ride, RideStatus, Location } from '../types';

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
      body: `Destino: ${destination} • R$ ${price.toFixed(2)}`,
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

const PRICE_PER_KM = 4.5;
const BASE_PRICE = 12.0;
const MIN_PRICE = 18.0;

export function estimatePrice(distanceKm: number) {
  const price = BASE_PRICE + distanceKm * PRICE_PER_KM;
  return Math.max(price, MIN_PRICE);
}

export function estimateDuration(distanceKm: number) {
  return Math.ceil((distanceKm / 40) * 60);
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

  const requestRide = useCallback(async (origin: Location, destination: Location): Promise<Ride | null> => {
    if (!passengerId) return null;

    const distanceKm = haversineDistance(
      { lat: origin.lat, lng: origin.lng },
      { lat: destination.lat, lng: destination.lng }
    );
    const price = estimatePrice(distanceKm);
    const duration = estimateDuration(distanceKm);

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
      })
      .select()
      .single();

    if (error) return null;
    setActiveRide(data as Ride);
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

  return { activeRide, requestRide, cancelRide };
}

export function useDriverRide(driverId: string | undefined) {
  const [pendingRide, setPendingRide] = useState<Ride | null>(null);
  const [activeRide, setActiveRide] = useState<Ride | null>(null);

  useEffect(() => {
    if (!driverId) return;

    const channel = supabase
      .channel('driver-ride')
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

  const updateRideStatus = useCallback(async (rideId: string, status: RideStatus) => {
    await supabase
      .from('rides')
      .update({ status, ...(status === 'completed' ? { completed_at: new Date().toISOString() } : {}) })
      .eq('id', rideId);
  }, []);

  return { pendingRide, activeRide, acceptRide, updateRideStatus, setPendingRide };
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
