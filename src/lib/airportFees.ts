// airportFees — taxas regulatórias de aeroporto/porto por geofence (P6).
//
// Regras do projeto:
//   • Nada de valor "chumbado": as zonas e as taxas são CONFIGURÁVEIS por
//     jurisdição (system_config, chave `airport_port_fees`). Sem zonas → 0, o
//     preço não muda em relação ao comportamento atual.
//   • Estas taxas são regulatórias (ex.: TNC fee de aeroporto da Florida): quem
//     as recolhe é a PLATAFORMA, que repassa à autoridade do aeroporto/porto.
//     Por isso, no split, elas entram no lado da plataforma — não no motorista.
//   • Geofence simples por raio (haversine). Cada zona pode cobrar na coleta
//     (origem dentro) e/ou no desembarque (destino dentro).
import { getConfigValue } from './systemConfig';

export type LatLng = { lat: number; lng: number };

export type FeeZone = {
  /** Slug estável, ex.: 'mco', 'port-canaveral'. */
  id: string;
  /** Nome legível para exibição/recibo. */
  name: string;
  /** Centro do geofence. */
  lat: number;
  lng: number;
  /** Raio do geofence em km. */
  radiusKm: number;
  /** Taxa (USD) quando a ORIGEM está dentro da zona. */
  pickupFee?: number;
  /** Taxa (USD) quando o DESTINO está dentro da zona. */
  dropoffFee?: number;
};

export type FeeLine = {
  zoneId: string;
  name: string;
  type: 'pickup' | 'dropoff';
  amount: number;
};

export type AirportFeeResult = {
  /** Soma de todas as taxas aplicáveis (USD, arredondada a centavos). */
  total: number;
  /** Detalhamento por zona/tipo — útil para recibo/waybill e UI. */
  lines: FeeLine[];
};

const EMPTY: AirportFeeResult = { total: 0, lines: [] };
const EARTH_KM = 6371;

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Distância em km entre dois pontos (haversine). Pura e testável. */
export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Ponto dentro do geofence (borda inclusiva). */
export function isInsideZone(point: LatLng, zone: FeeZone): boolean {
  if (!Number.isFinite(zone.radiusKm) || zone.radiusKm <= 0) return false;
  return haversineKm(point, { lat: zone.lat, lng: zone.lng }) <= zone.radiusKm;
}

function money(n: number | undefined): number {
  if (!Number.isFinite(n as number) || (n as number) <= 0) return 0;
  return Math.round((n as number) * 100) / 100;
}

/**
 * computeAirportFees — núcleo puro: dado origem, destino e as zonas, calcula as
 * taxas aplicáveis. A mesma zona pode cobrar pickup (origem dentro) e dropoff
 * (destino dentro) de forma independente.
 */
export function computeAirportFees(
  origin: LatLng,
  destination: LatLng,
  zones: FeeZone[]
): AirportFeeResult {
  if (!Array.isArray(zones) || zones.length === 0) return EMPTY;

  const lines: FeeLine[] = [];
  for (const zone of zones) {
    if (!zone || typeof zone.lat !== 'number' || typeof zone.lng !== 'number') continue;

    const pickup = money(zone.pickupFee);
    if (pickup > 0 && isInsideZone(origin, zone)) {
      lines.push({ zoneId: zone.id, name: zone.name, type: 'pickup', amount: pickup });
    }
    const dropoff = money(zone.dropoffFee);
    if (dropoff > 0 && isInsideZone(destination, zone)) {
      lines.push({ zoneId: zone.id, name: zone.name, type: 'dropoff', amount: dropoff });
    }
  }

  const total = Math.round(lines.reduce((sum, l) => sum + l.amount, 0) * 100) / 100;
  return { total, lines };
}

/**
 * estimateAirportFees — ponto de entrada do fluxo de preço. Lê as zonas da
 * jurisdição e devolve as taxas aplicáveis.
 *
 * Garantias de segurança (não quebrar o fluxo de corrida):
 *   • sem zonas configuradas → total 0, sem linhas.
 *   • qualquer erro (config, rede, JSON malformado) → 0, nunca lança.
 */
export async function estimateAirportFees(
  origin: LatLng,
  destination: LatLng,
  jurisdiction: string = 'global'
): Promise<AirportFeeResult> {
  try {
    const zones = await getConfigValue<FeeZone[]>('airport_port_fees', [], jurisdiction);
    return computeAirportFees(origin, destination, zones);
  } catch {
    return EMPTY;
  }
}
