// rideDispatch — regra pura que decide se um motorista PODE receber uma nova
// chamada de corrida (de outro passageiro) enquanto já está em uma corrida
// ativa (aceita, a caminho, ou já com o passageiro a bordo indo ao destino).
//
// Regra de negócio (a pedido):
//   Assim que o motorista inicia o deslocamento para uma corrida — agendada
//   ou não — ele fica BLOQUEADO para novas chamadas até estar a 5 minutos ou
//   menos de FINALIZAR a corrida atual (já com o passageiro a bordo).
//   Exceção: se a nova corrida solicitada tiver o destino final igual ao (ou
//   dentro de um raio de 1km do) destino da corrida ativa dele, a chamada é
//   permitida mesmo assim — faz sentido oferecer, já que o motorista está
//   indo para aquela região de qualquer forma.
//
// Isolado de React/Supabase de propósito: pura e testável sem mocks.
import { haversineKm, type LatLng } from './airportFees';

/** Status de corrida em que o motorista já está comprometido/ocupado. */
const BUSY_STATUSES = new Set(['accepted', 'driver_en_route', 'in_progress']);

/** A quantos minutos (ou menos) do fim libera novas chamadas de novo. */
export const NEAR_FINISH_ETA_MIN = 5;

/** Raio (km) em que o destino da nova corrida é considerado "a mesma região". */
export const SAME_DESTINATION_RADIUS_KM = 1;

export type ActiveRideForDispatch = {
  id?: string;
  status?: string;
  destination_lat?: number | null;
  destination_lng?: number | null;
  destination_address?: string | null;
  /** ETA (minutos) do motorista até o alvo atual — pickup ou destino final. */
  driver_eta_min?: number | null;
};

export type RideOfferForDispatch = {
  id?: string;
  destination_lat?: number | null;
  destination_lng?: number | null;
  destination_address?: string | null;
};

function sameAddress(a?: string | null, b?: string | null): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function withinRadius(a: ActiveRideForDispatch, b: RideOfferForDispatch): boolean {
  if (
    typeof a.destination_lat !== 'number' || typeof a.destination_lng !== 'number' ||
    typeof b.destination_lat !== 'number' || typeof b.destination_lng !== 'number'
  ) {
    return false;
  }
  const from: LatLng = { lat: a.destination_lat, lng: a.destination_lng };
  const to: LatLng = { lat: b.destination_lat, lng: b.destination_lng };
  return haversineKm(from, to) <= SAME_DESTINATION_RADIUS_KM;
}

/**
 * O motorista pode receber esta nova oferta de corrida agora?
 *
 * `activeRide` = corrida em que o motorista já está comprometido (aceita, a
 * caminho do embarque, ou em andamento com o passageiro). `null`/`undefined`
 * = motorista livre, sempre pode.
 */
export function canReceiveNewRideOffer(
  activeRide: ActiveRideForDispatch | null | undefined,
  offer: RideOfferForDispatch
): boolean {
  if (!activeRide) return true;
  if (offer.id && activeRide.id && offer.id === activeRide.id) return true; // é a própria corrida ativa
  if (!activeRide.status || !BUSY_STATUSES.has(activeRide.status)) return true;

  // Prestes a terminar a corrida atual — libera novas chamadas de novo.
  if (typeof activeRide.driver_eta_min === 'number' && activeRide.driver_eta_min <= NEAR_FINISH_ETA_MIN) {
    return true;
  }

  // Exceção: mesmo destino final (endereço idêntico) ou dentro do raio de 1km.
  if (sameAddress(activeRide.destination_address, offer.destination_address)) return true;
  if (withinRadius(activeRide, offer)) return true;

  return false;
}
