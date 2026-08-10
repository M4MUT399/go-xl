import type { Location } from '../types';
import { callEdgeFunction } from './edgeFunction';

// ─── Google Places / Geocoding (principal) ──────────────────────────────────
// Item #81: antes disso fazíamos fetch() DIRETO da Google aqui, com a chave
// como query param — uma chamada REST do cliente nunca pode ser restringida
// por app no Google Cloud, então essa chave era necessariamente irrestrita e
// extraível do bundle publicado. Agora a chamada passa pela Edge Function
// `places-search` (mesmo padrão de src/lib/nav/directions.ts): a chave real
// (GOOGLE_PLACES_API_KEY) fica só no servidor, nunca embutida no app. Ver
// supabase/functions/places-search/index.ts.

interface GooglePlaceApiResult {
  name: string;
  formatted_address: string;
  geometry: { location: { lat: number; lng: number } };
  types?: string[];
}

// ─── Nominatim (fallback gratuito) ──────────────────────────────────────────
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const NOMINATIM_HEADERS = {
  'User-Agent': 'GoXL/1.0 (ride-hailing app)',
  'Accept-Language': 'en-US',
};

export interface GeocodeResult extends Location {
  /** Nome curto/principal — ex.: "AdventHealth Orlando" ou "S Orange Ave". */
  shortName: string;
  /** Categoria do local (hospital, school, restaurant…), quando disponível. */
  category?: string;
}

function shorten(displayName: string): string {
  return displayName.split(',').slice(0, 2).join(',').trim();
}

/** Emoji por tipo de POI para enriquecer visualmente a lista. */
function categoryLabel(types: string[] = []): string | undefined {
  const map: Record<string, string> = {
    hospital: 'Hospital',
    doctor: 'Clínica',
    health: 'Saúde',
    pharmacy: 'Farmácia',
    school: 'Escola',
    university: 'Universidade',
    tourist_attraction: 'Ponto turístico',
    airport: 'Aeroporto',
    lodging: 'Hotel',
    restaurant: 'Restaurante',
    cafe: 'Café',
    bar: 'Bar',
    shopping_mall: 'Shopping',
    store: 'Loja',
    supermarket: 'Mercado',
    bank: 'Banco',
    gym: 'Academia',
    park: 'Parque',
    stadium: 'Estádio',
    church: 'Igreja',
    gas_station: 'Posto',
  };
  for (const t of types) if (map[t]) return map[t];
  return undefined;
}

// ─── Busca via Google Places Text Search (proxiada pela Edge Function) ──────
async function googleTextSearch(
  query: string,
  near?: { lat: number; lng: number }
): Promise<GeocodeResult[]> {
  const { results } = await callEdgeFunction<{ results: GooglePlaceApiResult[] }>(
    'places-search',
    { action: 'search', query, near }
  );

  return (results ?? []).map((item) => ({
    lat: item.geometry.location.lat,
    lng: item.geometry.location.lng,
    address: item.formatted_address,
    shortName: item.name,
    category: categoryLabel(item.types),
  }));
}

// ─── Busca via Nominatim (fallback) ─────────────────────────────────────────
async function nominatimSearch(
  query: string,
  near?: { lat: number; lng: number }
): Promise<GeocodeResult[]> {
  const params = new URLSearchParams({
    q: query,
    format: 'json',
    addressdetails: '1',
    limit: '10',
    countrycodes: 'us',
  });
  if (near) {
    const d = 0.5;
    params.set('viewbox', `${near.lng - d},${near.lat + d},${near.lng + d},${near.lat - d}`);
  }

  const res = await fetch(`${NOMINATIM}/search?${params.toString()}`, {
    headers: NOMINATIM_HEADERS,
  });
  if (!res.ok) return [];
  const data = (await res.json()) as Array<{
    lat: string;
    lon: string;
    display_name: string;
  }>;
  return data.map((item) => ({
    lat: parseFloat(item.lat),
    lng: parseFloat(item.lon),
    address: item.display_name,
    shortName: shorten(item.display_name),
  }));
}

export async function searchAddresses(
  query: string,
  near?: { lat: number; lng: number }
): Promise<GeocodeResult[]> {
  if (query.trim().length < 3) return [];

  // 1) Google Places — resultados ricos (endereços, comércios, hospitais,
  //    escolas, pontos turísticos…). 2) Fallback para Nominatim em caso de erro.
  try {
    const results = await googleTextSearch(query, near);
    if (results.length > 0) return results;
  } catch {
    // segue para o fallback
  }

  try {
    return await nominatimSearch(query, near);
  } catch {
    return [];
  }
}

export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  // Google reverse geocoding (mais preciso), proxiado pela Edge Function
  // `places-search` — ver comentário no topo do arquivo (item #81).
  try {
    const { formatted_address } = await callEdgeFunction<{ formatted_address: string | null }>(
      'places-search',
      { action: 'reverse', lat, lng }
    );
    if (formatted_address) return shorten(formatted_address);
  } catch {
    // segue para o fallback
  }

  // Fallback Nominatim
  try {
    const params = new URLSearchParams({
      lat: String(lat),
      lon: String(lng),
      format: 'json',
    });
    const res = await fetch(`${NOMINATIM}/reverse?${params.toString()}`, {
      headers: NOMINATIM_HEADERS,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { display_name?: string };
    return data.display_name ? shorten(data.display_name) : null;
  } catch {
    return null;
  }
}
