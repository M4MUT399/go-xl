// nav/arrival — GEOFENCE de chegada (Feature F5), núcleo puro e testável.
//
// Detecta quando o motorista chega ao alvo da fase corrente (embarque na fase
// pickup, destino na fase dropoff) para a UI destacar a ação ("Cheguei" /
// "Finalizar") no momento certo, sem depender de o motorista adivinhar a
// distância. Não BLOQUEIA a ação manual — só sinaliza chegada.
//
// Duas sutilezas de GPS que este núcleo trata:
//   1) HISTERESE: entra em "chegou" a `enterM` (≈50 m) e só sai acima de `exitM`
//      (≈80 m). Sem isso o estado piscaria com o jitter do GPS parado.
//   2) Determinístico: recebe a distância (ou os pontos) por parâmetro → testável
//      sem GPS.

import { haversineMeters, type LatLngLite } from './geo';

/** Raio de entrada/saída do geofence de chegada (m). */
export interface ArrivalConfig {
  /** Distância que DECLARA a chegada (≤ enterM → chegou). */
  enterM: number;
  /** Distância que CANCELA a chegada (> exitM → deixou de estar chegado). */
  exitM: number;
}

/** ~50 m para declarar chegada, ~80 m para cancelar (histerese anti-jitter). */
export const DEFAULT_ARRIVAL: ArrivalConfig = { enterM: 50, exitM: 80 };

export interface ArrivalState {
  /** Está dentro do geofence de chegada (com histerese aplicada). */
  arrived: boolean;
}

export const initialArrivalState: ArrivalState = { arrived: false };

export interface ArrivalResult {
  state: ArrivalState;
  /** Chegada confirmada (com histerese). */
  arrived: boolean;
  /** Distância (m) usada na decisão. */
  distanceM: number;
  /** true SÓ na transição não-chegou → chegou (borda de subida, para efeitos). */
  justArrived: boolean;
}

/**
 * Atualiza o estado de chegada a partir da distância ao alvo.
 *   • não-chegado e `distanceM ≤ enterM` → passa a chegado (justArrived=true);
 *   • chegado e `distanceM > exitM`      → volta a não-chegado;
 *   • caso contrário                     → mantém o estado (zona de histerese).
 */
export function updateArrival(
  state: ArrivalState,
  distanceM: number,
  cfg: ArrivalConfig = DEFAULT_ARRIVAL,
): ArrivalResult {
  let arrived = state.arrived;
  let justArrived = false;

  if (!arrived && distanceM <= cfg.enterM) {
    arrived = true;
    justArrived = true;
  } else if (arrived && distanceM > cfg.exitM) {
    arrived = false;
  }

  return { state: { arrived }, arrived, distanceM, justArrived };
}

/**
 * Conveniência: mesma decisão a partir dos pontos (calcula a distância por
 * haversine). Alvo `null` (ainda sem posição/rota) → mantém o estado, distância
 * infinita, sem chegada.
 */
export function updateArrivalAt(
  state: ArrivalState,
  point: LatLngLite | null,
  target: LatLngLite | null,
  cfg: ArrivalConfig = DEFAULT_ARRIVAL,
): ArrivalResult {
  if (!point || !target) {
    return { state, arrived: state.arrived, distanceM: Infinity, justArrived: false };
  }
  return updateArrival(state, haversineMeters(point, target), cfg);
}
