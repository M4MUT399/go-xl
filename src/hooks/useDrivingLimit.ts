import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { getConfig, getConfigDefault } from '../lib/systemConfig';
import { reportWarning } from '../lib/errorReporting';
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
  movementMinutes: number | null = null,
  /**
   * Estado local (fonte da verdade da UI) do toggle online/offline. Usado só
   * para AUTO-RECONCILIAR uma `driver_duty_sessions` presa aberta (ex.:
   * `endSession()` falhou por rede e o app já mostra "Offline" na tela) — sem
   * isso, `computeDutyStatus` continua vendo `online: true` e recalculando
   * `lastDutyEnd`/`restUntil` como "agora" a cada tick, então o tempo OFFLINE
   * nunca chega a contar como descanso. `undefined` → reconciliação desligada
   * (comportamento antigo), para não quebrar quem ainda não passa esse arg.
   */
  isOnline?: boolean
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
    const { data: open, error: selectError } = await supabase
      .from('driver_duty_sessions')
      .select('id')
      .eq('driver_id', driverId)
      .is('ended_at', null)
      .limit(1);
    if (selectError) reportWarning(selectError, { scope: 'useDrivingLimit.startSession.select', driverId });
    if (!open || open.length === 0) {
      const { error: insertError } = await supabase.from('driver_duty_sessions').insert({ driver_id: driverId });
      if (insertError) reportWarning(insertError, { scope: 'useDrivingLimit.startSession.insert', driverId });
    }
    await refresh();
  }, [driverId, refresh]);

  // Fecha a sessão aberta. Não pode falhar em silêncio: uma sessão que fica
  // presa aberta (ex.: hiccup de rede) faz `computeDutyStatus` continuar
  // achando o motorista "online" mesmo com a tela mostrando "Offline" — o
  // tempo realmente offline nunca conta como descanso e o banner de descanso
  // obrigatório não se resolve. Por isso: loga a falha e tenta 1x de novo
  // antes de desistir (a reconciliação abaixo cobre o resto).
  const endSession = useCallback(async () => {
    if (!driverId) return;
    const attempt = () =>
      supabase
        .from('driver_duty_sessions')
        .update({ ended_at: new Date().toISOString() })
        .eq('driver_id', driverId)
        .is('ended_at', null);
    const { error } = await attempt();
    if (error) {
      reportWarning(error, { scope: 'useDrivingLimit.endSession', driverId });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const retry = await attempt();
      if (retry.error) reportWarning(retry.error, { scope: 'useDrivingLimit.endSession.retry', driverId });
    }
    await refresh();
  }, [driverId, refresh]);

  // Auto-reconciliação: se a UI já sabe que o motorista está OFFLINE
  // (`isOnline === false`, passado pelo chamador) mas ainda existe uma sessão
  // aberta em `sessions` (ex.: `endSession()` falhou antes, ou o app foi morto
  // com a sessão aberta), fecha essa sessão órfã. Sem isso, `online` nunca
  // volta a `false` em `computeDutyStatus` e o offline real não é contado como
  // descanso. `isOnline === undefined` → chamador não optou por essa checagem,
  // não reconcilia (evita comportamento surpresa para quem ainda não passa o arg).
  const lastReconcileAttemptRef = useRef(0);
  useEffect(() => {
    if (isOnline !== false) return;
    const hasOpenSession = sessions.some((s) => !s.ended_at);
    if (!hasOpenSession) return;
    const now = Date.now();
    // Não repete a cada re-render/tick — só re-tenta após 30s se ainda presa.
    if (now - lastReconcileAttemptRef.current < 30_000) return;
    lastReconcileAttemptRef.current = now;
    endSession();
  }, [isOnline, sessions, endSession]);

  const status = computeDutyStatus(sessions, cfg, new Date(), idleSegments, movementMinutes);
  const warn = status.online && !status.mustRest && status.remainingMinutes <= warnMinutes;

  return { status, warnMinutes, warn, startSession, endSession, refresh };
}
