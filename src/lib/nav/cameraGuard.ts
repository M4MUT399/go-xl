// nav/cameraGuard — validação PURA de toda atualização de câmera do mapa.
//
// Bloco 1 (bug crítico iOS: zoom-out aleatório até o continente). A causa raiz
// é sempre a MESMA: a câmera recebe uma coordenada lixo (GPS sem fix → (0,0)
// "Null Island", NaN/null, ou um salto impossível de centenas de km) ou um zoom
// absurdamente baixo, e o MapKit/Google Maps "explode" para a visão de
// continente e às vezes trava os gestos. Aqui centralizamos as regras que
// decidem se um alvo de câmera pode ser aplicado — sem React, sem SDK de mapa,
// para poder exercitar cada regra em teste unitário.
//
// Quem CONSOME isto é o CameraController (nav/CameraController.ts): nenhuma tela
// deve chamar animateCamera/animateToRegion/fitToCoordinates direto no mapRef.

import { haversineMeters } from './geo';

/** Coordenada mínima usada nas validações (aceita accuracy opcional em metros). */
export interface GuardCoord {
  lat: number;
  lng: number;
  /** Erro estimado do GPS (m). Ausente = desconhecido (não reprova por accuracy). */
  accuracy?: number | null;
}

export interface GuardConfig {
  /** Zoom mínimo durante operação (online/em corrida). Abaixo disso, é corrigido. */
  minZoom: number;
  /** Zoom máximo aceitável (evita valores absurdos vindos de gesto/bug). */
  maxZoom: number;
  /** Salto além disto (m) desde a última posição válida = lixo de GPS → rejeita. */
  maxJumpMeters: number;
  /** Accuracy pior que isto (m) = fix ruim → rejeita. */
  maxAccuracyMeters: number;
  /** latitudeDelta/longitudeDelta máximos (modo region) — teto anti-continente. */
  maxRegionDelta: number;
  /** Altitude mínima da câmera (m) — equivalente iOS do maxZoom. */
  minAltitude: number;
  /** Altitude máxima da câmera (m) — equivalente iOS do minZoom, anti-continente. */
  maxAltitude: number;
}

export const DEFAULT_GUARD: GuardConfig = {
  minZoom: 10,
  maxZoom: 20,
  maxJumpMeters: 200_000, // 200 km entre dois fixes consecutivos é impossível
  maxAccuracyMeters: 100,
  maxRegionDelta: 0.5, // ~zoom 9.8: nunca "abre" além do bairro/cidade em operação
  minAltitude: 50, // m
  maxAltitude: 5_000, // m — bem abaixo da visão de estado/continente
};

export type RejectReason =
  | 'null' // lat/lng ausente
  | 'nan' // não-finito
  | 'null_island' // (0,0) — retorno padrão de GPS sem fix
  | 'accuracy' // fix com erro grande demais
  | 'jump'; // salto impossível desde a última posição válida

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: RejectReason; detail?: Record<string, number> };

