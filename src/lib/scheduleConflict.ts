// Detecção de conflito entre corridas AGENDADAS de um mesmo motorista.
//
// Regra (pedido do produto): o motorista NÃO pode aceitar um agendamento que se
// sobreponha a outro que ele já confirmou. O cálculo considera:
//   • a duração da rota da corrida já confirmada (scheduled_for + duration_min);
//   • o tempo de DESLOCAMENTO do destino de uma até a origem da outra (OSRM);
//   • uma FOLGA fixa de 20 minutos entre todo o processo, para não atrasar o
//     segundo agendamento.
//
// A função-núcleo `slotsConflict` é PURA e sem rede (fácil de testar). O
// orquestrador `checkScheduleConflict` injeta um resolvedor de tempo de
// deslocamento (default = OSRM via getRoute), então também é testável com stub.

import { getRoute } from './routing';

/** Folga fixa, em minutos, exigida entre o fim de uma corrida e o início da próxima. */
export const SCHEDULE_BUFFER_MIN = 20;

export interface LatLng {
  lat: number;
  lng: number;
}

export interface SchedSlot {
  id: string;
  /** Início agendado, em epoch ms. */
  startMs: number;
  /** Duração da rota da própria corrida, em minutos. */
  durationMin: number;
  origin: LatLng;
  destination: LatLng;
}

/** Corrida mínima aceita pelos orquestradores (compatível com RideRecord). */
export interface RideLike {
  id: string;
  scheduled_for?: string;
  duration_min?: number;
  origin_lat: number;
  origin_lng: number;
  destination_lat: number;
  destination_lng: number;
}

export interface ConflictResult {
  conflict: boolean;
  /** Id da corrida já confirmada que gera o conflito. */
  withRideId?: string;
  /** scheduled_for (ISO) da corrida conflitante — usado na mensagem ao motorista. */
  withScheduledFor?: string;
}

/**
 * Núcleo PURO: dados dois slots já ORDENADOS no tempo (`first.startMs <=
 * second.startMs`) e o tempo de deslocamento do DESTINO de `first` até a ORIGEM
 * de `second`, decide se há conflito.
 *
 * Conflita quando o motorista não consegue: concluir `first`, deslocar-se até a
 * origem de `second` e ainda começar `second` com `bufferMin` de folga.
 */
export function slotsConflict(
  first: SchedSlot,
  second: SchedSlot,
  travelMin: number,
  bufferMin: number = SCHEDULE_BUFFER_MIN,
): boolean {
  const firstEndMs = first.startMs + first.durationMin * 60_000;
  const requiredSecondStartMs = firstEndMs + (travelMin + bufferMin) * 60_000;
  return second.startMs < requiredSecondStartMs;
}

/**
 * Resolvedor de tempo de deslocamento (em minutos) entre dois pontos.
 * Injetável para testes; o default usa OSRM (getRoute) com fallback haversine.
 */
export type TravelMinResolver = (from: LatLng, to: LatLng) => Promise<number>;

/** Distância em linha reta (km) — usada só como fallback se o OSRM falhar. */
function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/**
 * Estimativa de deslocamento por fallback quando o OSRM não responde. Aplica um
 * fator de 1,3 sobre a linha reta (aproxima a malha viária) a ~35 km/h urbano.
 */
export function fallbackTravelMin(from: LatLng, to: LatLng): number {
  const roadKm = haversineKm(from, to) * 1.3;
  return Math.max(1, Math.round((roadKm / 35) * 60));
}

const osrmTravelMin: TravelMinResolver = async (from, to) => {
  const r = await getRoute(from, to);
  return r?.durationMin ?? fallbackTravelMin(from, to);
};

/** Converte uma corrida em SchedSlot; devolve null se não houver horário válido. */
async function toSlot(ride: RideLike, resolve: TravelMinResolver): Promise<SchedSlot | null> {
  if (!ride.scheduled_for) return null;
  const startMs = new Date(ride.scheduled_for).getTime();
  if (Number.isNaN(startMs)) return null;

  const origin: LatLng = { lat: ride.origin_lat, lng: ride.origin_lng };
  const destination: LatLng = { lat: ride.destination_lat, lng: ride.destination_lng };

  // Se a corrida não tem duração gravada, estima a rota origem→destino.
  const durationMin =
    ride.duration_min && ride.duration_min > 0
      ? ride.duration_min
      : await resolve(origin, destination);

  return { id: ride.id, startMs, durationMin, origin, destination };
}

/**
 * Verifica se `candidate` conflita com QUALQUER corrida de `existing` (as já
 * confirmadas pelo motorista). Retorna o primeiro conflito encontrado.
 */
export async function checkScheduleConflict(
  candidate: RideLike,
  existing: RideLike[],
  bufferMin: number = SCHEDULE_BUFFER_MIN,
  resolve: TravelMinResolver = osrmTravelMin,
): Promise<ConflictResult> {
  const cand = await toSlot(candidate, resolve);
  if (!cand) return { conflict: false };

  for (const ex of existing) {
    if (ex.id === candidate.id) continue;
    const other = await toSlot(ex, resolve);
    if (!other) continue;

    // Ordena no tempo e mede o deslocamento no sentido correto:
    // do DESTINO da que acontece antes até a ORIGEM da que acontece depois.
    const [first, second] =
      cand.startMs <= other.startMs ? [cand, other] : [other, cand];
    const travelMin = await resolve(first.destination, second.origin);

    if (slotsConflict(first, second, travelMin, bufferMin)) {
      return { conflict: true, withRideId: ex.id, withScheduledFor: ex.scheduled_for };
    }
  }

  return { conflict: false };
}
