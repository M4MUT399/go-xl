import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { getConfig, getConfigDefault } from '../lib/systemConfig';
import { computeDutyStatus, type DutySession, type DutyStatus, type IdleSegment } from '../lib/drivingLimits';

// Carrega sessões das últimas 48h — suficiente para cobrir 12h de direção +
// 6h de descanso e o cálculo de reset de turno com folga.
const LOOKBACK_MS = 48 * 60 * 60 * 1000;

export type DrivingLimit = {
  status: DutyStatus;
  /** Minutos de antecedência do limite em que o motorista é avisado. */
  warnMinutes: number;
  /** Online e perto do limite (mas ainda não estourou). */
  warn: boolean;
  /** Abre uma sessão de serviço (idempotente: não duplica sessão aberta). */
  startSession: () => Promise<void>;
  /** Fecha a sessão aberta do motorista. */
  endSession: () => Promise<void>;
  refresh: () => Promise<void>;
};

/**
 * useDrivingLimit — acompanha o limite de direção configurável do motorista (P3)
 * a partir de driver_duty_sessions e devolve o status calculado + ações para
 * abrir/fechar sessão. Recalcula a cada 60s (contagem regressiva viva) e a cada
 * mudança realtime nas sessões.
 */
export function useDrivingLimit(
  driverId: string | undefined,
  idleSegments: IdleSegment[] = [],
  /**
   * Bloco 2: minutos de direção pela máquina por MOVIMENTO. Quando um número
   * (flag `duty_movement_v2_enabled` ligada), vira a fonte autoritativa do
   * acúmulo; `null`/ausente → mantém o cálculo v1 (sessão − ociosidade).
   */
  movementMinutes: number | null = null
): DrivingLimit {
  const [sessions, setSessions] = useState<DutySession[]>([]);
  const [cfg, setCfg] = useState({
    limitHours: getConfigDefault('driving_limit_hours'),
    restHours: getConfigDefault('rest_required_hours'),
    idlePauseMinutes: getConfigDefault('duty_idle_pause_minutes'),
  });
  const [warnMinutes, setWarnMinutes] = useState<number>(getConfigDefault('driving_warn_minutes'));
  const [, tick] = useState(0);
  const channelId = useRef(Math.random().toString(36).slice(2)).current;

  const refresh = useCallback(async () => {
    if (!driverId) {
      setSessions([]);
      return;
    }
    const since = new Date(Date.now() - LOOKBACK_MS).toISOString();
    const { data } = await supabase
      .from('driver_duty_sessions')
      .select('started_at, ended_at')
      .eq('driver_id', driverId)
      .gte('started_at', since)
      .order('started_at', { ascending: true });
    setSessions((data as DutySession[]) ?? []);
  }, [driverId]);

  // Carrega as regras configuráveis (uma vez; getConfig tem cache de 60s).
  useEffect(() => {
    let alive = true;
    Promise.all([
      getConfig('driving_limit_hours'),
      getConfig('rest_required_hours'),
      getConfig('driving_warn_minutes'),
      getConfig('duty_idle_pause_minutes'),
    ]).then(([limitHours, restHours, warn, idlePauseMinutes]) => {
      if (!alive) return;
      setCfg({ limitHours, restHours, idlePauseMinutes });
      setWarnMinutes(warn);
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Tick de 60s: recalcula a contagem regressiva sem refazer a query.
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  // Realtime: recarrega quando as sessões deste motorista mudam.
  useEffect(() => {
    if (!driverId) return;
    const channel = supabase
      .channel(`duty-${driverId}-${channelId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'driver_duty_sessions', filter: `driver_id=eq.${driverId}` }, () => {
        refresh();
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [driverId, refresh, channelId]);

  const startSession = useCallback(async () => {
    if (!driverId) return;
    // Não duplica: se já houver sessão aberta, apenas garante o estado atualizado.
    const { data: open } = await supabase
      .from('driver_duty_sessions')
      .select('id')
      .eq('driver_id', driverId)
      .is('ended_at', null)
      .limit(1);
    if (!open || open.length === 0) {
      await supabase.from('driver_duty_sessions').insert({ driver_id: driverId });
    }
    await refresh();
  }, [driverId, refresh]);

  const endSession = useCallback(async () => {
    if (!driverId) return;
    await supabase
      .from('driver_duty_sessions')
      .update({ ended_at: new Date().toISOString() })
      .eq('driver_id', driverId)
      .is('ended_at', null);
    await refresh();
  }, [driverId, refresh]);

  const status = computeDutyStatus(sessions, cfg, new Date(), idleSegments, movementMinutes);
  const warn = status.online && !status.mustRest && status.remainingMinutes <= warnMinutes;

  return { status, warnMinutes, warn, startSession, endSession, refresh };
}
