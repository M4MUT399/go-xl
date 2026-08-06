// waybill — carta de porte / recibo legal por viagem (P4).
//
// Regras do projeto:
//   • Nada de dado legal "chumbado": nome/registro da empresa e a nota de rodapé
//     legal são CONFIGURÁVEIS por jurisdição (system_config). Sem configurar →
//     campos vazios; a geração não inventa dados legais.
//   • Núcleo PURO e testável: buildWaybill monta a estrutura a partir de uma
//     corrida + config; waybillToHtml gera o HTML imprimível. A exportação em
//     PDF/compartilhamento (expo-print) é uma camada fina por cima disto.
//   • O detalhamento de tarifa reaproveita os campos já persistidos na corrida
//     (price já inclui pedágio P5 + taxa de aeroporto/porto P6; a gorjeta entra
//     por cima). Assim o recibo bate com o que foi efetivamente cobrado.
import { getConfigValue } from './systemConfig';

export type WaybillCompany = {
  legalName: string;
  licenseNumber: string;
  footerNote: string;
};

export type WaybillFareLine = { label: string; amount: number };

export type WaybillLabels = {
  title: string;
  ride: string;
  issued: string;
  from: string;
  to: string;
  distance: string;
  duration: string;
  driver: string;
  vehicle: string;
  passenger: string;
  baseFare: string;
  tolls: string;
  venueFee: string;
  tip: string;
  total: string;
  license: string;
};

const DEFAULT_LABELS: WaybillLabels = {
  title: 'Trip receipt / Waybill',
  ride: 'Ride',
  issued: 'Issued',
  from: 'From',
  to: 'To',
  distance: 'Distance',
  duration: 'Duration',
  driver: 'Driver',
  vehicle: 'Vehicle',
  passenger: 'Passenger',
  baseFare: 'Base fare',
  tolls: 'Tolls',
  venueFee: 'Airport/Port fee',
  tip: 'Tip',
  total: 'Total',
  license: 'License',
};

export type WaybillRideInput = {
  id: string;
  price?: number;
  toll_amount?: number;
  airport_port_fee?: number;
  tip_amount?: number;
  distance_km?: number;
  duration_min?: number;
  origin_address?: string;
  destination_address?: string;
  created_at?: string;
  completed_at?: string;
  driverName?: string;
  vehicleLabel?: string;
  passengerName?: string;
};

export type WaybillData = {
  company: WaybillCompany;
  labels: WaybillLabels;
  rideId: string;
  issuedAt: string;
  dateLabel: string;
  origin: string;
  destination: string;
  distanceKm: number | null;
  durationMin: number | null;
  driverName: string | null;
  vehicle: string | null;
  passengerName: string | null;
  fareLines: WaybillFareLine[];
  total: number;
  currency: 'USD';
};

const num = (n: number | undefined | null): number =>
  Number.isFinite(n as number) ? (n as number) : 0;
const round2 = (n: number): number => Math.round(n * 100) / 100;
const money = (n: number): string => `$${round2(n).toFixed(2)}`;

/**
 * buildWaybill — núcleo puro: monta a estrutura do recibo a partir da corrida e
 * das infos da empresa. O detalhamento separa tarifa-base, pedágio, taxa de
 * aeroporto/porto e gorjeta.
 */
export function buildWaybill(
  ride: WaybillRideInput,
  company: WaybillCompany,
  labels: Partial<WaybillLabels> = {},
  now: Date = new Date()
): WaybillData {
  const L = { ...DEFAULT_LABELS, ...labels };

  const toll = round2(num(ride.toll_amount));
  const venue = round2(num(ride.airport_port_fee));
  const tip = round2(num(ride.tip_amount));
  const price = round2(num(ride.price)); // já inclui tarifa + pedágio + taxa
  const base = round2(price - toll - venue);
  const total = round2(price + tip);

  const fareLines: WaybillFareLine[] = [{ label: L.baseFare, amount: base }];
  if (toll > 0) fareLines.push({ label: L.tolls, amount: toll });
  if (venue > 0) fareLines.push({ label: L.venueFee, amount: venue });
  if (tip > 0) fareLines.push({ label: L.tip, amount: tip });

  const rideDate = ride.completed_at ?? ride.created_at ?? null;
  const dateLabel = rideDate ? new Date(rideDate).toLocaleString('en-US') : '';

  return {
    company,
    labels: L,
    rideId: ride.id,
    issuedAt: now.toISOString(),
    dateLabel,
    origin: ride.origin_address ?? '',
    destination: ride.destination_address ?? '',
    distanceKm: ride.distance_km ?? null,
    durationMin: ride.duration_min ?? null,
    driverName: ride.driverName ?? null,
    vehicle: ride.vehicleLabel ?? null,
    passengerName: ride.passengerName ?? null,
    fareLines,
    total,
    currency: 'USD',
  };
}

