import { useEffect, useRef, useState } from 'react';
import {
  makeEtaBaseline,
  projectEtaSeconds,
  etaSecondsToMinutes,
  arrivalDate,
  type EtaBaseline,
} from '../lib/nav/etaTracker';

export interface DynamicEta {
  /** Minutos restantes para exibição (arred. p/ cima, mín. 1; 0 = chegou). */
  etaMin: number | null;
  /** Segundos restantes (para lógicas finas, ex. barra de progresso). */
  etaSeconds: number | null;
  /** Horário de chegada previsto (agora + restante). */
  arrival: Date | null;
}

export interface UseDynamicEtaOptions {
  /** Veículo parado (velocidade ~0): congela o decremento (B3). */
  stopped?: boolean;
  /** Período do tick de reprojeção, ms (default 1000). */
  tickMs?: number;
}

/**
 * ETA DINÂMICO (Bug B3): recebe o ETA em minutos vindo da rota (recalculada a
 * cada ~45 s / a cada reroute) e faz o número DECRESCER com o tempo real entre
 * recálculos, congelando quando o veículo está parado. Uma nova `routeEtaMin`
 * (mudou de valor) reinicia a baseline — o ETA "respira" de volta com o
 * trânsito atualizado; entre atualizações, apenas decai.
 *
 * Puro por baixo (etaTracker); aqui só orquestramos baseline + tick de 1 s.
 */
export function useDynamicEta(
  routeEtaMin: number | null | undefined,
  opts: UseDynamicEtaOptions = {},
): DynamicEta {
  const { stopped = false, tickMs = 1000 } = opts;
  const baselineRef = useRef<EtaBaseline | null>(null);

  // Nova rota/ETA → nova baseline. Comparamos o valor bruto: quando a rota é
  // recomputada (mesmo que caia no mesmo minuto), o efeito reancorar não muda o
  // que o usuário vê, mas mantém o relógio honesto.
  const [, forceTick] = useState(0);
  useEffect(() => {
    baselineRef.current = makeEtaBaseline(routeEtaMin, Date.now());
    forceTick((n) => n + 1);
  }, [routeEtaMin]);

  // Tick de reprojeção. Um único intervalo; `stopped` entra na projeção.
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), tickMs);
    return () => clearInterval(id);
  }, [tickMs]);

  const now = Date.now();
  const etaSeconds = projectEtaSeconds(baselineRef.current, now, { stopped });
  return {
    etaMin: etaSecondsToMinutes(etaSeconds),
    etaSeconds,
    arrival: arrivalDate(now, etaSeconds),
  };
}