/** true se lat/lng são números finitos e dentro dos limites geográficos. */
export function isFiniteCoord(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === 'number' &&
    typeof lng === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

/** true para a "Null Island" (0,0) — coordenada de GPS sem fix, nunca real aqui. */
export function isNullIsland(lat: number, lng: number): boolean {
  return Math.abs(lat) < 1e-6 && Math.abs(lng) < 1e-6;
}

/**
 * Valida um alvo de câmera contra a última posição VÁLIDA conhecida.
 *   - null/NaN/(0,0) → rejeita;
 *   - accuracy pior que o limite → rejeita;
 *   - salto > maxJumpMeters desde o último válido → rejeita (lixo de GPS).
 * Sem `lastValid`, o salto não é checado (primeiro fix do turno).
 */
export function validateTarget(
  next: GuardCoord | null | undefined,
  lastValid: { lat: number; lng: number } | null,
  cfg: GuardConfig = DEFAULT_GUARD,
): ValidationResult {
  if (next == null || next.lat == null || next.lng == null) {
    return { ok: false, reason: 'null' };
  }
  if (!isFiniteCoord(next.lat, next.lng)) {
    return { ok: false, reason: 'nan' };
  }
  if (isNullIsland(next.lat, next.lng)) {
    return { ok: false, reason: 'null_island' };
  }
  if (
    next.accuracy != null &&
    Number.isFinite(next.accuracy) &&
    next.accuracy > cfg.maxAccuracyMeters
  ) {
    return { ok: false, reason: 'accuracy', detail: { accuracy: next.accuracy } };
  }
  if (lastValid) {
    const jump = haversineMeters(lastValid, { lat: next.lat, lng: next.lng });
    if (jump > cfg.maxJumpMeters) {
      return { ok: false, reason: 'jump', detail: { jumpMeters: Math.round(jump) } };
    }
  }
  return { ok: true };
}

/**
 * Corrige o zoom para a faixa operacional [minZoom, maxZoom]. Zoom ausente
 * retorna undefined (deixa o SDK manter o atual). Devolve também se houve clamp,
 * para telemetria (queremos saber se algum caminho tentou zoom abaixo do mínimo).
 */
export function clampZoom(
  zoom: number | null | undefined,
  cfg: GuardConfig = DEFAULT_GUARD,
): { zoom: number | undefined; clamped: boolean } {
  if (zoom == null || !Number.isFinite(zoom)) return { zoom: undefined, clamped: false };
  if (zoom < cfg.minZoom) return { zoom: cfg.minZoom, clamped: true };
  if (zoom > cfg.maxZoom) return { zoom: cfg.maxZoom, clamped: true };
  return { zoom, clamped: false };
}

/**
 * Corrige a altitude (iOS/MapKit) para a faixa operacional. Mesmo papel do
 * clampZoom, mas para a chave que o MKMapView realmente lê. Altitude ausente
 * retorna undefined (deixa o SDK manter a atual).
 */
export function clampAltitude(
  altitude: number | null | undefined,
  cfg: GuardConfig = DEFAULT_GUARD,
): { altitude: number | undefined; clamped: boolean } {
  if (altitude == null || !Number.isFinite(altitude)) return { altitude: undefined, clamped: false };
  if (altitude < cfg.minAltitude) return { altitude: cfg.minAltitude, clamped: true };
  if (altitude > cfg.maxAltitude) return { altitude: cfg.maxAltitude, clamped: true };
  return { altitude, clamped: false };
}

/**
 * Corrige os deltas de uma region para não "abrir" além do teto anti-continente
 * durante operação. Preserva o menor delta (proporção) e só reduz o excedente.
 */
export function clampRegionDelta(
  latitudeDelta: number,
  longitudeDelta: number,
  cfg: GuardConfig = DEFAULT_GUARD,
): { latitudeDelta: number; longitudeDelta: number; clamped: boolean } {
  const latOk = Number.isFinite(latitudeDelta) ? latitudeDelta : cfg.maxRegionDelta;
  const lngOk = Number.isFinite(longitudeDelta) ? longitudeDelta : cfg.maxRegionDelta;
  const lat = Math.min(latOk, cfg.maxRegionDelta);
  const lng = Math.min(lngOk, cfg.maxRegionDelta);
  return {
    latitudeDelta: lat,
    longitudeDelta: lng,
    clamped: lat !== latOk || lng !== lngOk,
  };
}

/** Filtra uma lista de coordenadas mantendo só as válidas (não-lixo, não (0,0)). */
export function sanitizeCoords<T extends GuardCoord>(coords: T[] | null | undefined): T[] {
  if (!coords) return [];
  return coords.filter((c) => c && isFiniteCoord(c.lat, c.lng) && !isNullIsland(c.lat, c.lng));
}

/**
 * Retorna a PRIMEIRA coordenada válida (finita, dentro dos limites, não-(0,0))
 * de uma lista de candidatos em ordem de preferência — ou null se nenhuma servir.
 *
 * Usado para MONTAR o mapa numa posição segura: a tela de navegação escolhe, em
 * ordem, [última câmera válida herdada → posição do aceite → ponto de embarque],
 * garantindo que NUNCA abra numa região default ou em (0,0). Puro por design.
 */
export function firstValidCoord(
  candidates: Array<GuardCoord | null | undefined>,
): { lat: number; lng: number } | null {
  for (const c of candidates) {
    if (c && isFiniteCoord(c.lat, c.lng) && !isNullIsland(c.lat, c.lng)) {
      return { lat: c.lat, lng: c.lng };
    }
  }
  return null;
}
