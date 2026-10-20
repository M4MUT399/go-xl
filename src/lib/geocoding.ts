import type { Coordinates } from '../types';
import { callEdgeFunction } from './edgeFunction';
import { startTiming } from './fieldMetrics';

// ─── Google Places / Geocoding (principal) ──────────────────────────────────
// Item #81: antes disso fazíamos fetch() DIRETO da Google aqui, com a chave
// como query param — uma chamada REST do cliente nunca pode ser restringida
// por app no Google Cloud, então essa chave era necessariamente irrestrita e
// extraível do bundle publicado. Agora a chamada passa pela Edge Function
// `places-search` (mesmo padrão de src/lib/nav/directions.ts): a chave real
// (GOOGLE_PLACES_API_KEY) fica só no servidor, nunca embutida no app. Ver
// supabase/functions/places-search/index.ts.

interface GoogleAutocompleteSuggestion {
  placePrediction?: {
    placeId?: string;
    text?: { text?: string };
    structuredFormat?: {
      mainText?: { text?: string };
      secondaryText?: { text?: string };
    };
    types?: string[];
  };
}

// ─── Nominatim (fallback gratuito) ──────────────────────────────────────────
const NOMINATIM = 'https://nominatim.openstreetmap.org';
const NOMINATIM_HEADERS = {
  'User-Agent': 'GoXL/1.0 (ride-hailing app)',
  'Accept-Language': 'en-US',
};

export interface PlaceSuggestion {
  /** Id da Google. Vazio quando a sugestão veio do fallback Nominatim. */
  placeId: string;
  /** Nome curto/principal — ex.: "AdventHealth Orlando" ou "S Orange Ave". */
  shortName: string;
  address: string;
  /** Categoria do local (hospital, school, restaurant…), quando disponível. */
  category?: string;
  /** Tipos crus da Google (ex.: 'airport', 'lodging'). Vazio no fallback. */
  types?: string[];
  /**
   * Só o fallback já chega com coordenada. Na Google a predição NÃO traz
   * geometria — ela só vem no `resolvePlace`, e é justamente essa segunda
   * chamada que fecha a sessão de cobrança.
   */
  location?: Coordinates;
}

/**
 * Token de sessão da Google: é o que faz autocomplete + details serem cobrados
 * como uma sessão só, em vez de uma requisição por tecla digitada.
 *
 * Não é credencial — não autentica nem protege nada, só agrupa chamadas —, por
 * isso não precisa de gerador criptográfico. A Google só exige que seja único
 * por sessão e recomenda o formato UUID v4.
 */
export function newSessionToken(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function shorten(displayName: string): string {
  return displayName.split(',').slice(0, 2).join(',').trim();
}

/** Emoji por tipo de POI para enriquecer visualmente a lista. */
function categoryLabel(types: string[] = []): string | undefined {
  const map: Record<string, string> = {
    airport: 'Aeroporto',
    international_airport: 'Aeroporto',
    hospital: 'Hospital',
    doctor: 'Clínica',
    health: 'Saúde',
    pharmacy: 'Farmácia',
    school: 'Escola',
    university: 'Universidade',
    tourist_attraction: 'Ponto turístico',
    hotel: 'Hotel',
    resort_hotel: 'Resort',
    lodging: 'Hotel',
    medical_clinic: 'Clínica',
    dentist: 'Dentista',
    physiotherapist: 'Fisioterapia',
    convention_center: 'Centro de convenções',
    amusement_park: 'Parque',
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

// ─── Autocomplete via Google Places (proxiado pela Edge Function) ───────────
async function googleAutocomplete(
  query: string,
  sessionToken: string,
  near?: { lat: number; lng: number }
): Promise<PlaceSuggestion[]> {
  const { suggestions } = await callEdgeFunction<{ suggestions: GoogleAutocompleteSuggestion[] }>(
    'places-search',
    { action: 'autocomplete', query, near, sessionToken }
  );

  return (suggestions ?? [])
    .map((s) => s.placePrediction)
    .filter((p): p is NonNullable<typeof p> => !!p?.placeId)
    .map((p) => ({
      placeId: p.placeId!,
      shortName: p.structuredFormat?.mainText?.text ?? p.text?.text ?? '',
      address: p.structuredFormat?.secondaryText?.text ?? p.text?.text ?? '',
      category: categoryLabel(p.types),
      types: p.types ?? [],
    }));
}

// ─── Busca ampla via Google Text Search (proxiado pela Edge Function) ───────
interface GoogleTextSearchPlace {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  types?: string[];
}

async function googleTextSearch(
  query: string,
  near?: { lat: number; lng: number }
): Promise<PlaceSuggestion[]> {
  const { places } = await callEdgeFunction<{ places: GoogleTextSearchPlace[] }>(
    'places-search',
    { action: 'textsearch', query, near }
  );

  return (places ?? [])
    .filter((p) =>
      !!p.id && typeof p.location?.latitude === 'number' && typeof p.location?.longitude === 'number'
    )
    .map((p) => ({
      placeId: p.id!,
      shortName: p.displayName?.text ?? p.formattedAddress ?? '',
      address: p.formattedAddress ?? '',
      category: categoryLabel(p.types),
      types: p.types ?? [],
      // Já vem com coordenada: escolher daqui não precisa do details.
      location: { lat: p.location!.latitude!, lng: p.location!.longitude! },
    }));
}

/**
 * Junta duas listas sem repetir lugar. A primeira manda na ordem (é a que o
 * passageiro já está vendo); da segunda entram só os lugares novos. Quando o
 * mesmo lugar aparece nas duas, fica a versão que já tem coordenada — escolher
 * essa dispensa uma ida à rede.
 */
export function mergeSuggestions(
  first: PlaceSuggestion[],
  second: PlaceSuggestion[]
): PlaceSuggestion[] {
  const key = (s: PlaceSuggestion) =>
    s.placeId || `${s.shortName}|${s.address}`.toLowerCase();
  const byKey = new Map<string, PlaceSuggestion>();
  const order: string[] = [];
  for (const s of [...first, ...second]) {
    const k = key(s);
    const prev = byKey.get(k);
    if (!prev) {
      byKey.set(k, s);
      order.push(k);
    } else if (!prev.location && s.location) {
      byKey.set(k, { ...prev, location: s.location, types: prev.types?.length ? prev.types : s.types });
    }
  }
  return order.map((k) => byKey.get(k)!);
}

// ─── Busca via Nominatim (fallback) ─────────────────────────────────────────
async function nominatimSearch(
  query: string,
  near?: { lat: number; lng: number }
): Promise<PlaceSuggestion[]> {
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
    placeId: '',
    address: item.display_name,
    shortName: shorten(item.display_name),
    location: { lat: parseFloat(item.lat), lng: parseFloat(item.lon) },
  }));
}

