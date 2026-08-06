// ─── Parser PURO da resposta da Google Directions API ────────────────────────
//
// Fase 1 (provider): trocamos o OSRM demo público pela Google Directions API.
// A CHAVE fica secreta no servidor (Edge Function `directions`); o cliente só
// recebe o JSON da Google e o normaliza AQUI, num módulo puro e testável (sem
// rede), para o MESMO formato `RouteResult` que o resto do app já consome.
//
// Ganhos sobre o OSRM:
//   • ETA com trânsito em tempo real (`duration_in_traffic`, via departure_time=now)
//   • geometria POR STEP de alta resolução (cada manobra traz sua própria
//     polyline) — essencial para o map-matching robusto (Fase 4) em viadutos,
//     rampas e pistas separadas
//   • manobras mais ricas (campo `maneuver` do Google), aqui traduzidas para o
//     vocabulário {type, modifier} estilo OSRM que os banners já entendem —
//     assim nenhuma tela de UI precisa mudar nesta fase.
//
// O que a Google NÃO dá de forma estruturada: lane guidance por faixa (só vem
// embutida no HTML das instruções). Tratamos isso na Fase 6, best-effort.

import { decodePolyline } from './sharedRoute';
import type { LatLngLite } from './geo';
import type { RouteResult, RouteStep, LatLng } from '../routing';

// ─── Tipos mínimos da resposta da Google Directions ──────────────────────────
// (só o subconjunto que consumimos; a resposta real tem muito mais campos)
interface GoogleDistanceDuration {
  value?: number; // metros (distance) ou segundos (duration)
  text?: string;
}
interface GoogleStep {
  distance?: GoogleDistanceDuration;
  duration?: GoogleDistanceDuration;
  html_instructions?: string;
  maneuver?: string; // ex.: 'turn-left', 'ramp-right', 'merge', 'roundabout-left'
  polyline?: { points?: string };
  start_location?: { lat: number; lng: number };
  end_location?: { lat: number; lng: number };
}
interface GoogleLeg {
  distance?: GoogleDistanceDuration;
  duration?: GoogleDistanceDuration;
  duration_in_traffic?: GoogleDistanceDuration;
  steps?: GoogleStep[];
}
interface GoogleRoute {
  legs?: GoogleLeg[];
  overview_polyline?: { points?: string };
}
export interface GoogleDirectionsResponse {
  status?: string;
  routes?: GoogleRoute[];
}

const lite2map = (c: LatLngLite): LatLng => ({ latitude: c.lat, longitude: c.lng });

/**
 * Traduz o campo `maneuver` da Google para o par {type, modifier} no vocabulário
 * do OSRM — que é o que os banners de manobra (DriverNavigateScreen) já sabem
 * desenhar/traduzir. Quando a Google não manda `maneuver` (trechos retos), o
 * step é um "continue"/"depart" implícito, resolvido pelo chamador.
 *
 * Referência dos valores da Google:
 *   turn-slight-left, turn-sharp-left, turn-left, turn-slight-right,
 *   turn-sharp-right, turn-right, straight, ramp-left, ramp-right,
 *   merge, fork-left, fork-right, ferry, ferry-train, roundabout-left,
 *   roundabout-right, uturn-left, uturn-right, keep-left, keep-right
 */
