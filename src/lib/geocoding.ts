import type { Location } from '../types';

const NOMINATIM = 'https://nominatim.openstreetmap.org';
const HEADERS = {
  'User-Agent': 'GoXL/1.0 (ride-hailing app)',
  'Accept-Language': 'en-US',
};

export interface GeocodeResult extends Location {
  shortName: string;
}

function shorten(displayName: string): string {
  return displayName.split(',').slice(0, 2).join(',').trim();
}

export async function searchAddresses(
  query: string,
  near?: { lat: number; lng: number }
): Promise<GeocodeResult[]> {
  if (query.trim().length < 3) return [];

  const params = new URLSearchParams({
    q: query,
    format: 'json',
    addressdetails: '1',
    limit: '6',
    countrycodes: 'us',
  });

  if (near) {
    const d = 0.5;
    params.set('viewbox', `${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}`);
  }

  try {
    const res = await fetch(`${NOMINATIM}/search?${params.toString()}`, { headers: HEADERS });
    if (!res.ok) return [];
    const data = (await res.json()) as Array<{ lat: string; lon: string; display_name: string }>;
    return data.map((item) => ({
      lat: parseFloat(item.lat),
      lng: parseFloat(item.lon),
      address: item.display_name,
      shortName: shorten(item.display_name),
    }));
  } catch {
    return [];
  }
}

export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const params = new URLSearchParams({
    lat: String(lat),
    lon: String(lng),
    format: 'json',
  });

  try {
    const res = await fetch(`${NOMINATIM}/reverse?${params.toString()}`, { headers: HEADERS });
    if (!res.ok) return null;
    const data = (await res.json()) as { display_name?: string };
    return data.display_name ? shorten(data.display_name) : null;
  } catch {
    return null;
  }
}
