import { useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';
import { useFeatureFlag } from './useFeatureFlag';
import { reportWarning } from '../lib/errorReporting';
import {
  DEFAULT_DUTY_MOVEMENT,
  deserializeDuty,
  initialDutyMachine,
  serializeDuty,
  stepDuty,
  workedMinutes as computeWorkedMinutes,
  type DutyMachine,
  type DutyMovementConfig,
  type DutyTransition,
} from '../lib/dutyMovement';

/**
 * useDutyMovementTracker — integração da máquina de estados PURA de jornada por
 * movimento (Bloco 2, ver src/lib/dutyMovement.ts) ao app do motorista.
 *
 * Responsabilidades (a lógica de decisão fica toda no módulo puro):
 *   1. Alimenta a máquina com samples (velocidade + online + horário epoch).
 *   2. PERSISTE o estado no AsyncStorage a cada passo (chave por motorista) e o
 *      RECONSTRÓI ao reabrir — como todo limite é por timestamp, basta mandar o
 *      próximo sample com o horário atual para reproduzir o resultado (sobrevive
 *      a kill/reboot/background/troca de fuso).
 *   3. Emite cada TRANSIÇÃO para a trilha de auditoria no backend
 *      (driver_duty_movement_events), append-only.
 *
 * Rollout: guardado por `duty_movement_v2_enabled` (DESLIGADO por padrão). Com a
 * flag off o hook é no-op — não roda a máquina, não persiste, não emite —
 * mantendo intacto o tracker de ociosidade v1 (useDutyIdleTracker).
 *
 * Onde mora: no DriverRideContext (Provider global), pelo mesmo motivo do v1 — o
 * movimento que mais importa acontece DURANTE a corrida (tela de Navegação).
 *
 * @param driverId  id do motorista (chaveia a persistência; sem id → no-op).
 * @param active    true enquanto o motorista está online.
 * @param speed     velocidade atual em m/s (undefined = leitura ausente → UNKNOWN).
 * @returns { enabled, workedMinutes } — minutos de trabalho acumulados (0 se sem dado).
 */
export function useDutyMovementTracker(
  driverId: string | undefined,
  active: boolean,
  speed: number | undefined,
): { enabled: boolean; workedMinutes: number } {
  const enabled = useFeatureFlag('duty_movement_v2_enabled');

  const [minutes, setMinutes] = useState(0);

  // Estado vivo (ref) — o efeito de sample lê/escreve sem se recriar.
  const machineRef = useRef<DutyMachine | null>(null);
  const cfgRef = useRef<DutyMovementConfig>(DEFAULT_DUTY_MOVEMENT);
  const loadedRef = useRef(false);
  // Espelhos dos inputs para o tick de 60s reavaliar sem depender deles.
  const activeRef = useRef(active);
  activeRef.current = active;
  const speedRef = useRef(speed);
  speedRef.current = speed;

  const storageKey = driverId ? `duty_movement_v2:${driverId}` : null;

  // Nota: a máquina usa DEFAULT_DUTY_MOVEMENT (100% parametrizável via
  // DutyMovementConfig). Quando quisermos ajustar limiar/histerese por
  // jurisdição, basta expor as chaves no system_config e preencher cfgRef aqui —
  // sem tocar na lógica pura da máquina.

  // Reconstrói o estado persistido ao (re)habilitar/trocar de motorista.
  useEffect(() => {
    if (!enabled || !storageKey) {
      machineRef.current = null;
      loadedRef.current = false;
      setMinutes(0);
      return;
    }
    let alive = true;
    loadedRef.current = false;
    AsyncStorage.getItem(storageKey)
      .then((raw) => {
        if (!alive) return;
        machineRef.current = deserializeDuty(raw) ?? initialDutyMachine(Date.now());
        loadedRef.current = true;
        setMinutes(computeWorkedMinutes(machineRef.current, Date.now(), cfgRef.current));
      })
      .catch(() => {
        if (!alive) return;
        machineRef.current = initialDutyMachine(Date.now());
        loadedRef.current = true;
      });
    return () => {
      alive = false;
    };
  }, [enabled, storageKey]);

  // Aplica um sample à máquina: avança estado, persiste e emite a transição.
  const applySample = useRef<(atMs: number) => void>(() => {});
  applySample.current = (atMs: number) => {
    if (!enabled || !storageKey || !loadedRef.current || !machineRef.current) return;
    const cfg = cfgRef.current;
    const sampleSpeed = speedRef.current;
    const { machine, transition } = stepDuty(
      machineRef.current,
      { atMs, speedMps: typeof sampleSpeed === 'number' ? sampleSpeed : null, online: activeRef.current },
      cfg,
    );
    machineRef.current = machine;
    setMinutes(computeWorkedMinutes(machine, atMs, cfg));
    // Persiste SEMPRE (o próximo boot reconstrói a partir daqui).
    AsyncStorage.setItem(storageKey, serializeDuty(machine)).catch(() => {});
    if (transition) emitTransition(driverId as string, transition, computeWorkedMinutes(machine, atMs, cfg));
  };

  // Dispara um sample a cada mudança de velocidade/online (as bordas que a
  // histerese precisa ver) enquanto habilitado.
  useEffect(() => {
    if (!enabled) return;
    applySample.current(Date.now());
  }, [enabled, active, speed]);

  // Tick de 60s: mesmo sem novo fix, reavalia limites por timestamp (ex.: cruzar
  // os 10 min de tolerância ou as 6 h de reset) e atualiza os minutos exibidos.
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => applySample.current(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [enabled]);

  return { enabled, workedMinutes: minutes };
}

/** Emite (append-only) uma transição à trilha de auditoria; falha em silêncio. */
function emitTransition(driverId: string, t: DutyTransition, workedMin: number): void {
  supabase
    .from('driver_duty_movement_events')
    .insert({
      driver_id: driverId,
      from_state: t.from,
      to_state: t.to,
      reason: t.reason,
      at_ms: t.atMs,
      worked_minutes: Number.isFinite(workedMin) ? Math.round(workedMin * 100) / 100 : null,
    })
    .then(({ error }: { error: unknown }) => {
      if (error) reportWarning(error, { scope: 'dutyMovement.audit', reason: t.reason });
    });
}
