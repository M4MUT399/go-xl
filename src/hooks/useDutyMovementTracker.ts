import { useEffect, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';
import { useFeatureFlag } from './useFeatureFlag';
import { getConfig } from '../lib/systemConfig';
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
 * ─── POR QUE O HOOK RECEBE O FIX INTEIRO, E NÃO SÓ `speed` ──────────────────
 * `useLocation` devolve um OBJETO NOVO a cada leitura do GPS e NUNCA volta a
 * `null` quando os fixes param de chegar (useLocation.ts:26,124-141): a
 * velocidade do último fix fica no ar indefinidamente. Recebendo só o número, o
 * hook não tinha como distinguir "andando a 54 km/h agora" de "o último fix foi
 * há três horas" — e alimentava a máquina com a velocidade velha, que credita o
 * intervalo inteiro como jornada. App minimizado, tela bloqueada ou GPS morto
 * viravam horas de direção que nunca aconteceram, e o descanso obrigatório caía
 * sobre quem estava parado. É a IDENTIDADE do objeto que marca "chegou fix
 * novo"; daí o carimbo de frescor abaixo e o `speedAtMs` mandado à máquina.
 *
 * @param driverId  id do motorista (chaveia a persistência; sem id → no-op).
 * @param active    true enquanto o motorista está online.
 * @param fix       último fix de GPS (objeto novo por leitura); null = sem leitura.
 * @returns { enabled, workedMinutes } — minutos de trabalho acumulados (0 se sem dado).
 */
export function useDutyMovementTracker(
  driverId: string | undefined,
  active: boolean,
  fix: { speed?: number } | null | undefined,
): { enabled: boolean; workedMinutes: number } {
  const enabled = useFeatureFlag('duty_movement_v2_enabled');

  const [minutes, setMinutes] = useState(0);

  // Estado vivo (ref) — o efeito de sample lê/escreve sem se recriar.
  const machineRef = useRef<DutyMachine | null>(null);
  // Política do APP: TOLERÂNCIA ZERO. A hora trabalhada só conta com o veículo
  // EM MOVIMENTO; assim que o GPS para, a contagem é suspensa (sem os 10 min de
  // tolerância da lib). A máquina pura continua parametrizável (o default de 10
  // min segue existindo p/ outras jurisdições), mas aqui forçamos toleranceMs=0.
  //
  // E TOLERÂNCIA ZERO DE PROVA VENCIDA: a velocidade só vale como prova de
  // movimento por `speedMaxAgeMs`. O watch entrega fix a cada 5 s
  // (useLocation.ts:113-115) e este hook reavalia a cada 60 s, então 90 s
  // absorve um tick inteiro mais folga sem nunca congelar quem está rodando com
  // GPS vivo — e corta em 90 s, no pior caso, o que antes era ilimitado.
  const cfgRef = useRef<DutyMovementConfig>({
    ...DEFAULT_DUTY_MOVEMENT,
    toleranceMs: 0,
    toleranceCountsAsWork: false,
    speedMaxAgeMs: 90_000,
  });
  const loadedRef = useRef(false);
  // Espelhos dos inputs para o tick de 60s reavaliar sem depender deles.
  const activeRef = useRef(active);
  activeRef.current = active;
  const speedRef = useRef(fix?.speed);
  speedRef.current = fix?.speed;
  // Carimbo de FRESCOR: quando ESTE fix chegou. Fica em ref porque o tick de 60s
  // precisa lê-lo sem se recriar. Declarado ANTES do efeito de sample de
  // propósito — efeitos rodam na ordem de declaração, então o carimbo já está
  // atualizado quando o sample daquele mesmo fix é aplicado.
  const fixAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (fix) fixAtRef.current = Date.now();
  }, [fix]);

  const storageKey = driverId ? `duty_movement_v2:${driverId}` : null;
  // Guarda o "token de reset" já aplicado neste aparelho. Quando o token vigente
  // (config `duty_movement_reset_token`) difere, ZERAMOS a jornada persistida —
  // é a alavanca para LIMPAR bloqueios de descanso presos em campo (bumpar o
  // valor no system_config limpa todos os aparelhos no próximo boot). O próprio
  // valor default já muda com este build, então instalações antigas (sem token
  // gravado) são limpas na primeira abertura.
  const tokenKey = driverId ? `duty_movement_v2_reset:${driverId}` : null;

  // Nota: a máquina usa DEFAULT_DUTY_MOVEMENT (100% parametrizável via
  // DutyMovementConfig). Quando quisermos ajustar limiar/histerese por
  // jurisdição, basta expor as chaves no system_config e preencher cfgRef aqui —
  // sem tocar na lógica pura da máquina.

  // Reconstrói o estado persistido ao (re)habilitar/trocar de motorista.
  useEffect(() => {
    if (!enabled || !storageKey || !tokenKey) {
      machineRef.current = null;
      loadedRef.current = false;
      setMinutes(0);
      return;
    }
    let alive = true;
    loadedRef.current = false;
    (async () => {
      // Gatilho de reset (versão/remoto): se o token vigente difere do já
      // aplicado neste aparelho, começa uma jornada NOVA (zera o acumulador) e
      // grava o token — limpa qualquer bloqueio de descanso preso.
      const currentToken = String(await getConfig('duty_movement_reset_token'));
      const [raw, storedToken] = await Promise.all([
        AsyncStorage.getItem(storageKey),
        AsyncStorage.getItem(tokenKey),
      ]);
      if (!alive) return;
      if (storedToken !== currentToken) {
        machineRef.current = initialDutyMachine(Date.now());
        await AsyncStorage.multiSet([
          [storageKey, serializeDuty(machineRef.current)],
          [tokenKey, currentToken],
        ]);
      } else {
        machineRef.current = deserializeDuty(raw) ?? initialDutyMachine(Date.now());
      }
      loadedRef.current = true;
      setMinutes(computeWorkedMinutes(machineRef.current, Date.now(), cfgRef.current));
    })().catch(() => {
      if (!alive) return;
      machineRef.current = initialDutyMachine(Date.now());
      loadedRef.current = true;
    });
    return () => {
      alive = false;
    };
  }, [enabled, storageKey, tokenKey]);

  // Aplica um sample à máquina: avança estado, persiste e emite a transição.
  const applySample = useRef<(atMs: number) => void>(() => {});
  applySample.current = (atMs: number) => {
    if (!enabled || !storageKey || !loadedRef.current || !machineRef.current) return;
    const cfg = cfgRef.current;
    const sampleSpeed = speedRef.current;
    const { machine, transitions } = stepDuty(
      machineRef.current,
      {
        atMs,
        speedMps: typeof sampleSpeed === 'number' ? sampleSpeed : null,
        speedAtMs: fixAtRef.current,
        online: activeRef.current,
      },
      cfg,
    );
    machineRef.current = machine;
    setMinutes(computeWorkedMinutes(machine, atMs, cfg));
    // Persiste SEMPRE (o próximo boot reconstrói a partir daqui).
    AsyncStorage.setItem(storageKey, serializeDuty(machine)).catch(() => {});
    // Um passo pode emitir DUAS linhas (o buraco na prova e a mudança de estado
    // que veio junto) — ver `transitions` em dutyMovement.ts. Os minutos são os
    // mesmos para as duas de propósito: o corte credita até o horizonte da prova
    // e joga `since` para `atMs`, então nada mais acumula entre um evento e o
    // outro dentro do mesmo passo.
    if (transitions.length) {
      const minutos = computeWorkedMinutes(machine, atMs, cfg);
      for (const t of transitions) emitTransition(driverId as string, t, minutos);
    }
  };

  // Dispara um sample a cada FIX novo ou mudança de online (as bordas que a
  // histerese precisa ver) enquanto habilitado. A dependência é o objeto do fix,
  // não `speed`: dois fixes consecutivos com a MESMA velocidade são dois fixes,
  // e depender do número fazia o segundo passar despercebido.
  useEffect(() => {
    if (!enabled) return;
    applySample.current(Date.now());
  }, [enabled, active, fix]);

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
