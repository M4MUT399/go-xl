// Lógica PURA de formatação do payload público de rastreio de viagem (Tarefa 1).
//
// Fonte única de verdade da whitelist: este módulo não faz I/O, não importa nada
// (compatível tanto com Deno na Edge Function `track-trip` quanto com o Jest do
// app). A Edge Function busca as linhas do banco com service_role e delega a
// DECISÃO (ativo/inativo) e a MONTAGEM do payload a `shapeTripPayload`. Assim o
// contrato "nunca vaza telefone/e-mail/preço" fica coberto por teste.

export const ENDED_STATUSES = ['completed', 'cancelled'];

export type PublicTripPayload =
  | { active: false; reason: 'not_found' | 'expired' | 'ended' }
  | {
      active: true;
      status: string;
      origin: { lat: number; lng: number; address: string };
      destination: { lat: number; lng: number; address: string };
      position: { lat: number; lng: number; heading: number | null } | null;
      eta_min: number | null;
      driver: {
        first_name: string;
        avatar_url: string | null;
        vehicle: { model: string; color: string; plate: string } | null;
      } | null;
    };

// Linhas cruas vindas do banco. Propositalmente NÃO listamos price, phone nem
// email aqui: o shaping só copia os campos abaixo, então mesmo que a linha real
// traga colunas sensíveis, elas jamais entram no payload público.
export interface RawShare {
  expires_at: string;
  revoked_at: string | null;
}
export interface RawRide {
  status: string;
  driver_id: string | null;
  origin_lat: number;
  origin_lng: number;
  origin_address: string;
  destination_lat: number;
  destination_lng: number;
  destination_address: string;
  driver_lat: number | null;
  driver_lng: number | null;
  driver_heading: number | null;
  driver_eta_min: number | null;
}
export interface RawDriverProfile {
  full_name: string | null;
  avatar_url: string | null;
}
export interface RawVehicle {
  model: string;
  color: string;
  plate: string;
}
export interface RawDriverLocation {
  lat: number;
  lng: number;
  heading: number | null;
}

/** Primeiro nome do motorista (nunca o nome completo). */
export function firstName(fullName: string | null | undefined): string {
  const n = (fullName ?? '').trim();
  if (!n) return 'Motorista';
  return n.split(/\s+/)[0];
}

export interface ShapeInput {
  share: RawShare | null;
  ride: RawRide | null;
  driverProfile: RawDriverProfile | null;
  vehicle: RawVehicle | null;
  driverLocation: RawDriverLocation | null;
  /** Instante de referência (default Date.now()) — injetável para testes. */
  now?: number;
}

/**
 * Decide se o link está ativo e monta o payload PÚBLICO whitelistado.
 *
 * Ordem das regras (idêntica à da Edge Function):
 *   1. sem share            → not_found
 *   2. revogado / expirado  → expired
 *   3. sem corrida          → not_found
 *   4. corrida encerrada    → ended
 *   5. caso contrário       → active + campos whitelistados
 */
export function shapeTripPayload(input: ShapeInput): PublicTripPayload {
  const { share, ride, driverProfile, vehicle, driverLocation } = input;
  const now = input.now ?? Date.now();

  if (!share) return { active: false, reason: 'not_found' };
  if (share.revoked_at) return { active: false, reason: 'expired' };
  if (new Date(share.expires_at).getTime() < now) return { active: false, reason: 'expired' };

  if (!ride) return { active: false, reason: 'not_found' };
  if (ENDED_STATUSES.includes(ride.status)) return { active: false, reason: 'ended' };

  // Identidade do motorista: só primeiro nome + foto + veículo. Nunca telefone/e-mail.
  let driverOut: {
    first_name: string;
    avatar_url: string | null;
    vehicle: { model: string; color: string; plate: string } | null;
  } | null = null;
  if (ride.driver_id) {
    driverOut = {
      first_name: firstName(driverProfile?.full_name),
      avatar_url: driverProfile?.avatar_url ?? null,
      vehicle: vehicle
        ? { model: vehicle.model, color: vehicle.color, plate: vehicle.plate }
        : null,
    };
  }

  // Posição ao vivo: telemetria gravada na corrida tem prioridade; senão, cai
  // para a última posição conhecida em driver_locations.
  let position: { lat: number; lng: number; heading: number | null } | null = null;
  if (ride.driver_lat != null && ride.driver_lng != null) {
    position = { lat: ride.driver_lat, lng: ride.driver_lng, heading: ride.driver_heading };
  } else if (ride.driver_id && driverLocation) {
    position = { lat: driverLocation.lat, lng: driverLocation.lng, heading: driverLocation.heading };
  }

  return {
    active: true,
    status: ride.status,
    origin: { lat: ride.origin_lat, lng: ride.origin_lng, address: ride.origin_address },
    destination: {
      lat: ride.destination_lat,
      lng: ride.destination_lng,
      address: ride.destination_address,
    },
    position,
    eta_min: ride.driver_eta_min,
    driver: driverOut,
  };
}
