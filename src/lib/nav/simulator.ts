// nav/simulator — "dirigir" uma rota sem carro: gera fixes de GPS a cada 1 s ao
// longo de uma polyline real, para validar a fluidez do marcador/câmera no
// emulador. Puro e determinístico (testável); o consumo em tempo real (reproduzir
// um fix por segundo) fica no hook useNavigationLocation.

import { LatLngLite, bearingBetween, haversineMeters, sphericalInterpolate } from './geo';

export interface SimFix {
  lat: number;
  lng: number;
  /** Rumo do segmento atual (graus). */
  heading: number;
  /** Velocidade constante da simulação (m/s). */
  speed: number;
  /** Precisão simulada (m) — boa, para não ser descartada pelo filtro. */
  accuracy: number;
  /** Timestamp do fix (ms). */
  timestampMs: number;
}

export interface SimulateOptions {
  /** Velocidade de deslocamento (m/s). Padrão ~50 km/h. */
  speedMps?: number;
  /** Intervalo entre fixes (ms). Padrão 1000. */
  intervalMs?: number;
  /** Timestamp do primeiro fix (ms). Padrão 0. */
  startTimeMs?: number;
  /** Precisão simulada (m). Padrão 5. */
  accuracy?: number;
}

/** Posição + rumo a uma distância `d` (m) do início da polyline. */
function pointAtDistance(
  path: LatLngLite[],
  segLen: number[],
  d: number,
): { coord: LatLngLite; heading: number } {
  if (d <= 0) {
    return { coord: { ...path[0] }, heading: bearingBetween(path[0], path[1] ?? path[0]) };
  }
  let remaining = d;
  for (let i = 0; i < segLen.length; i++) {
    const len = segLen[i];
    if (remaining <= len || i === segLen.length - 1) {
      const frac = len > 0 ? Math.min(1, remaining / len) : 1;
      return {
        coord: sphericalInterpolate(path[i], path[i + 1], frac),
        heading: bearingBetween(path[i], path[i + 1]),
      };
    }
    remaining -= len;
  }
  const last = path.length - 1;
  return { coord: { ...path[last] }, heading: bearingBetween(path[last - 1], path[last]) };
}

/**
 * Gera a sequência completa de fixes ao longo da rota. Um fix no ponto inicial,
 * depois um a cada `intervalMs` avançando `speedMps · intervalMs` metros, e um
 * fix final EXATO no destino (para o marcador terminar colado no ponto).
 */
export function simulateRouteFixes(path: LatLngLite[], opts: SimulateOptions = {}): SimFix[] {
  const speed = opts.speedMps ?? 13.9; // ~50 km/h
  const interval = opts.intervalMs ?? 1000;
  const startTime = opts.startTimeMs ?? 0;
  const accuracy = opts.accuracy ?? 5;

  if (path.length === 0) return [];
  if (path.length === 1) {
    return [{ lat: path[0].lat, lng: path[0].lng, heading: 0, speed: 0, accuracy, timestampMs: startTime }];
  }

  const segLen: number[] = [];
  for (let s = 0; s < path.length - 1; s++) segLen.push(haversineMeters(path[s], path[s + 1]));
  const total = segLen.reduce((a, b) => a + b, 0);

  const stepM = Math.max(0.1, speed * (interval / 1000));
  const fixes: SimFix[] = [];
  let i = 0;
  let travelled = 0;
  while (travelled < total) {
    const at = pointAtDistance(path, segLen, travelled);
    fixes.push({
      lat: at.coord.lat,
      lng: at.coord.lng,
      heading: at.heading,
      speed,
      accuracy,
      timestampMs: startTime + i * interval,
    });
    travelled += stepM;
    i++;
  }

  // Fix final exatamente no destino.
  const lastIdx = path.length - 1;
  fixes.push({
    lat: path[lastIdx].lat,
    lng: path[lastIdx].lng,
    heading: bearingBetween(path[lastIdx - 1], path[lastIdx]),
    speed,
    accuracy,
    timestampMs: startTime + i * interval,
  });

  return fixes;
}
