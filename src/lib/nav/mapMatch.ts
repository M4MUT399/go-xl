// nav/mapMatch — MAP-MATCHING ROBUSTO (Feature F3), núcleo puro e testável.
//
// Cola a posição do GPS na rota de forma estável, resolvendo três problemas do
// snap ingênuo (nearestPointOnPath global):
//
//   1) SALTO PARA TRÁS em rotas que se cruzam/voltam (ex.: alça de retorno na
//      I-4): o ponto global mais próximo pode cair num trecho JÁ percorrido.
//      Solução: JANELA MONOTÔNICA à frente — só consideramos segmentos de
//      `state.index` em diante; o índice nunca regride na mesma rota.
//
//   2) AMBIGUIDADE em vias paralelas próximas (rodovia + via marginal): a
//      distância sozinha escolhe a via errada. Solução: SCORE COMPOSTO
//      distância + desacordo de rumo (o segmento cujo bearing casa com o curso
//      do veículo ganha).
//
//   3) FALSO "fora da rota" por um único fix ruim. Solução: HISTERESE POR
//      CONTAGEM — só declara off-route após N leituras consecutivas fora do
//      corredor (e volta a on-route no primeiro fix bom).
//
// Além disso, um filtro anti-"teletransporte": descarta fixes cuja distância
// desde o anterior implicaria uma velocidade fisicamente impossível.
//
// Tudo determinístico (recebe estado + `now`/dt por parâmetro) → testes sem GPS.

import {
  type LatLngLite,
  haversineMeters,
  bearingBetween,
  shortestAngleDelta,
  projectOnSegment,
} from './geo';

export type { LatLngLite };

// ─── Rejeição de salto impossível (glitch de GPS) ────────────────────────────

/** Velocidade acima da qual o passo entre dois fixes é implausível (m/s ≈ 216 km/h). */
export const MAX_PLAUSIBLE_SPEED_MPS = 60;

/**
 * Um passo de GPS é plausível quando a velocidade implícita (distância/dt) fica
 * dentro do teto físico. dt ≤ 0 (fix fora de ordem/duplicado) → implausível.
 * Sem `prev` (primeiro fix) → sempre plausível.
 */
export function isPlausibleStep(
  prev: LatLngLite | null,
  next: LatLngLite,
  dtSec: number,
  maxSpeedMps: number = MAX_PLAUSIBLE_SPEED_MPS,
): boolean {
  if (!prev) return true;
  if (!(dtSec > 0)) return false;
  return haversineMeters(prev, next) / dtSec <= maxSpeedMps;
}

// ─── Map-matching com janela monotônica + score composto ─────────────────────

/** Quantos segmentos à frente do índice atual consideramos a cada fix. */
export const MATCH_WINDOW = 12;
/** Penalidade (em "metros equivalentes") por grau de desacordo de rumo. */
export const HEADING_WEIGHT_M_PER_DEG = 0.5;
/** Distância da rota que caracteriza um fix "fora do corredor". */
export const OFF_ROUTE_DIST_M = 40;
/** Fixes consecutivos fora do corredor para DECLARAR off-route (histerese). */
export const OFF_ROUTE_N = 4;

export interface MatchState {
  /** Índice do vértice inicial do segmento casado (monotônico na rota). */
  index: number;
  /** Contador de fixes consecutivos fora do corredor. */
  offRouteCount: number;
}

export const initialMatchState: MatchState = { index: 0, offRouteCount: 0 };

export interface MatchResult {
  state: MatchState;
  /** Ponto colado sobre a rota. */
  snapped: LatLngLite;
  /** Índice do segmento casado. */
  index: number;
  /** Distância (m) do fix ao ponto colado. */
  distanceM: number;
  /** Off-route CONFIRMADO pela histerese (≥ N fixes fora). */
  offRoute: boolean;
  /** Confiança do casamento em [0,1] (1 = em cima da via, com rumo coerente). */
  confidence: number;
}

/**
 * Casa `point` (opcionalmente com `headingDeg` do curso do GPS) na `path`,
 * partindo de `state`. Retorna o novo estado (índice avançado) e o resultado.
 * Rota com < 2 pontos → null.
 *
 * @param headingDeg Curso do veículo em graus [0,360) ou null (sem rumo → só
 *   distância decide, sem penalidade de rumo).
 */
export function matchToRoute(
  point: LatLngLite,
  headingDeg: number | null,
  path: LatLngLite[],
  state: MatchState = initialMatchState,
): MatchResult | null {
  if (path.length < 2) return null;

  const start = Math.max(0, Math.min(state.index, path.length - 2));
  const end = Math.min(path.length - 2, start + MATCH_WINDOW);

  let bestIdx = start;
  let bestScore = Infinity;
  let bestDist = Infinity;
  let bestSnapped: LatLngLite = { ...point };
  let bestHeadingErr = 0;

  for (let i = start; i <= end; i++) {
    const seg = projectOnSegment(point, path[i], path[i + 1]);
    let headingErr = 0;
    if (headingDeg != null) {
      const segBearing = bearingBetween(path[i], path[i + 1]);
      headingErr = Math.abs(shortestAngleDelta(headingDeg, segBearing));
    }
    const score = seg.distanceM + headingErr * HEADING_WEIGHT_M_PER_DEG;
    if (score < bestScore) {
      bestScore = score;
      bestIdx = i;
      bestDist = seg.distanceM;
      bestSnapped = seg.snapped;
      bestHeadingErr = headingErr;
    }
  }

  const offNow = bestDist > OFF_ROUTE_DIST_M;
  const offRouteCount = offNow ? state.offRouteCount + 1 : 0;
  const offRoute = offRouteCount >= OFF_ROUTE_N;

  // Confiança: cai com a distância ao corredor e com o desacordo de rumo.
  const distConf = Math.max(0, 1 - bestDist / OFF_ROUTE_DIST_M);
  const headConf = headingDeg != null ? Math.max(0, 1 - bestHeadingErr / 90) : 1;
  const confidence = Math.max(0, Math.min(1, distConf * headConf));

  return {
    state: { index: bestIdx, offRouteCount },
    snapped: bestSnapped,
    index: bestIdx,
    distanceM: bestDist,
    offRoute,
    confidence,
  };
}