/** Escapa texto para interpolação segura no HTML. */
function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function row(label: string, value: string): string {
  if (!value) return '';
  return `<tr><td class="k">${esc(label)}</td><td class="v">${esc(value)}</td></tr>`;
}

/**
 * waybillToHtml — gera o HTML imprimível (para expo-print ou visualização).
 * Função pura: recebe a estrutura e devolve string.
 */
export function waybillToHtml(data: WaybillData): string {
  const L = data.labels;
  const c = data.company;

  const infoRows = [
    row(L.ride, data.rideId),
    row(L.issued, new Date(data.issuedAt).toLocaleString('en-US')),
    data.dateLabel ? row('Date', data.dateLabel) : '',
    row(L.from, data.origin),
    row(L.to, data.destination),
    data.distanceKm != null ? row(L.distance, `${data.distanceKm.toFixed(1)} km`) : '',
    data.durationMin != null ? row(L.duration, `${data.durationMin} min`) : '',
    data.driverName ? row(L.driver, data.driverName) : '',
    data.vehicle ? row(L.vehicle, data.vehicle) : '',
    data.passengerName ? row(L.passenger, data.passengerName) : '',
  ].join('');

  const fareRows = data.fareLines
    .map((l) => `<tr><td class="k">${esc(l.label)}</td><td class="v">${money(l.amount)}</td></tr>`)
    .join('');

  const companyLine = c.licenseNumber
    ? `${esc(c.legalName)} — ${esc(L.license)}: ${esc(c.licenseNumber)}`
    : esc(c.legalName);

  return `<!DOCTYPE html><html><head><meta charset="utf-8" />
<style>
  body { font-family: -apple-system, Roboto, Helvetica, Arial, sans-serif; color: #111; padding: 24px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .company { font-size: 12px; color: #444; margin-bottom: 16px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  td { padding: 6px 0; font-size: 13px; vertical-align: top; }
  td.k { color: #666; width: 40%; }
  td.v { color: #111; text-align: right; font-weight: 600; }
  .total td { border-top: 1px solid #ccc; font-size: 15px; padding-top: 10px; }
  .footer { font-size: 11px; color: #777; margin-top: 24px; border-top: 1px solid #eee; padding-top: 10px; }
</style></head><body>
  <h1>${esc(L.title)}</h1>
  <div class="company">${companyLine}</div>
  <table>${infoRows}</table>
  <table>
    ${fareRows}
    <tr class="total"><td class="k">${esc(L.total)}</td><td class="v">${money(data.total)}</td></tr>
  </table>
  ${c.footerNote ? `<div class="footer">${esc(c.footerNote)}</div>` : ''}
</body></html>`;
}

/**
 * getWaybillConfig — lê a configuração (feature flag + dados legais da empresa)
 * resolvendo por jurisdição. Sempre devolve valores seguros (vazios) quando não
 * configurado; nunca inventa dados legais.
 */
export async function getWaybillConfig(
  jurisdiction: string = 'global'
): Promise<{ enabled: boolean; company: WaybillCompany }> {
  try {
    const [enabled, legalName, licenseNumber, footerNote] = await Promise.all([
      getConfigValue<boolean>('waybill_enabled', false, jurisdiction),
      getConfigValue<string>('company_legal_name', '', jurisdiction),
      getConfigValue<string>('company_license_number', '', jurisdiction),
      getConfigValue<string>('waybill_footer_note', '', jurisdiction),
    ]);
    return {
      enabled: Boolean(enabled),
      company: {
        legalName: String(legalName ?? ''),
        licenseNumber: String(licenseNumber ?? ''),
        footerNote: String(footerNote ?? ''),
      },
    };
  } catch {
    return { enabled: false, company: { legalName: '', licenseNumber: '', footerNote: '' } };
  }
}
