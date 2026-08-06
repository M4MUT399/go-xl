// nav/smoothMarker — núcleo PURO do marcador fluido (Bloco 2, paridade Uber).
//
// Reúne, sem React nem SDK de mapa, as decisões que fazem o marcador do carro
// se mover como no Uber/Waze (e que o `SmoothMarker.tsx` apenas anima):
//   1. INTERPOLAÇÃO: cada fix vira uma animação da posição atual até a nova,
//      com duração ~= o intervalo entre fixes (clampada), nunca teleporte;
//   2. SNAP-NA-ROTA: se o fix cair a ≤ snapMaxMeters da polyline da rota, o
//      marcador é "colado" na via (esconde o zigue-zague do GPS urbano);
//   3. DEAD RECKONING: se o próximo fix atrasa, projeta a posição à frente pelo
//      último rumo+velocidade, por no máximo deadReckonMaxMs (3 s) — depois
//      congela (não inventa posição indefinidamente);
//   4. ROTAÇÃO PELO ARCO MAIS CURTO: heading contínuo/desenrolado (359°→1° gira
//      +2°, não -358°), congelado quando o veículo está praticamente parado.
//
// Puro e determinístico → testável em unidade e reutilizável tanto pela tela do
// motorista quanto pela do passageiro (Bloco 3, rota vinda do servidor).

import {
  bearingBetween,
  destinationPoint,
  haversineMeters,
  nearestPointOnPath,
  normalizeDeg,
  shortestAngleDelta,
  type LatLngLite,
} from './geo';

/** Um fix de posição (GPS ao vivo ou posição recebida via realtime). */
export interface MarkerFix {
  lat: number;
  lng: number;
  /** Curso/bearing do GPS (graus). Ausente/negativo = desconhecido. */
  heading?: number | null;
  /** Velocidade instantânea (m/s). Ausente = desconhecida. */
  speedMps?: number | null;
  /** Carimbo de tempo do fix (ms). */
  timestampMs: number;
}

export interface SmoothMarkerConfig {
  /** Duração-alvo da interpolação entre fixes (ms). */
  interpolateMs: number;
  /** Piso da duração da interpolação (ms) — evita animação instantânea. */
  minInterpolateMs: number;
  /** Teto da duração (ms) — evita "arrastão" quando um fix demora demais. */
  maxInterpolateMs: number;
  /** Desvio máximo (m) para colar o marcador na rota; acima disso, usa o fix cru. */
  snapMaxMeters: number;
  /** Projeção máxima do dead reckoning (ms) sem novo fix. */
  deadReckonMaxMs: number;
  /** Abaixo desta velocidade (m/s) NÃO projeta nem gira (rumo congela). */
  minMotionMps: number;
}

export const DEFAULT_SMOOTH: SmoothMarkerConfig = {
  interpolateMs: 1000, // ~cadência de fix; movimento linear e contínuo
  minInterpolateMs: 400,
  maxInterpolateMs: 1200,
  snapMaxMeters: 25, // largura típica de uma via urbana
  deadReckonMaxMs: 3000, // no máx. 3 s "no escuro" antes de congelar
  minMotionMps: 1.5, // ~5.4 km/h — abaixo disso é ruído de GPS parado
};

/**
 * Duração da interpolação para este fix, a partir do intervalo desde o anterior.
 * Sem fix anterior (primeiro do turno) → 0 (crava a posição, sem glide de seed).
 */
export function interpolationDuration(
  prevTimestampMs: number | null,
  nowMs: number,
  cfg: SmoothMarkerConfig = DEFAULT_SMOOTH,
): number {
  if (prevTimestampMs == null) return 0;
  const dt = nowMs - prevTimestampMs;
  if (!(dt > 0)) return cfg.minInterpolateMs;
  return Math.max(cfg.minInterpolateMs, Math.min(cfg.maxInterpolateMs, dt));
}

/**
 * Resolve a POSIÇÃO-ALVO de um fix: colada na rota se estiver perto o bastante,
 * senão o próprio fix. `route` vazia/ausente → sempre o fix cru.
 */
export function resolveTarget(
  fix: Pick<MarkerFix, 'lat' | 'lng'>,
  route: LatLngLite[] | null | undefined,
  cfg: SmoothMarkerConfig = DEFAULT_SMOOTH,
): LatLngLite {
  const raw: LatLngLite = { lat: fix.lat, lng: fix.lng };
  if (!route || route.length === 0) return raw;
  const snap = nearestPointOnPath(raw, route);
  if (snap && snap.distanceM <= cfg.snapMaxMeters) return snap.snapped;
  return raw;
}

/**
 * DEAD RECKONING: dado o último fix e o "agora", projeta a posição à frente pelo
 * rumo+velocidade do fix, limitada a deadReckonMaxMs. Sem movimento suficiente,
 * sem rumo ou fix futuro → devolve o próprio ponto do fix (nunca inventa).
 */
export function deadReckon(
  fix: MarkerFix,
  nowMs: number,
  cfg: SmoothMarkerConfig = DEFAULT_SMOOTH,
): LatLngLite {
  const here: LatLngLite = { lat: fix.lat, lng: fix.lng };
  const speed = fix.speedMps ?? 0;
  const heading = fix.heading;
  if (speed < cfg.minMotionMps || heading == null || heading < 0) return here;
  const elapsed = Math.min(Math.max(0, nowMs - fix.timestampMs), cfg.deadReckonMaxMs);
  if (elapsed <= 0) return here;
  return destinationPoint(here, normalizeDeg(heading), speed * (elapsed / 1000));
}

/**
 * Próximo rumo CONTÍNUO (desenrolado) do marcador, girando pelo arco mais curto.
 * `current` é o rumo acumulado (pode passar de 360/ficar negativo); o resultado
 * também é contínuo — passe-o de volta como `current` no próximo fix.
 *
 * Regras:
 *   - velocidade < minMotionMps OU rumo do fix inválido → CONGELA (mantém current);
 *   - senão → current + menor delta até o rumo do fix.
 * Sem `current` (primeiro rumo) → o próprio rumo do fix normalizado.
 */
export function continuousHeading(
  current: number | null,
  fix: Pick<MarkerFix, 'heading' | 'speedMps'>,
  cfg: SmoothMarkerConfig = DEFAULT_SMOOTH,
): number {
  const raw = fix.heading;
  // Velocidade DESCONHECIDA (ex.: posição vinda do servidor sem `speed`) → confia
  // no rumo. Só congela quando a velocidade é conhecida E baixa (parado real).
  const moving = fix.speedMps == null ? true : fix.speedMps >= cfg.minMotionMps;
  const valid = raw != null && raw >= 0;
  if (current == null) return valid ? normalizeDeg(raw) : 0;
  if (!moving || !valid) return current;
  return current + shortestAngleDelta(normalizeDeg(current), normalizeDeg(raw));
}

/**
 * Rumo de FALLBACK quando o GPS não traz curso: infere pela direção do
 * deslocamento entre a posição anterior e a atual, se andou o suficiente.
 * Retorna null se o passo for pequeno demais para ser confiável (< 2 m).
 */
export function inferHeading(from: LatLngLite, to: LatLngLite): number | null {
  if (haversineMeters(from, to) < 2) return null;
  return bearingBetween(from, to);
}
