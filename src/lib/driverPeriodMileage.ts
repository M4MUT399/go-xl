// driverPeriodMileage — acumulador PURO de milhas GPS por período (P1/P2/P3),
// Bloco 1 do compliance F.S. 627.748. Companion de driverPeriodMachine.ts:
// aquele decide QUAL período está ativo; este decide QUANTA distância válida
// creditar a esse período a cada leitura de GPS.
//
// Reutiliza os mesmos princípios anti-drift do tracker de jornada existente
// (src/lib/dutyMovement.ts): decisões por timestamp, sem estado em memória
// não-serializável.
//
// Duas classes de leitura são descartadas (não creditadas a nenhum período):
//   • jitter — deslocamento menor que `minDeltaMiles` entre duas leituras
//     (ruído de GPS parado, evita "andar" milhas enquanto o carro está parado
//     num sinal).
//   • salto implausível — velocidade IMPLÍCITA entre duas leituras acima de
//     `maxImpliedMph`. Isso tipicamente indica perda de sinal por um tempo
//     (o device ficou sem fix e depois voltou longe) OU um erro de GPS. Nesse
//     caso NÃO fazemos a distância em linha reta contar (superestimaria em
//     curva/serra) — o chamador (camada impura, com acesso a src/lib/routing.ts)
//     deve pedir a distância de ROTA entre os dois pontos e creditar aquilo,
//     marcando o registro como `estimated=true` (trecho estimado, não medido
//     diretamente) — ver `driver_period_transitions.mileage_source`.
//
// Isolado de React/RN de propósito: exercitável em teste unitário.

const EARTH_RADIUS_MILES = 3958.7613;

export interface GpsPoint {
  lat: number;
  lng: number;
  /** Epoch ms UTC do servidor (ou do device, se corrigido) — não é usado para decidir período, só distância/tempo. */
  atMs: number;
}

/** Distância em linha reta (haversine) entre dois pontos, em milhas. */
export function haversineMiles(a: GpsPoint, b: GpsPoint): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;
  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_MILES * c;
}

export interface MileageSampleConfig {
  /** Distância mínima (milhas) entre pontos para contar como deslocamento real. */
  minDeltaMiles: number;
  /** Velocidade implícita máxima plausível (mph) entre duas leituras consecutivas. */
  maxImpliedMph: number;
}

export const DEFAULT_MILEAGE_SAMPLE: MileageSampleConfig = {
  minDeltaMiles: 0.005, // ≈ 8 m — abaixo disso é ruído de GPS parado
  maxImpliedMph: 110, // acima disso, quase certamente salto/perda de sinal, não tráfego real
};

export type MileageStepOutcome =
  | { kind: 'credited'; miles: number; estimated: false }
  | { kind: 'jitter' } // descartado, não credita, não marca como gap
  | { kind: 'needs_interpolation'; from: GpsPoint; to: GpsPoint }; // chamador deve pedir distância de rota

/**
 * Classifica o deslocamento entre duas leituras consecutivas de GPS. NÃO
 * decide o período (isso é responsabilidade de driverPeriodMachine) — só
 * quanto contar como milhas válidas medidas diretamente, versus o que precisa
 * de interpolação por rota (camada impura, fora deste módulo).
 */
export function stepMileage(
  prev: GpsPoint | null,
  curr: GpsPoint,
  cfg: MileageSampleConfig = DEFAULT_MILEAGE_SAMPLE,
): MileageStepOutcome {
  if (!prev) return { kind: 'jitter' }; // primeira leitura da sessão — nada a medir ainda
  const dtHours = (curr.atMs - prev.atMs) / 3_600_000;
  if (dtHours <= 0) return { kind: 'jitter' }; // timestamp não-monotônico — ignora
  const dist = haversineMiles(prev, curr);
  if (dist < cfg.minDeltaMiles) return { kind: 'jitter' };
  const impliedMph = dist / dtHours;
  if (impliedMph > cfg.maxImpliedMph) {
    return { kind: 'needs_interpolation', from: prev, to: curr };
  }
  return { kind: 'credited', miles: dist, estimated: false };
}

// ─── Acumulador por período ───────────────────────────────────────────────

export interface DriverPeriodMileage {
  p1Miles: number;
  p2Miles: number;
  p3Miles: number;
  /** Soma das milhas creditadas via interpolação de rota (trecho estimado), para transparência no relatório. */
  estimatedMiles: number;
}

export function emptyDriverPeriodMileage(): DriverPeriodMileage {
  return { p1Miles: 0, p2Miles: 0, p3Miles: 0, estimatedMiles: 0 };
}

function bucketKey(period: 'P0_OFFLINE' | 'P1_AVAILABLE' | 'P2_ENROUTE' | 'P3_ONTRIP'): keyof DriverPeriodMileage | null {
  switch (period) {
    case 'P1_AVAILABLE':
      return 'p1Miles';
    case 'P2_ENROUTE':
      return 'p2Miles';
    case 'P3_ONTRIP':
      return 'p3Miles';
    default:
      return null; // P0 não acumula milhagem de compliance
  }
}

/**
 * Credita `miles` ao bucket do período informado. `estimated=true` também
 * soma ao total `estimatedMiles` (não é um bucket separado — é uma marcação
 * de proveniência sobre a milhagem já contabilizada no período correto).
 */
export function addDriverPeriodMileage(
  m: DriverPeriodMileage,
  period: 'P0_OFFLINE' | 'P1_AVAILABLE' | 'P2_ENROUTE' | 'P3_ONTRIP',
  miles: number,
  estimated = false,
): DriverPeriodMileage {
  const bucket = bucketKey(period);
  if (!bucket || !(miles > 0) || !Number.isFinite(miles)) return m;
  return {
    ...m,
    [bucket]: m[bucket] + miles,
    estimatedMiles: estimated ? m.estimatedMiles + miles : m.estimatedMiles,
  };
}
