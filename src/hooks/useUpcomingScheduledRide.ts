import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { getConfig, getConfigDefault } from '../lib/systemConfig';
import { minutesUntil, shouldShowBanner, isImminent, pickSoonest } from '../lib/scheduledRides';
import type { RideRecord } from '../types';

export type UpcomingScheduled = {
  /** Corrida agendada confirmada por mim mais próxima, ou null. */
  ride: RideRecord | null;
  /** Minutos até o horário (arredondável na UI). */
  minutesUntil: number;
  /** Deve renderizar o banner fixo? */
  showBanner: boolean;
  /** Já é iminente? (destaque de urgência + alerta sonoro). */
  imminent: boolean;
};

const EMPTY: UpcomingScheduled = { ride: null, minutesUntil: Infinity, showBanner: false, imminent: false };

/**
 * useUpcomingScheduledRide — observa a corrida agendada mais próxima que
 * pertence ao usuário e devolve o estado do banner fixo (P2). Compartilhado:
 *   • role='driver'    → agendadas que o motorista confirmou (driver_id = eu).
 *   • role='passenger' → agendadas que o passageiro marcou (passenger_id = eu),
 *                        com ou sem motorista já atribuído.
 *
 * A cada 30s (e a cada mudança realtime) recalcula a contagem regressiva. As
 * janelas de "mostrar banner" e "iminente" vêm de system_config (configurável
 * por jurisdição), com fallback local seguro.
 */
export function useUpcomingScheduledRide(
  userId: string | undefined,
  role: 'driver' | 'passenger' = 'driver',
): UpcomingScheduled {
  const [rides, setRides] = useState<RideRecord[]>([]);
  const [cfg, setCfg] = useState({
    banner: getConfigDefault('scheduled_ride_banner_minutes'),
    reminder: getConfigDefault('scheduled_ride_reminder_minutes'),
  });
  const [, forceTick] = useState(0);
  const channelId = useRef(Math.random().toString(36).slice(2)).current;

  const refresh = useCallback(async () => {
    if (!userId) {
      setRides([]);
      return;
    }
    // Coluna de propriedade conforme o papel: motorista vê as agendadas que ELE
    // confirmou; passageiro vê as que ELE marcou (com ou sem motorista ainda).
    const ownerColumn = role === 'driver' ? 'driver_id' : 'passenger_id';
    const { data } = await supabase
      .from('rides')
      .select('*')
      .eq('status', 'scheduled')
      .eq(ownerColumn, userId)
      .order('scheduled_for', { ascending: true });
    setRides((data as RideRecord[]) ?? []);
  }, [userId, role]);

  // Carrega as janelas configuráveis (uma vez; cache de 60s no getConfig).
  useEffect(() => {
    let alive = true;
    Promise.all([
      getConfig('scheduled_ride_banner_minutes'),
      getConfig('scheduled_ride_reminder_minutes'),
    ]).then(([banner, reminder]) => {
      if (alive) setCfg({ banner, reminder });
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Tick de 30s: reavalia a contagem regressiva sem refazer a query.
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  // Realtime: recarrega quando qualquer agendada muda (confirmação, release, etc.).
  useEffect(() => {
    if (!userId) return;
    const channel = supabase
      .channel(`${role}-upcoming-${userId}-${channelId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rides', filter: 'status=eq.scheduled' }, () => {
        refresh();
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [userId, role, refresh, channelId]);

  const now = new Date();
  const ride = pickSoonest(rides, now);
  if (!ride) return EMPTY;

  const mins = minutesUntil(ride.scheduled_for, now);
  return {
    ride,
    minutesUntil: mins,
    showBanner: shouldShowBanner(mins, cfg.banner),
    imminent: isImminent(mins, cfg.reminder),
  };
}
