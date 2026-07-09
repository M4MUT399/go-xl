import { useEffect, useMemo, useRef, useState } from 'react';
import type { IdleSegment } from '../lib/drivingLimits';

// Velocidade (m/s) abaixo da qual consideramos o veículo PARADO. ~1 m/s = 3,6
// km/h: filtra o jitter do GPS (que oscila alguns décimos mesmo parado) sem
// exigir arranque real. Acima disso, "em movimento".
const MOVING_SPEED_MPS = 1.0;

/**
 * useDutyIdleTracker — observa a velocidade do veículo e produz os "segmentos
 * ociosos" (períodos parado) do turno atual, para alimentar computeDutyStatus
 * (item 1: a contagem de direção só corre com o veículo em movimento).
 *
 * Onde mora: no DriverRideContext (Provider global, nunca desmontado), porque o
 * motorista se move sobretudo DURANTE a corrida (tela de Navegação) — um tracker
 * preso à Home perderia justamente o movimento que mais importa.
 *
 * Persistência: só em memória. Se o app for reiniciado no meio do turno, a
 * ociosidade acumulada se perde e o tempo passa a contar como direção — o lado
 * SEGURO (sobrecontar só antecipa o descanso), coerente com o resto do módulo.
 *
 * `active` = motorista online. Ao ficar offline, o turno encerra e os segmentos
 * são zerados (novo turno começa limpo quando voltar a ficar online).
 *
 * @param active  true enquanto o motorista está online (sessão de serviço aberta).
 * @param speed   velocidade atual em m/s (undefined = leitura desconhecida).
 * @returns lista de segmentos ociosos; o segmento em curso tem `end: null`.
 */
export function useDutyIdleTracker(active: boolean, speed: number | undefined): IdleSegment[] {
  // Paradas já encerradas neste turno.
  const [completed, setCompleted] = useState<IdleSegment[]>([]);
  // Início (ISO) da parada em curso, ou null se em movimento/desconhecido.
  const [stopStart, setStopStart] = useState<string | null>(null);
  // Espelhos em ref para ler o estado atual dentro do efeito sem recriá-lo.
  const stopStartRef = useRef<string | null>(null);
  stopStartRef.current = stopStart;

  // Zera tudo ao sair do ar (fim do turno).
  useEffect(() => {
    if (!active) {
      setCompleted((prev) => (prev.length ? [] : prev));
      setStopStart((prev) => (prev == null ? prev : null));
    }
  }, [active]);

  // Reage às transições de velocidade enquanto online.
  useEffect(() => {
    if (!active) return;

    // Velocidade desconhecida → assume "em movimento" (não inicia parada; lado
    // seguro = contar como direção). Só uma leitura VÁLIDA e baixa marca parada.
    const stopped = typeof speed === 'number' && speed >= 0 && speed < MOVING_SPEED_MPS;
    const nowIso = new Date().toISOString();

    if (stopped) {
      // Entrou em parada: registra o início (uma vez).
      if (stopStartRef.current == null) setStopStart(nowIso);
    } else {
      // Voltou a se mover: encerra a parada em curso, se houver.
      const start = stopStartRef.current;
      if (start != null) {
        setStopStart(null);
        setCompleted((prev) => [...prev, { start, end: nowIso }]);
      }
    }
  }, [active, speed]);

  // Segmentos = encerrados + (parada em curso, se houver, com end null → "agora").
  return useMemo(
    () => (stopStart ? [...completed, { start: stopStart, end: null }] : completed),
    [completed, stopStart]
  );
}