/**
 * Sugestões para o que está sendo digitado. O `sessionToken` tem de ser o
 * mesmo em todas as teclas da MESMA busca e o mesmo entregue depois ao
 * `resolvePlace` — é isso que a Google cobra como uma sessão só.
 */
export async function searchPlaces(
  query: string,
  sessionToken: string,
  near?: { lat: number; lng: number }
): Promise<PlaceSuggestion[]> {
  if (query.trim().length < 3) return [];

  // Cronômetro aberto DEPOIS do corte de 3 caracteres: aquele retorno não faz
  // ida à rede, e contá-lo como amostra encheria a série de zeros e faria a
  // régua de 300 ms parecer folgada. O texto digitado nunca entra no contexto
  // — endereço de embarque é dado de quem viaja, não métrica.
  const fim = startTiming('autocomplete_round_trip');

  // 1) Google Places — resultados ricos (endereços, comércios, hospitais,
  //    escolas, pontos turísticos…). 2) Fallback para Nominatim em caso de erro.
  try {
    const results = await googleAutocomplete(query, sessionToken, near);
    if (results.length > 0) {
      fim({ source: 'google', results: results.length });
      return results;
    }
  } catch {
    // segue para o fallback
  }

  try {
    // A Google respondendo vazio também cai aqui, e a amostra sai como
    // 'nominatim' de propósito: quem digitou esperou as DUAS idas.
    const results = await nominatimSearch(query, near);
    fim({ source: 'nominatim', results: results.length });
    return results;
  } catch {
    fim({ source: 'failed', results: 0 });
    return [];
  }
}

/**
 * Busca AMPLA — a mesma do Google Maps. Pega o que o autocomplete deixa de
 * fora (hotel, clínica, consultório, loja pelo nome; até 20 resultados) e
 * mescla com a lista do autocomplete. É mais cara por chamada que o
 * autocomplete, por isso a tela só a dispara quando a digitação assenta
 * (debounce maior), não a cada tecla.
 *
 * Nunca lança: se a busca ampla falhar, devolve o que o autocomplete deu.
 */
export async function searchPlacesWide(
  query: string,
  sessionToken: string,
  near?: { lat: number; lng: number }
): Promise<PlaceSuggestion[]> {
  if (query.trim().length < 3) return [];

  const fim = startTiming('wide_search_round_trip');
  const [auto, wide] = await Promise.all([
    googleAutocomplete(query, sessionToken, near).catch(() => [] as PlaceSuggestion[]),
    googleTextSearch(query, near).catch(() => [] as PlaceSuggestion[]),
  ]);
  const merged = mergeSuggestions(auto, wide);
  if (merged.length > 0) {
    fim({ source: 'google_wide', results: merged.length });
    return merged;
  }

  try {
    const results = await nominatimSearch(query, near);
    fim({ source: 'nominatim', results: results.length });
    return results;
  } catch {
    fim({ source: 'failed', results: 0 });
    return [];
  }
}

/**
 * Converte a sugestão escolhida em coordenada — e, com isso, FECHA a sessão
 * na Google. Depois desta chamada o token está queimado: quem chamou precisa
 * gerar um novo antes da próxima busca, senão a Google volta a cobrar por
 * requisição.
 *
 * Devolve `null` quando não dá para resolver (rede, sessão, lugar sumido). Sem
 * coordenada não há corrida, então o chamador precisa tratar — o custo de
 * engolir isso em silêncio seria um toque na sugestão que não faz nada.
 */
export async function resolvePlace(
  suggestion: PlaceSuggestion,
  sessionToken: string
): Promise<Coordinates | null> {
  // O fallback já veio com coordenada e não tem sessão na Google para fechar.
  if (suggestion.location) return suggestion.location;
  if (!suggestion.placeId) return null;

  // Só o caminho que realmente vai à rede é cronometrado; os dois retornos
  // acima são decisões locais.
  const fim = startTiming('place_details_round_trip');

  try {
    const { location } = await callEdgeFunction<{
      location: { latitude: number; longitude: number } | null;
    }>('places-search', {
      action: 'details',
      placeId: suggestion.placeId,
      sessionToken,
    });
    if (!location) {
      fim({ resolved: false });
      return null;
    }
    fim({ resolved: true });
    return { lat: location.latitude, lng: location.longitude };
  } catch {
    fim({ resolved: false, failed: true });
    return null;
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
