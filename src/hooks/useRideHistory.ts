import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { RideRecord, UserType } from '../types';

export function useRideHistory(userId: string | undefined, userType: UserType) {
  const [rides, setRides] = useState<RideRecord[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchHistory = useCallback(async () => {
    // Sem userId ainda (ex.: profile do AuthContext não terminou de carregar) —
    // não há o que buscar, mas o spinner precisa ser liberado mesmo assim, senão
    // fica preso em "loading" para sempre até um userId chegar.
    if (!userId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const column = userType === 'driver' ? 'driver_id' : 'passenger_id';
    const { data } = await supabase
      .from('rides')
      .select('*')
      .eq(column, userId)
      .in('status', ['completed', 'cancelled', 'scheduled'])
      .order('created_at', { ascending: false });
    setRides((data as RideRecord[]) ?? []);
    setLoading(false);
  }, [userId, userType]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  return { rides, loading, refresh: fetchHistory };
}

export interface DriverEarnings {
  totalEarnings: number;
  totalRides: number;
  todayEarnings: number;
  todayRides: number;
  avgPerRide: number;
}

export interface CompletedRide {
  id: string;
  price: number;
  distance_km: number;
  completed_at: string;
  destination_address: string;
}

export function useDriverStats(driverId: string | undefined) {
  const [rides, setRides] = useState<CompletedRide[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!driverId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data } = await supabase
      .from('rides')
      .select('id, price, distance_km, completed_at, destination_address')
      .eq('driver_id', driverId)
      .eq('status', 'completed')
      .order('completed_at', { ascending: false });
    setRides((data as CompletedRide[]) ?? []);
    setLoading(false);
  }, [driverId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { rides, loading, refresh };
}

export function useDriverEarnings(driverId: string | undefined) {
  const [earnings, setEarnings] = useState<DriverEarnings>({
    totalEarnings: 0,
    totalRides: 0,
    todayEarnings: 0,
    todayRides: 0,
    avgPerRide: 0,
  });
  const [loading, setLoading] = useState(true);

  const fetchEarnings = useCallback(async () => {
    if (!driverId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const { data } = await supabase
      .from('rides')
      .select('price, completed_at')
      .eq('driver_id', driverId)
      .eq('status', 'completed');

    const rows = (data as { price: number; completed_at: string }[]) ?? [];
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    let total = 0;
    let todayTotal = 0;
    let todayCount = 0;

    for (const r of rows) {
      const price = Number(r.price) || 0;
      total += price;
      if (r.completed_at && new Date(r.completed_at) >= startOfDay) {
        todayTotal += price;
        todayCount += 1;
      }
    }

    setEarnings({
      totalEarnings: total,
      totalRides: rows.length,
      todayEarnings: todayTotal,
      todayRides: todayCount,
      avgPerRide: rows.length ? total / rows.length : 0,
    });
    setLoading(false);
  }, [driverId]);

  useEffect(() => {
    fetchEarnings();
  }, [fetchEarnings]);

  return { earnings, loading, refresh: fetchEarnings };
}
