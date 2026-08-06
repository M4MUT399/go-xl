import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { withTimeout } from '../lib/withTimeout';
import type { RideRecord, UserType } from '../types';

const QUERY_TIMEOUT_MS = 15000;

export function useRideHistory(userId: string | undefined, userType: UserType) {
  const [rides, setRides] = useState<RideRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchHistory = useCallback(async () => {
    // Sem userId ainda (ex.: profile do AuthContext não terminou de carregar) —
    // não há o que buscar, mas o spinner precisa ser liberado mesmo assim, senão
    // fica preso em "loading" para sempre até um userId chegar.
    if (!userId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const column = userType === 'driver' ? 'driver_id' : 'passenger_id';
      // Com timeout + try/catch: sem isso, uma query presa (rede instável) ou um
      // erro do Supabase (ex.: RLS) nunca liberava o loading — a aba ficava
      // girando o spinner para sempre e nenhuma corrida aparecia.
      const { data, error: queryError } = await withTimeout(
        supabase
          .from('rides')
          .select('*')
          .eq(column, userId)
          .in('status', ['completed', 'cancelled', 'scheduled'])
          .order('created_at', { ascending: false }),
        QUERY_TIMEOUT_MS,
        'Não foi possível carregar suas viagens. Verifique sua conexão.'
      );
      if (queryError) throw queryError;
      setRides((data as RideRecord[]) ?? []);
    } catch (e: any) {
      console.error('[useRideHistory] falha ao buscar histórico:', e);
      setError(e?.message ?? 'Não foi possível carregar suas viagens.');
      setRides([]);
    } finally {
      setLoading(false);
    }
  }, [userId, userType]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  return { rides, loading, error, refresh: fetchHistory };
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
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!driverId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { data, error: queryError } = await withTimeout(
        supabase
          .from('rides')
          .select('id, price, distance_km, completed_at, destination_address')
          .eq('driver_id', driverId)
          .eq('status', 'completed')
          .order('completed_at', { ascending: false }),
        QUERY_TIMEOUT_MS,
        'Não foi possível carregar suas corridas. Verifique sua conexão.'
      );
      if (queryError) throw queryError;
      setRides((data as CompletedRide[]) ?? []);
    } catch (e: any) {
      console.error('[useDriverStats] falha ao buscar corridas:', e);
      setError(e?.message ?? 'Não foi possível carregar suas corridas.');
      setRides([]);
    } finally {
      setLoading(false);
    }
  }, [driverId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { rides, loading, error, refresh };
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
  const [error, setError] = useState<string | null>(null);

  const fetchEarnings = useCallback(async () => {
    if (!driverId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { data, error: queryError } = await withTimeout(
        supabase
          .from('rides')
          .select('price, completed_at')
          .eq('driver_id', driverId)
          .eq('status', 'completed'),
        QUERY_TIMEOUT_MS,
        'Não foi possível carregar seus ganhos. Verifique sua conexão.'
      );
      if (queryError) throw queryError;

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
    } catch (e: any) {
      console.error('[useDriverEarnings] falha ao buscar ganhos:', e);
      setError(e?.message ?? 'Não foi possível carregar seus ganhos.');
    } finally {
      setLoading(false);
    }
  }, [driverId]);

  useEffect(() => {
    fetchEarnings();
  }, [fetchEarnings]);

  return { earnings, loading, error, refresh: fetchEarnings };
}
