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

/**
 * As MESMAS leituras acima, mas SEM o FALLBACK: devolvem `null` quando a
 * corrida não traz a coordenada.
 *
 * ── POR QUE ISTO PRECISA EXISTIR ───────────────────────────────────────────
 *
 * O `FALLBACK` do topo é o centro de Orlando, e ele existe para o MAPA INTERNO
 * não quebrar quando falta dado — ali um mapa visivelmente no lugar errado é
 * um sintoma que o motorista percebe na hora.
 *
 * Entregar essa mesma coordenada a um app de fora é outra coisa: o Waze não
 * sabe que ela é um chute e começa a guiar, com voz e confiança, para o centro
 * da cidade. O motorista segue a instrução em vez de desconfiar dela.
 *
 * Por isso quem vai passar a coordenada adiante — hoje a barra
 * `ExternalNavBar` — usa estas funções, e some quando o valor é nulo. A regra:
 * chutar posição para DESENHAR é aceitável; chutar posição para NAVEGAR não é.
 *
 * A precedência (objeto aninhado da view `rides_with_locations` antes dos
 * campos planos) é a mesma das funções acima, de propósito: divergir nisso
 * faria a barra sumir em corrida que a tela desenha sem problema.
 */
export function rideOriginOrNull(ride: Ride): { lat: number | null; lng: number | null; address?: string } {
  if (ride.origin) return { lat: ride.origin.lat, lng: ride.origin.lng, address: ride.origin.address };
  return {
    lat: ride.origin_lat ?? null,
    lng: ride.origin_lng ?? null,
    address: ride.origin_address ?? undefined,
  };
}

export function rideDestinationOrNull(ride: Ride): { lat: number | null; lng: number | null; address?: string } {
  if (ride.destination) return { lat: ride.destination.lat, lng: ride.destination.lng, address: ride.destination.address };
  return {
    lat: ride.destination_lat ?? null,
    lng: ride.destination_lng ?? null,
    address: ride.destination_address ?? undefined,
  };
}
