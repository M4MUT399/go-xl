// Roteamento via OSRM público (OpenStreetMap) — sem API key, fallback do MVP.
const OSRM = 'https://router.project-osrm.org';

import { callEdgeFunction } from './edgeFunction';
import { normalizeGoogleDirections, type GoogleDirectionsResponse } from './nav/directions';

export interface LatLng {
  latitude: number;
  longitude: number;
}

/** Um passo da rota (manobra) retornado pelo provider de rotas */
export interface RouteStep {
  /** Distância em metros até executar esta manobra */
  distance: number;
  /** Duração estimada em segundos */
  duration: number;
  /** Nome da rua/via neste trecho */
  name: string;
  maneuver: {
    /** Tipo: 'depart' | 'turn' | 'arrive' | 'roundabout' | 'rotary' | 'fork' | 'merge' | 'on ramp' | 'off ramp' | 'end of road' | 'continue' | 'new name' */
    type: string;
    /** Direção: 'left' | 'right' | 'slight left' | 'slight right' | 'sharp left' | 'sharp right' | 'straight' | 'uturn' */
    modifier?: string;
  };
  /**
   * Geometria DETALHADA deste passo (alta resolução), quando o provider a
   * fornece por step (Google Directions). O OSRM em modo overview não popula
   * isto — fica indefinido e o map-matching cai na geometria de overview.
   * Alimenta o map-matching robusto da Fase 4 (viadutos, rampas, pistas
   * separadas).
   */
  coordinates?: LatLng[];
}

export interface RouteResult {
  coordinates: LatLng[];
  distanceKm: number;
  durationMin: number;
  steps: RouteStep[];
}

// Tipo interno para a resposta OSRM
interface OsrmStep {
  distance: number;
  duration: number;
  name?: string;
  maneuver?: { type?: string; modifier?: string };
}

interface OsrmRoute {
  distance: number;
  duration: number;
  geometry: { coordinates: [number, number][] };
  legs?: { steps?: OsrmStep[] }[];
}

export async function getRoute(
  origin: { lat: number; lng: number },
  dest: { lat: number; lng: number }
): Promise<RouteResult | null> {
  const path = `${origin.lng},${origin.lat};${dest.lng},${dest.lat}`;
  const url = `${OSRM}/route/v1/driving/${path}?overview=full&geometries=geojson&steps=true`;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as { routes?: OsrmRoute[] };
    const route = data.routes?.[0];
    if (!route) return null;

    const rawSteps: OsrmStep[] = route.legs?.[0]?.steps ?? [];
    const steps: RouteStep[] = rawSteps.map((s) => ({
      distance: s.distance ?? 0,
      duration: s.duration ?? 0,
      name: s.name ?? '',
      maneuver: {
        type: s.maneuver?.type ?? 'turn',
        modifier: s.maneuver?.modifier,
      },
    }));

    return {
      coordinates: route.geometry.coordinates.map(([lng, lat]) => ({ latitude: lat, longitude: lng })),
      distanceKm: route.distance / 1000,
      durationMin: Math.max(1, Math.ceil(route.duration / 60)),
      steps,
    };
  } catch {
    return null;
  }
}

/**
 * Fase 1 (provider) — rota via Google Directions, proxiada pela Edge Function
 * `directions` (a CHAVE fica secreta no servidor). Traz ETA com trânsito e
 * geometria por-step de alta resolução. O parsing acontece no cliente, num
 * módulo puro e testável (src/lib/nav/directions.ts).
 *
 * Retorna null em QUALQUER falha (rede, função não deployada, sem cobertura) —
 * o chamador então cai no OSRM. É gated pela flag `directions_v2` no useRoute.
 */
export async function getRouteViaDirections(
  origin: { lat: number; lng: number },
  dest: { lat: number; lng: number },
): Promise<RouteResult | null> {
  try {
    const resp = await callEdgeFunction<GoogleDirectionsResponse>('directions', {
      origin,
      dest,
    });
    return normalizeGoogleDirections(resp);
  } catch {
    return null;
  }
}
