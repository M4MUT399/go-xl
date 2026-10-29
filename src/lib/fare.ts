// fare — a fórmula da tarifa GoXL e as cobranças que nascem DEPOIS do pedido
// (espera no embarque, mudança de rota em curso). 100% pura: o app usa via
// useRide e as Edge Functions via supabase/functions/_shared/fare.ts (re-export),
// para servidor e app nunca divergirem na conta.
//
// A explicação de cada constante da tarifa está em useRide.ts, logo acima do
// re-export de `estimatePrice` (Uber XL Orlando + $0,25/milha, tudo + 10%).

const KM_TO_MILES = 0.621371;

const UBER_XL_BASE_FARE   = 3.0;   // USD
/** $1,21 da Uber XL + $0,25 de prêmio GoXL. Ver o bloco em useRide.ts. */
const UBER_XL_PER_MILE    = 1.46;  // USD por milha
const UBER_XL_PER_MINUTE  = 0.2;   // USD por minuto
const UBER_XL_BOOKING_FEE = 3.0;   // USD (taxa de serviço/booking)
const UBER_XL_MIN_FARE    = 8.9;   // USD (piso da parte metrada)
const GOXL_MARKUP         = 1.1;   // +10% sobre a Uber
const AVG_SPEED_MPH       = 30;    // p/ estimar tempo quando não há rota

const round2 = (n: number) => Math.round(n * 100) / 100;

export function estimatePrice(distanceKm: number, durationMin = 0, surgeMultiplier = 1.0) {
  const miles = distanceKm * KM_TO_MILES;
  const minutes = Math.max(0, durationMin);
  // Parte metrada, com surge de pico e piso do mínimo da Uber.
  const metered = UBER_XL_BASE_FARE + miles * UBER_XL_PER_MILE + minutes * UBER_XL_PER_MINUTE;
  const surged = Math.max(metered * surgeMultiplier, UBER_XL_MIN_FARE);
  const uberEquivalent = surged + UBER_XL_BOOKING_FEE;
  // GoXL = tarifa Uber equivalente + 10%.
  return round2(uberEquivalent * GOXL_MARKUP);
}

export function estimateDuration(distanceKm: number) {
  const miles = distanceKm * KM_TO_MILES;
  return Math.ceil((miles / AVG_SPEED_MPH) * 60);
}

// ── Espera no embarque (29/10/2026) ──────────────────────────────────────────
// Regra do Edson: o motorista espera até 5 min de graça depois de chegar; dali
// em diante, US$ 0,75 por minuto parado sem iniciar a corrida. Conta só minuto
// CHEIO (4 min 59 s além da carência = 4 min) — o passageiro nunca paga um
// minuto que não esperou. Teto de 60 min cobrados (US$ 45): espera maior que
// isso é caso para cancelar, não para continuar cobrando.

export const WAIT_FREE_MINUTES = 5;
export const WAIT_FEE_PER_MINUTE = 0.75;
export const WAIT_MAX_BILLED_MINUTES = 60;

export interface WaitFee {
  minutes: number;
  amount: number;
}

export function waitFeeFor(arrivedAtMs: number | null, boardedAtMs: number | null): WaitFee {
  if (arrivedAtMs == null || boardedAtMs == null) return { minutes: 0, amount: 0 };
  if (!Number.isFinite(arrivedAtMs) || !Number.isFinite(boardedAtMs)) return { minutes: 0, amount: 0 };
  const waitedMs = boardedAtMs - arrivedAtMs - WAIT_FREE_MINUTES * 60_000;
  if (waitedMs <= 0) return { minutes: 0, amount: 0 };
  const minutes = Math.min(Math.floor(waitedMs / 60_000), WAIT_MAX_BILLED_MINUTES);
  return { minutes, amount: round2(minutes * WAIT_FEE_PER_MINUTE) };
}

// ── Mudança de rota em curso (29/10/2026) ────────────────────────────────────
// O passageiro pode trocar o destino ou incluir paradas com a corrida em
// andamento. A tarifa NÃO é recotada do zero (o pico mudou, o trânsito mudou):
// aplica-se a DIFERENÇA entre a fórmula na rota nova e na rota cotada, com o
// mesmo multiplicador de pico do pedido. Assim o passageiro paga exatamente o
// trecho a mais (ou recebe de volta o trecho a menos), e a tarifa nunca cai
// abaixo do mínimo da fórmula.

/** Pico pelo relógio de Orlando no instante do pedido — mesma tabela de lib/surge.ts. */
export function surgeForHour(hour: number): number {
  if (hour >= 7 && hour < 9) return 1.3;
  if (hour >= 17 && hour < 20) return 1.3;
  if (hour >= 0 && hour < 5) return 1.2;
  return 1.0;
}

export function orlandoHour(iso: string): number {
  const h = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', hourCycle: 'h23', timeZone: 'America/New_York',
  }).format(new Date(iso));
  return Number(h) % 24;
}

export interface RouteLeg {
  distanceKm: number;
  durationMin: number;
}

/**
 * Nova tarifa (sem pedágio/taxa de aeroporto) depois da mudança de rota.
 * @param currentFare tarifa metrada atual da corrida (price − pedágio − taxa)
 * @param quoted      distância/tempo com que a tarifa atual foi cotada
 * @param next        distância/tempo da rota nova (origem → paradas → destino)
 * @param surge       multiplicador de pico do pedido original
 */
export function fareAfterRouteChange(
  currentFare: number,
  quoted: RouteLeg,
  next: RouteLeg,
  surge = 1.0,
): number {
  const delta = estimatePrice(next.distanceKm, next.durationMin, surge)
    - estimatePrice(quoted.distanceKm, quoted.durationMin, surge);
  const floor = estimatePrice(0, 0, 1.0);
  return round2(Math.max(currentFare + delta, floor));
}
