import type { Ride, Location } from '../types';

// Coordenada padrão (centro de Orlando) — só usada se não houver dado algum.
const FALLBACK = { lat: 28.5383, lng: -81.3792 };

/**
 * Lê a origem da corrida tanto do objeto aninhado (view rides_with_locations)
 * quanto dos campos planos (tabela rides via realtime/insert).
 */
export function rideOrigin(ride: Ride): Location {
  if (ride.origin) return ride.origin;
  return {
    lat: ride.origin_lat ?? FALLBACK.lat,
    lng: ride.origin_lng ?? FALLBACK.lng,
    address: ride.origin_address ?? 'Local de embarque',
  };
}

export function rideDestination(ride: Ride): Location {
  if (ride.destination) return ride.destination;
  return {
    lat: ride.destination_lat ?? FALLBACK.lat,
    lng: ride.destination_lng ?? FALLBACK.lng,
    address: ride.destination_address ?? 'Destino',
  };
}
