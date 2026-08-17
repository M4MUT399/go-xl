// nav/follow — regras da câmera "drone" estilo Waze e do disparo de re-rota.
// Lógica pura (sem mapa/React) para poder testar zoom, heading e re-rota.

import { normalizeDeg } from './geo';

// ─── Zoom dinâmico por velocidade ────────────────────────────────────────────

export const BASE_ZOOM = 17.5; // padrão
export const SLOW_ZOOM = 18.5; // até SLOW_KMH: aproxima (cidade, manobras)
export const FAST_ZOOM = 16.5; // acima de FAST_KMH: afasta (rodovia, ver mais à frente)
export const SLOW_KMH = 30;
export const FAST_KMH = 80;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Nível de zoom em função da velocidade (m/s):
 *   ≤ 30 km/h → 18.5 · ≥ 80 km/h → 16.5 · entre eles, rampa linear (≈ 17.5 aos
 *   ~55 km/h, o "base"). Velocidade ausente/negativa é tratada como 0 (parado).
 */
export function zoomForSpeed(speedMps: number | null | undefined): number {
  const kmh = Math.max(0, (speedMps ?? 0) * 3.6);
  if (kmh <= SLOW_KMH) return SLOW_ZOOM;
  if (kmh >= FAST_KMH) return FAST_ZOOM;
  const f = (kmh - SLOW_KMH) / (FAST_KMH - SLOW_KMH); // 0..1
  return round2(SLOW_ZOOM + (FAST_ZOOM - SLOW_ZOOM) * f);
}

// ─── Altitude da câmera (iOS / MapKit) ───────────────────────────────────────
//
// `zoom` só existe no Google Maps (Android). O MKMapView do iOS NÃO lê essa
// chave em animateCamera — o bridge (RCTConvert+AirMap.m) só olha
// center/pitch/altitude/heading. Sem mandar `altitude`, o nativo copia a câmera
// atual e, com pitch != 0, a altitude relida volta maior que a aplicada: cada
// fix de GPS realimenta um valor um pouco maior e o mapa se afasta sozinho até a
// visão de continente. Por isso toda pose manda AS DUAS chaves — o Android
// ignora `altitude`, o iOS ignora `zoom`.

/** Altitude (m) equivalente ao BASE_ZOOM — âncora da conversão abaixo. */
export const BASE_ALTITUDE = 350;

/**
 * Altitude em metros equivalente a um nível de zoom. Cada nível de zoom dobra
 * ou divide a escala, então a altitude segue a mesma potência de 2:
 *   zoom 18.5 → 175 m · zoom 17.5 → 350 m · zoom 16.5 → 700 m.
 */
export function altitudeForZoom(zoom: number | null | undefined): number | undefined {
  if (zoom == null || !Number.isFinite(zoom)) return undefined;
  return Math.round(BASE_ALTITUDE * Math.pow(2, BASE_ZOOM - zoom));
}

// ─── Heading de navegação (com congelamento parado) ──────────────────────────

/** Abaixo desta velocidade, o rumo do GPS é ruído — congelamos o último válido. */
export const MOVING_SPEED_MPS = 2;

export interface HeadingInput {
  /** Velocidade instantânea (m/s). */
  speedMps?: number | null;
  /** Curso/bearing do GPS (graus). Negativo/undefined = desconhecido. */
  course?: number | null;
  /** Último heading válido, usado como fallback quando parado. */
  lastHeading: number;
}

/**
 * Escolhe o heading para orientar o mapa (bússola veicular):
 *   - movendo (> 2 m/s) e com curso de GPS válido → usa o curso;
 *   - parado ou curso inválido → CONGELA o último (não gira no semáforo, e
 *     nunca cai para o magnetômetro cru).
 */
export function headingForMotion({ speedMps, course, lastHeading }: HeadingInput): number {
  const moving = (speedMps ?? 0) > MOVING_SPEED_MPS;
  const validCourse = course != null && course >= 0;
  if (moving && validCourse) return normalizeDeg(course);
  return normalizeDeg(lastHeading);
}

// ─── Re-rota (fora da rota por tempo contínuo) ───────────────────────────────

/** Distância da rota acima da qual consideramos o carro "fora da rota". */
export const OFF_ROUTE_M = 40;
/** Tempo contínuo fora da rota que dispara o recálculo. */
export const OFF_ROUTE_MS = 5000;

export interface OffRouteState {
  /** Instante (ms) em que o carro começou a ficar fora da rota, ou null. */
  since: number | null;
}

export const initialOffRouteState: OffRouteState = { since: null };

/**
 * Máquina de estado da re-rota. A cada fix, informe a distância atual à rota e
 * o "agora". Retorna o novo estado e se deve DISPARAR o recálculo.
 *
 *   - dentro do corredor (≤ 40 m) → zera o cronômetro;
 *   - fora, mas por menos de 5 s → aguarda (evita re-rota por GPS "pulando");
 *   - fora por ≥ 5 s contínuos → dispara UMA vez e zera (a nova rota reancora).
 */
export function updateOffRoute(
  state: OffRouteState,
  distanceToRouteM: number,
  nowMs: number,
): { state: OffRouteState; reroute: boolean } {
  if (distanceToRouteM <= OFF_ROUTE_M) {
    return { state: { since: null }, reroute: false };
  }
  const since = state.since ?? nowMs;
  if (nowMs - since >= OFF_ROUTE_MS) {
    return { state: { since: null }, reroute: true };
  }
  return { state: { since }, reroute: false };
}
