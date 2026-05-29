// Roteamento via OSRM público (OpenStreetMap) — sem API key, ideal para MVP.
const OSRM = 'https://router.project-osrm.org';

export interface LatLng {
  latitude: number;
  longitude: number;
}

export interface RouteResult {
  coordinates: LatLng[];
  distanceKm: number;
  durationMin: number;
}

export async function getRoute(
  origin: { lat: number; lng: number },
  dest: { lat: number; lng: number }
): Promise<RouteResult | null> {
  const path = `${origin.lng},${origin.lat};${dest.lng},${dest.lat}`;
  const url = `${OSRM}/route/v1/driving/${path}?overview=full&geometries=geojson`;

  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      routes?: { distance: number; duration: number; geometry: { coordinates: [number, number][] } }[];
    };
    const route = data.routes?.[0];
    if (!route) return null;

    return {
      coordinates: route.geometry.coordinates.map(([lng, lat]) => ({ latitude: lat, longitude: lng })),
      distanceKm: route.distance / 1000,
      durationMin: Math.max(1, Math.ceil(route.duration / 60)),
    };
  } catch {
    return null;
  }
}