export function mapGoogleManeuver(maneuver: string | undefined): { type: string; modifier?: string } {
  switch (maneuver) {
    case 'turn-left':          return { type: 'turn', modifier: 'left' };
    case 'turn-right':         return { type: 'turn', modifier: 'right' };
    case 'turn-slight-left':   return { type: 'turn', modifier: 'slight left' };
    case 'turn-slight-right':  return { type: 'turn', modifier: 'slight right' };
    case 'turn-sharp-left':    return { type: 'turn', modifier: 'sharp left' };
    case 'turn-sharp-right':   return { type: 'turn', modifier: 'sharp right' };
    case 'straight':           return { type: 'continue', modifier: 'straight' };
    case 'ramp-left':          return { type: 'on ramp', modifier: 'left' };
    case 'ramp-right':         return { type: 'on ramp', modifier: 'right' };
    case 'merge':              return { type: 'merge', modifier: 'straight' };
    case 'fork-left':          return { type: 'fork', modifier: 'left' };
    case 'fork-right':         return { type: 'fork', modifier: 'right' };
    case 'keep-left':          return { type: 'fork', modifier: 'slight left' };
    case 'keep-right':         return { type: 'fork', modifier: 'slight right' };
    case 'roundabout-left':    return { type: 'roundabout', modifier: 'left' };
    case 'roundabout-right':   return { type: 'roundabout', modifier: 'right' };
    case 'uturn-left':         return { type: 'turn', modifier: 'uturn' };
    case 'uturn-right':        return { type: 'turn', modifier: 'uturn' };
    default:                   return { type: 'continue', modifier: 'straight' };
  }
}

/**
 * Remove as tags HTML das `html_instructions` da Google, deixando o texto puro
 * ("Turn left onto S Conroy Rd"). Só usado como fallback de `name`; a UI hoje
 * exibe o nome da via, não a frase inteira.
 */
export function stripHtml(html: string | undefined): string {
  if (!html) return '';
  return html
    .replace(/<[^>]*>/g, ' ')     // tira tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normaliza a resposta da Google Directions para o `RouteResult` do app.
 *
 *   • coordinates: geometria de overview (linha desenhada no mapa)
 *   • distanceKm / durationMin: PREFERE `duration_in_traffic` quando presente
 *     (ETA com trânsito); cai em `duration` puro caso contrário
 *   • steps[].coordinates: geometria POR STEP decodificada (alta resolução) —
 *     alimenta o map-matching da Fase 4
 *
 * Retorna null se a resposta não tiver rota utilizável (o chamador então cai
 * no OSRM — fallback seguro).
 */
export function normalizeGoogleDirections(
  resp: GoogleDirectionsResponse | null | undefined,
): RouteResult | null {
  if (!resp || resp.status !== 'OK') return null;
  const route = resp.routes?.[0];
  if (!route) return null;

  // Une todas as legs (normalmente há 1, sem waypoints).
  const legs = route.legs ?? [];
  if (legs.length === 0) return null;

  let distanceMeters = 0;
  let durationSeconds = 0;
  let trafficSeconds = 0;
  let hasTraffic = false;
  const steps: RouteStep[] = [];

  for (const leg of legs) {
    distanceMeters += leg.distance?.value ?? 0;
    durationSeconds += leg.duration?.value ?? 0;
    if (leg.duration_in_traffic?.value != null) {
      trafficSeconds += leg.duration_in_traffic.value;
      hasTraffic = true;
    } else {
      trafficSeconds += leg.duration?.value ?? 0;
    }

    for (const s of leg.steps ?? []) {
      const geometry = decodePolyline(s.polyline?.points).map(lite2map);
      const mapped = mapGoogleManeuver(s.maneuver);
      steps.push({
        distance: s.distance?.value ?? 0,
        duration: s.duration?.value ?? 0,
        name: stripHtml(s.html_instructions),
        maneuver: mapped,
        coordinates: geometry,
      });
    }
  }

  // Geometria de overview: se vier a polyline de overview, usa-a; senão, costura
  // a geometria dos steps (fallback — nunca deixa o mapa sem linha).
  let coordinates: LatLng[] = decodePolyline(route.overview_polyline?.points).map(lite2map);
  if (coordinates.length === 0) {
    coordinates = steps.flatMap((s) => s.coordinates ?? []);
  }
  if (coordinates.length === 0) return null;

  const effectiveSeconds = hasTraffic ? trafficSeconds : durationSeconds;

  return {
    coordinates,
    distanceKm: distanceMeters / 1000,
    durationMin: Math.max(1, Math.ceil(effectiveSeconds / 60)),
    steps,
  };
}
