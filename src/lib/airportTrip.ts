// airportTrip — corrida PARA o aeroporto exige voo e terminal.
//
// Regra de produto: sempre que o destino for um aeroporto, o passageiro TEM de
// informar o número do voo e o terminal antes de pedir ou agendar. É o que
// deixa o motorista parar na porta certa (MCO tem três terminais, e quem para
// no A com passageiro do C perde o voo dele).
//
// A detecção usa três sinais, nesta ordem, porque nenhum sozinho cobre tudo:
//   1. tipo da Google ('airport' / 'international_airport') — o mais confiável,
//      mas não existe na sugestão do fallback Nominatim;
//   2. nome/endereço ("Orlando International Airport", "Terminal C MCO"…);
//   3. geofence dos aeroportos conhecidos — pega o passageiro que escolheu um
//      ponto DENTRO do aeroporto que não se chama "airport" (um portão, um
//      restaurante do terminal, a locadora).
// Hotel é exceção explícita: o Hyatt Regency fica dentro do MCO e quem vai
// para lá está se hospedando, não embarcando.
import { haversineKm } from './airportFees';

export interface KnownAirport {
  code: string;
  name: string;
  lat: number;
  lng: number;
  /** Raio do geofence em km — cobre o terreno do aeroporto, não o entorno. */
  radiusKm: number;
  /** Terminais/áreas de embarque, na nomenclatura que o passageiro vê na passagem. */
  terminals: string[];
}

export const KNOWN_AIRPORTS: KnownAirport[] = [
  { code: 'MCO', name: 'Orlando International Airport', lat: 28.4312, lng: -81.3081, radiusKm: 3,
    terminals: ['Terminal A', 'Terminal B', 'Terminal C'] },
  { code: 'SFB', name: 'Orlando Sanford International Airport', lat: 28.7776, lng: -81.2375, radiusKm: 2,
    terminals: ['Domestic', 'International'] },
  { code: 'TPA', name: 'Tampa International Airport', lat: 27.9755, lng: -82.5332, radiusKm: 2.5,
    terminals: ['Airside A', 'Airside C', 'Airside E', 'Airside F'] },
  { code: 'MIA', name: 'Miami International Airport', lat: 25.7959, lng: -80.2870, radiusKm: 3,
    terminals: ['North Terminal (D)', 'Central Terminal (E, F, G)', 'South Terminal (H, J)'] },
  { code: 'FLL', name: 'Fort Lauderdale-Hollywood International Airport', lat: 26.0742, lng: -80.1506, radiusKm: 2.5,
    terminals: ['Terminal 1', 'Terminal 2', 'Terminal 3', 'Terminal 4'] },
  { code: 'PBI', name: 'Palm Beach International Airport', lat: 26.6832, lng: -80.0956, radiusKm: 2,
    terminals: ['Main Terminal'] },
  { code: 'JAX', name: 'Jacksonville International Airport', lat: 30.4941, lng: -81.6879, radiusKm: 2.5,
    terminals: ['Concourse A', 'Concourse B', 'Concourse C'] },
  { code: 'RSW', name: 'Southwest Florida International Airport', lat: 26.5362, lng: -81.7552, radiusKm: 2.5,
    terminals: ['Main Terminal'] },
  { code: 'MLB', name: 'Melbourne Orlando International Airport', lat: 28.1028, lng: -80.6453, radiusKm: 1.5,
    terminals: ['Main Terminal'] },
  { code: 'DAB', name: 'Daytona Beach International Airport', lat: 29.1799, lng: -81.0581, radiusKm: 1.5,
    terminals: ['Main Terminal'] },
];

export interface AirportMatch {
  /** IATA quando é um aeroporto conhecido; null para os demais. */
  code: string | null;
  name: string;
  /**
   * Opções de terminal. null = aeroporto que não conhecemos: o passageiro
   * digita o terminal em texto livre.
   */
  terminals: string[] | null;
}

export interface AirportCandidate {
  name: string;
  address: string;
  types?: string[];
  lat: number;
  lng: number;
}

const AIRPORT_TYPES = ['airport', 'international_airport'];
const LODGING_TYPES = ['lodging', 'hotel', 'resort_hotel', 'motel', 'extended_stay_hotel', 'bed_and_breakfast'];
const AIRPORT_WORD = /\b(airport|aeroporto|aeropuerto|a[ée]roport)\b/i;

function nearestKnown(lat: number, lng: number): KnownAirport | null {
  for (const a of KNOWN_AIRPORTS) {
    if (haversineKm({ lat, lng }, { lat: a.lat, lng: a.lng }) <= a.radiusKm) return a;
  }
  return null;
}

function byCodeInText(text: string): KnownAirport | null {
  for (const a of KNOWN_AIRPORTS) {
    if (new RegExp(`\\b${a.code}\\b`).test(text)) return a;
  }
  return null;
}

function asMatch(a: KnownAirport): AirportMatch {
  return { code: a.code, name: a.name, terminals: a.terminals };
}

/** Devolve o aeroporto do destino, ou null quando não é viagem para aeroporto. */
export function detectAirport(c: AirportCandidate): AirportMatch | null {
  const types = c.types ?? [];
  const text = `${c.name} ${c.address}`;
  const isAirportType = types.some((t) => AIRPORT_TYPES.includes(t));
  const isLodging = types.some((t) => LODGING_TYPES.includes(t));
  const looksAirport = AIRPORT_WORD.test(text) || !!byCodeInText(text);

  if (isLodging && !isAirportType) return null;

  const known = nearestKnown(c.lat, c.lng);
  if (known) return asMatch(known);

  if (isAirportType || looksAirport) {
    // Fora do geofence mas citando um código conhecido: aceita se estiver
    // perto (o raio do geofence é conservador de propósito).
    const byCode = byCodeInText(text);
    if (byCode && haversineKm({ lat: c.lat, lng: c.lng }, { lat: byCode.lat, lng: byCode.lng }) <= 10) {
      return asMatch(byCode);
    }
    return { code: null, name: c.name || c.address, terminals: null };
  }
  return null;
}

/**
 * Tenta adivinhar o terminal pelo nome do lugar escolhido ("Terminal C",
 * "Airside F"). Aeroporto de terminal único já vem escolhido.
 */
export function guessTerminal(match: AirportMatch, placeName: string): string {
  const opts = match.terminals;
  if (!opts) return '';
  if (opts.length === 1) return opts[0];
  const m = placeName.match(/\b(terminal|airside|concourse)\s*([A-Z0-9])\b/i);
  if (!m) return '';
  const wanted = `${m[1]} ${m[2]}`.toLowerCase();
  return opts.find((o) => o.toLowerCase().startsWith(wanted)) ?? '';
}

/** "aa 1234" → "AA1234". */
export function normalizeFlightNumber(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Código da companhia (2 caracteres IATA, podendo ter um dígito, ou 3 letras
 * ICAO) + 1 a 4 dígitos + sufixo opcional. Aceita "AA 1234", "B6 25",
 * "G4 1101", "JBU25".
 */
export function isValidFlightNumber(raw: string): boolean {
  return /^([A-Z]{2}|[A-Z][0-9]|[0-9][A-Z]|[A-Z]{3})[0-9]{1,4}[A-Z]?$/.test(normalizeFlightNumber(raw));
}

/** "AA1234" → "AA 1234", para exibição. */
export function formatFlightNumber(raw: string): string {
  const n = normalizeFlightNumber(raw);
  const m = n.match(/^([A-Z]{3}|[A-Z0-9]{2})([0-9]{1,4}[A-Z]?)$/);
  return m ? `${m[1]} ${m[2]}` : n;
}
