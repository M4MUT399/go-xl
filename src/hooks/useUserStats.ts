import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { UserType } from '../types';

export interface UserStats {
  rating: number;
  ratingCount: number;
  totalRides: number;
}

/**
 * Calcula estatísticas reais do usuário:
 * - rating: média das avaliações recebidas (ratings.to_user = userId)
 * - totalRides: corridas concluídas (como motorista ou passageiro)
 * O usuário só lê os próprios dados (RLS permite ver as próprias avaliações e corridas).
 */
export function useUserStats(userId: string | undefined, userType: UserType) {
  const [stats, setStats] = useState<UserStats>({ rating: 5, ratingCount: 0, totalRides: 0 });

  const refresh = useCallback(async () => {
    if (!userId) return;

    const rideColumn = userType === 'driver' ? 'driver_id' : 'passenger_id';
    const [ridesRes, ratingsRes] = await Promise.all([
      supabase
        .from('rides')
        .select('id', { count: 'exact', head: true })
        .eq(rideColumn, userId)
        .eq('status', 'completed'),
      supabase.from('ratings').select('score').eq('to_user', userId),
    ]);

    const scores = ((ratingsRes.data as { score: number }[]) ?? []).map((r) => r.score);
    const rating = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 5;

    setStats({
      rating,
      ratingCount: scores.length,
      totalRides: ridesRes.count ?? 0,
    });
  }, [userId, userType]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { stats, refresh };
}
