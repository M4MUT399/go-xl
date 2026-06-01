// Roteamento via OSRM público (OpenStreetMap) — sem API key, ideal para MVP.
const OSRM = 'https://router.project-osrm.org';

export interface LatLng {
  latitude: number;
  longitude: number;
}

/** Um passo da rota (manobra) retornado pelo OSRM */
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
