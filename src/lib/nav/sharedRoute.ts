// nav/sharedRoute — núcleo PURO da rota única no servidor (Bloco 3, paridade
// Uber). Sem React, sem SDK de mapa, sem fetch: só as decisões determinísticas
// que fazem motorista E passageiro enxergarem A MESMA rota, vinda do servidor.
//
// Responsabilidades:
//   1. CODEC de polyline (Google Encoded Polyline, precisão 5) — o formato
//      compacto em que a rota trafega servidor↔cliente (uma string em vez de
//      centenas de pares lat/lng). `encode`/`decode` são inversos exatos até a
//      5ª casa decimal.
//   2. RECONCILIAÇÃO por versão — `route_version` é um contador monotônico; um
//      cliente só adota uma rota se ela for MAIS NOVA que a atual (resolve
//      reconexão e mensagens fora de ordem do realtime).
//   3. REROUTE — decide, pela geometria, quando o motorista saiu da rota o
//      bastante para o servidor recalcular (com um estrangulador de tempo para
//      não martelar o OSRM).
//   4. PARSE — transforma a linha crua do banco (`rides`) no modelo que a tela
//      consome, decodificando a polyline; devolve null se a rota está incompleta.
//
// O MESMO codec roda na Edge Function (Deno) e no app — por isso é puro e sem
// dependências de plataforma.

import { haversineMeters, nearestPointOnPath, type LatLngLite } from './geo';

// ─── Codec de polyline (Google Encoded Polyline Algorithm Format, precisão 5) ──

const POLYLINE_PRECISION = 1e5; // 5 casas decimais

/**
 * Codifica uma lista de coordenadas na string encoded-polyline do Google.
 * Determinístico e compacto; é o que vai para a coluna `route_polyline`.
 */
export function encodePolyline(coords: LatLngLite[]): string {
  let out = '';
  let prevLat = 0;
  let prevLng = 0;
  for (const c of coords) {
    const lat = Math.round(c.lat * POLYLINE_PRECISION);
    const lng = Math.round(c.lng * POLYLINE_PRECISION);
    out += encodeSignedNumber(lat - prevLat);
    out += encodeSignedNumber(lng - prevLng);
    prevLat = lat;
    prevLng = lng;
  }
  return out;
}

/**
 * Decodifica a string encoded-polyline de volta em coordenadas. Inverso de
 * `encodePolyline` até a 5ª casa. String vazia/ausente → lista vazia.
 */
export function decodePolyline(encoded: string | null | undefined): LatLngLite[] {
  if (!encoded) return [];
  const coords: LatLngLite[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  const len = encoded.length;
  while (index < len) {
    let result = 1;
    let shift = 0;
    let b: number;
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f && index < len);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 1;
    shift = 0;
    do {
      b = encoded.charCodeAt(index++) - 63 - 1;
      result += b << shift;
      shift += 5;
    } while (b >= 0x1f && index < len);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    coords.push({ lat: lat / POLYLINE_PRECISION, lng: lng / POLYLINE_PRECISION });
  }
  return coords;
}

function encodeSignedNumber(num: number): string {
  let sgn = num << 1;
  if (num < 0) sgn = ~sgn;
  let out = '';
  while (sgn >= 0x20) {
    out += String.fromCharCode((0x20 | (sgn & 0x1f)) + 63);
    sgn >>= 5;
  }
  out += String.fromCharCode(sgn + 63);
  return out;
}

// ─── Configuração de reroute ───────────────────────────────────────────────────

export interface SharedRouteConfig {
  /** Distância (m) da rota acima da qual se considera o motorista fora dela. */
  offRouteMeters: number;
  /** Intervalo mínimo (ms) entre recálculos — estrangula chamadas ao OSRM. */
  minRerouteIntervalMs: number;
}

export const DEFAULT_SHARED_ROUTE: SharedRouteConfig = {
  offRouteMeters: 40, // ~ largura de rua + folga de GPS urbano
  minRerouteIntervalMs: 8000, // no máx. um recálculo a cada 8 s
};

