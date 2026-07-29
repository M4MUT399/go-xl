import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { reportWarning } from '../lib/errorReporting';
import {
  overallScore,
  scoreCategory,
  type ScoreCategory,
} from '../lib/telematics/scorer';
import { computeChallenges, type ChallengesResult } from '../lib/telematics/challenges';

/** Uma sessão de telemetria (linha de driver_trip_sessions). */
export interface TripSession {
  id: string;
  ride_id: string | null;
  started_at: string;
  ended_at: string | null;
  distance_km: number;
  duration_min: number;
  score: number;
  speeding_count: number;
  hard_brake_count: number;
  hard_accel_count: number;
  hard_corner_count: number;
  sample_count: number;
}

/** Janela do "últimas N viagens" que compõe a nota geral (como a Uber). */
export const SCORE_WINDOW = 50;

export interface TelematicsData {
  sessions: TripSession[];
  loading: boolean;
  /** Nota geral 0–100 (últimas 50, ponderada por distância) ou null se sem dados. */
  overall: number | null;
  category: ScoreCategory | null;
  /** Nº de viagens que entram na nota (min(sessões, 50)). */
  scoringCount: number;
  challenges: ChallengesResult;
  reload: () => void;
}

/**
 * useTelematics — lê o histórico de telemetria do motorista e deriva a nota
 * geral, a categoria e os desafios (tudo com os módulos PUROS de lib/telematics,
 * já testados). O RLS garante que só vêm as linhas do próprio motorista.
 */
export function useTelematics(driverId: string | undefined): TelematicsData {
  const [sessions, setSessions] = useState<TripSession[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!driverId) {
      setSessions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('driver_trip_sessions')
        .select('*')
        .eq('driver_id', driverId)
        .not('ended_at', 'is', null)
        .order('ended_at', { ascending: false })
        .limit(200);
      if (error) reportWarning(error, { scope: 'telematics.load' });
      setSessions((data as TripSession[] | null) ?? []);
    } catch (e) {
      reportWarning(e, { scope: 'telematics.load' });
      setSessions([]);
    } finally {
      setLoading(false);
    }
  }, [driverId]);

  useEffect(() => {
    load();
  }, [load]);

  const overall = useMemo(() => overallScore(sessions, SCORE_WINDOW), [sessions]);
  const category = overall != null ? scoreCategory(overall) : null;
  const scoringCount = Math.min(sessions.length, SCORE_WINDOW);
  const challenges = useMemo(() => computeChallenges(sessions), [sessions]);

  return { sessions, loading, overall, category, scoringCount, challenges, reload: load };
}
