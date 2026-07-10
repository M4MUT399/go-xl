// nav/geo — matemática pura de geolocalização e ângulos para a navegação
// estilo Waze (interpolação de posição/rumo, snap na rota, média circular).
//
// Tudo aqui é DETERMINÍSTICO e sem dependências de React/Native, para poder
// ser exercitado por testes unitários e reutilizado tanto pelo pipeline de
// GPS ao vivo quanto pelo simulador de rota.

export const EARTH_RADIUS_M = 6_371_000;

export const toRad = (deg: number): number => (deg * Math.PI) / 180;
export const toDeg = (rad: number): number => (rad * 180) / Math.PI;

/** Coordenada "leve" no formato do app (Supabase/telemetria). */
export interface LatLngLite {
  lat: number;
  lng: number;
}

/** Coordenada no formato do react-native-maps. */
export interface LatLng {
  latitude: number;
  longitude: number;
}

export const toMapCoord = (c: LatLngLite): LatLng => ({ latitude: c.lat, longitude: c.lng });
export const fromMapCoord = (c: LatLng): LatLngLite => ({ lat: c.latitude, lng: c.longitude });

// ─── Ângulos ─────────────────────────────────────────────────────────────────

/** Normaliza um ângulo em graus para o intervalo [0, 360). */
export function normalizeDeg(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * Menor diferença angular assinada de `from` → `to`, em (-180, 180].
 * Trata o cruzamento do zero: shortestAngleDelta(359, 1) === 2 (não -358).
 */
export function shortestAngleDelta(from: number, to: number): number {
  let d = normalizeDeg(to) - normalizeDeg(from);
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/**
 * Interpola um ângulo pelo caminho MAIS CURTO, com t em [0,1], retornando
 * [0,360). lerpAngle(350, 10, 0.5) === 0 (passa por 360/0, não por 180).
 */
export function lerpAngle(from: number, to: number, t: number): number {
  return normalizeDeg(from + shortestAngleDelta(from, to) * t);
}

/**
 * Média circular de rumos (graus) — a forma correta de suavizar heading com
 * média móvel: circularMean([350, 10]) === 0, não 180. Retorna [0,360).
 * Quando os vetores se cancelam (direção indefinida), cai no último valor.
 */
export function circularMean(headings: number[]): number {
  if (headings.length === 0) return 0;
  let sx = 0;
  let sy = 0;
  for (const h of headings) {
    sx += Math.cos(toRad(h));
    sy += Math.sin(toRad(h));
  }
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) {
    return normalizeDeg(headings[headings.length - 1]);
  }
  return normalizeDeg(toDeg(Math.atan2(sy, sx)));
}

// ─── Distância e rumo ──────────────────────────────────────────────────────

/** Distância em metros entre dois pontos (fórmula de haversine). */
export function haversineMeters(a: LatLngLite, b: LatLngLite): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/** Rumo inicial (bearing) de `a` → `b`, em [0,360). Norte = 0, Leste = 90. */
export function bearingBetween(a: LatLngLite, b: LatLngLite): number {
  const phi1 = toRad(a.lat);
  const phi2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLng);
  return normalizeDeg(toDeg(Math.atan2(y, x)));
}

// ─── Interpolação de posição ─────────────────────────────────────────────────

/**
 * Interpolação ESFÉRICA (slerp) entre dois pontos, com t em [0,1].
 * Equivalente ao SphericalUtil.interpolate — segue o grande círculo, evitando
 * o "salto" do marcador. Em distâncias curtas (uma leitura de GPS) é
 * praticamente igual à interpolação linear, mas correta perto dos polos e do
 * antimeridiano.
 */
