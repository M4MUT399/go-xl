// nav/rideCard — modelo PURO do card de corrida expansível (Bloco 4, paridade
// Uber). Decide, por FASE, qual endereço fica em destaque e quais linhas são
// reveladas ao expandir o card. Sem React nem i18n resolvido (só devolve chaves
// de tradução), para ser exercitado em teste unitário e manter a tela burra.

export type RideCardPhase = 'pickup' | 'dropoff';

export interface RideCardInput {
  phase: RideCardPhase;
  originAddress: string;
  destinationAddress: string;
  passengerName?: string | null;
  /** Já formatado (ex.: "$24.50"). Ausente/omitido → linha não aparece. */
  priceLabel?: string | null;
  /** Já formatado (ex.: "12.4 mi"). Ausente/omitido → linha não aparece. */
  distanceLabel?: string | null;
}

export interface RideCardRow {
  /** Chave i18n do rótulo da linha. */
  labelKey: string;
  value: string;
  /** true = endereço (a UI permite múltiplas linhas). */
  address?: boolean;
}

export interface RideCardModel {
  /** Chave i18n do rótulo do endereço em destaque na fase atual. */
  primaryLabelKey: string;
  /** Endereço em destaque: EMBARQUE na fase pickup, DESTINO na fase dropoff. */
  primaryAddress: string;
  /** Linhas reveladas ao expandir (nunca repetem o endereço em destaque). */
  expandedRows: RideCardRow[];
}

const PICKUP_KEY = 'tripDetails.pickup';
const DROPOFF_KEY = 'tripDetails.dropoff';

/**
 * Monta o modelo do card conforme a fase:
 *   - pickup  → destaque = embarque; ao expandir revela destino, passageiro e
 *               (preço · distância);
 *   - dropoff → destaque = destino;  ao expandir revela onde foi o embarque,
 *               passageiro e (preço · distância).
 * Linhas com valor ausente/vazio são omitidas.
 */
export function buildRideCardModel(input: RideCardInput): RideCardModel {
  const { phase, originAddress, destinationAddress, passengerName, priceLabel, distanceLabel } = input;
  const rows: RideCardRow[] = [];

  if (phase === 'pickup') {
    rows.push({ labelKey: DROPOFF_KEY, value: destinationAddress, address: true });
  } else {
    rows.push({ labelKey: PICKUP_KEY, value: originAddress, address: true });
  }

  const name = passengerName?.trim();
  if (name) rows.push({ labelKey: 'driverNav.passenger', value: name });

  const trip = [priceLabel, distanceLabel].filter((s) => s && s.trim()).join('  ·  ');
  if (trip) rows.push({ labelKey: 'driverNav.tripSummary', value: trip });

  return {
    primaryLabelKey: phase === 'pickup' ? PICKUP_KEY : DROPOFF_KEY,
    primaryAddress: phase === 'pickup' ? originAddress : destinationAddress,
    expandedRows: rows,
  };
}