// ─── Reconciliação por versão ──────────────────────────────────────────────────

/**
 * Um cliente só troca de rota se a que chegou for MAIS NOVA (versão maior) que a
 * que ele já tem. `current` null/ausente (primeira rota do turno) → sempre adota.
 * Blinda contra reconexão e eventos de realtime fora de ordem.
 */
export function isNewerRoute(incomingVersion: number, currentVersion: number | null | undefined): boolean {
  if (currentVersion == null) return true;
  return incomingVersion > currentVersion;
}

// ─── Decisão de reroute (geométrica) ───────────────────────────────────────────

/**
 * O motorista saiu da rota o suficiente para recalcular? Puramente geométrico:
 * projeta a posição na polyline e compara com `offRouteMeters`. Rota vazia →
 * false (não há de onde desviar). O estrangulamento de tempo é responsabilidade
 * de `rerouteThrottleElapsed`, mantido separado para cada função ter um só papel.
 */
export function isOffRoute(
  driverPos: LatLngLite,
  routeCoords: LatLngLite[],
  cfg: SharedRouteConfig = DEFAULT_SHARED_ROUTE,
): boolean {
  if (routeCoords.length === 0) return false;
  const snap = nearestPointOnPath(driverPos, routeCoords);
  if (!snap) return false;
  return snap.distanceM > cfg.offRouteMeters;
}

/**
 * Já passou tempo suficiente desde o último recálculo? Sem recálculo anterior
 * (null) → sempre true. Usado junto de `isOffRoute` para não martelar o OSRM.
 */
export function rerouteThrottleElapsed(
  lastRerouteMs: number | null,
  nowMs: number,
  cfg: SharedRouteConfig = DEFAULT_SHARED_ROUTE,
): boolean {
  if (lastRerouteMs == null) return true;
  return nowMs - lastRerouteMs >= cfg.minRerouteIntervalMs;
}

// ─── Modelo compartilhado + parse da linha do banco ────────────────────────────

/** A rota única, já decodificada, que ambas as telas consomem. */
export interface SharedRoute {
  /** Contador monotônico; incrementado a cada recálculo no servidor. */
  version: number;
  /** Geometria decodificada (para desenhar a polyline e alimentar o snap). */
  coordinates: LatLngLite[];
  /** Destino da corrida (fim da rota). */
  destination: LatLngLite;
  /** ETA único (min) calculado pelo servidor — mesma fonte para os dois lados. */
  etaMin: number | null;
  /** Distância (km) calculada pelo servidor. */
  distanceKm: number | null;
}

/** A linha crua vinda da tabela `rides` (colunas do Bloco 3). */
export interface SharedRouteRow {
  route_polyline?: string | null;
  route_version?: number | null;
  route_eta_min?: number | null;
  route_distance_km?: number | null;
}

/**
 * Constrói o `SharedRoute` a partir da linha da corrida. O destino é o ÚLTIMO
 * ponto da polyline (fim da rota) — sempre coerente com a fase, porque na fase
 * de embarque a rota termina no ponto de embarque e na fase de destino termina
 * no destino, sem depender de coluna separada. Devolve null quando a rota ainda
 * não foi computada pelo servidor (sem polyline/versão) — nesse caso a tela cai
 * no comportamento legado (cliente calcula a própria rota).
 */
export function parseSharedRoute(row: SharedRouteRow | null | undefined): SharedRoute | null {
  if (!row) return null;
  if (row.route_version == null || !row.route_polyline) return null;
  const coordinates = decodePolyline(row.route_polyline);
  if (coordinates.length === 0) return null;
  return {
    version: row.route_version,
    coordinates,
    destination: coordinates[coordinates.length - 1],
    etaMin: row.route_eta_min ?? null,
    distanceKm: row.route_distance_km ?? null,
  };
}

/**
 * Comprimento total (m) de uma polyline decodificada — usado em testes e como
 * sanidade de distância quando o servidor não devolve `distance`.
 */
export function polylineLengthMeters(coords: LatLngLite[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += haversineMeters(coords[i - 1], coords[i]);
  return total;
}