export function sphericalInterpolate(a: LatLngLite, b: LatLngLite, t: number): LatLngLite {
  if (t <= 0) return { lat: a.lat, lng: a.lng };
  if (t >= 1) return { lat: b.lat, lng: b.lng };

  const phi1 = toRad(a.lat);
  const lambda1 = toRad(a.lng);
  const phi2 = toRad(b.lat);
  const lambda2 = toRad(b.lng);

  // distância angular entre os pontos
  const delta =
    2 *
    Math.asin(
      Math.min(
        1,
        Math.sqrt(
          Math.sin((phi2 - phi1) / 2) ** 2 +
            Math.cos(phi1) * Math.cos(phi2) * Math.sin((lambda2 - lambda1) / 2) ** 2,
        ),
      ),
    );
  if (delta === 0) return { lat: a.lat, lng: a.lng };

  const A = Math.sin((1 - t) * delta) / Math.sin(delta);
  const B = Math.sin(t * delta) / Math.sin(delta);
  const x = A * Math.cos(phi1) * Math.cos(lambda1) + B * Math.cos(phi2) * Math.cos(lambda2);
  const y = A * Math.cos(phi1) * Math.sin(lambda1) + B * Math.cos(phi2) * Math.sin(lambda2);
  const z = A * Math.sin(phi1) + B * Math.sin(phi2);
  const phi = Math.atan2(z, Math.sqrt(x * x + y * y));
  const lambda = Math.atan2(y, x);
  return { lat: toDeg(phi), lng: toDeg(lambda) };
}

// ─── Snap na polyline (rota) ─────────────────────────────────────────────────

export interface SnapResult {
  /** Índice do vértice inicial do segmento mais próximo. */
  index: number;
  /** Distância em metros do ponto ao ponto projetado na rota. */
  distanceM: number;
  /** Ponto projetado (colado) sobre a rota. */
  snapped: LatLngLite;
  /** Fração [0,1] ao longo do segmento onde caiu a projeção. */
  t: number;
}

/**
 * Projeta `p` sobre o segmento a→b usando um plano local em METROS
 * (equiretangular ao redor de `a`) — preciso o suficiente na escala de uma rua.
 */
function projectOnSegment(
  p: LatLngLite,
  a: LatLngLite,
  b: LatLngLite,
): { distanceM: number; snapped: LatLngLite; t: number } {
  const mPerDegLat = 111_132;
  const mPerDegLng = 111_320 * Math.cos(toRad(a.lat));

  const bx = (b.lng - a.lng) * mPerDegLng;
  const by = (b.lat - a.lat) * mPerDegLat;
  const px = (p.lng - a.lng) * mPerDegLng;
  const py = (p.lat - a.lat) * mPerDegLat;

  const len2 = bx * bx + by * by;
  let t = len2 === 0 ? 0 : (px * bx + py * by) / len2;
  t = Math.max(0, Math.min(1, t));

  const sx = t * bx;
  const sy = t * by;
  const snapped: LatLngLite = {
    lat: a.lat + sy / mPerDegLat,
    lng: a.lng + sx / mPerDegLng,
  };
  const distanceM = Math.hypot(px - sx, py - sy);
  return { distanceM, snapped, t };
}

/**
 * Ponto mais próximo do carro sobre a polyline da rota. Retorna null se a rota
 * estiver vazia. Usado para (a) colar o carro na via, (b) separar o trecho já
 * percorrido e (c) medir o desvio para decidir re-rota.
 */
export function nearestPointOnPath(point: LatLngLite, path: LatLngLite[]): SnapResult | null {
  if (path.length === 0) return null;
  if (path.length === 1) {
    return { index: 0, distanceM: haversineMeters(point, path[0]), snapped: { ...path[0] }, t: 0 };
  }
  let best: SnapResult | null = null;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = projectOnSegment(point, path[i], path[i + 1]);
    if (!best || seg.distanceM < best.distanceM) {
      best = { index: i, distanceM: seg.distanceM, snapped: seg.snapped, t: seg.t };
    }
  }
  return best;
}

/**
 * Divide a rota em [percorrido] e [restante] no ponto de snap. O percorrido
 * termina no ponto colado; o restante começa nele — sem "buraco" visual entre
 * os dois traçados.
 */
export function splitPathAtSnap(
  path: LatLngLite[],
  snap: SnapResult,
): { traveled: LatLngLite[]; remaining: LatLngLite[] } {
  const traveled = path.slice(0, snap.index + 1).concat([snap.snapped]);
  const remaining = [snap.snapped].concat(path.slice(snap.index + 1));
  return { traveled, remaining };
}
