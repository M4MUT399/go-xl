// O RECIBO DA CORRIDA — composição pura dos valores e o HTML do e-mail.
//
// ── POR QUE ISTO EXISTE, E POR QUE NÃO É CÓPIA DO waybill.ts ───────────────
//
// `src/lib/waybill.ts` monta o recibo IMPRIMÍVEL que o passageiro baixa na tela
// de detalhes. Ele mora no app e importa `./systemConfig`, que puxa a cadeia do
// Supabase do lado do cliente — uma Edge Function não consegue carregá-lo.
//
// O que NÃO pode divergir entre os dois é a MATEMÁTICA. Se a tela disser que a
// tarifa-base foi US$ 38,53 e o e-mail disser US$ 41,53, o passageiro tem dois
// documentos do mesmo serviço com números diferentes — e é sempre o segundo que
// vira reclamação. Por isso `receiptFareLines` é a composição inteira, isolada,
// e existe um teste que a confere contra o `buildWaybill` do app para o MESMO
// insumo: se um dia alguém mexer em um dos lados, a suíte reprova.
//
// O HTML, esse sim, é próprio. E-mail não é página: cliente de e-mail ignora
// folha de estilo externa, engole `flex`, e o Gmail corta o que passa de ~102 KB.
// O layout aqui é tabela com estilo em linha, de propósito.

/** Uma linha do detalhamento da tarifa. */
export interface ReceiptLine {
  label: string;
  amount: number;
}

/** A corrida, na forma mínima que o recibo precisa. */
export interface ReceiptRide {
  id: string;
  price?: number | null;
  toll_amount?: number | null;
  airport_port_fee?: number | null;
  tip_amount?: number | null;
  distance_km?: number | null;
  duration_min?: number | null;
  origin_address?: string | null;
  destination_address?: string | null;
  completed_at?: string | null;
  created_at?: string | null;
}

export interface ReceiptParties {
  passengerName?: string | null;
  driverName?: string | null;
  vehicle?: string | null;
}

export interface ReceiptCompany {
  legalName: string;
  licenseNumber?: string | null;
  supportEmail?: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

/**
 * A composição da tarifa, na MESMA ordem e com as MESMAS contas do
 * `buildWaybill` do app:
 *
 *   base   = price − pedágio − taxa de aeroporto   (`price` já os inclui)
 *   total  = price + gorjeta                        (a gorjeta é cobrança à parte)
 *
 * Linhas de valor zero NÃO aparecem — um recibo com "Pedágio US$ 0,00" convida
 * a pergunta "que pedágio?", e a resposta é "nenhum".
 */
export function receiptFareLines(ride: ReceiptRide): { lines: ReceiptLine[]; total: number } {
  const toll = round2(num(ride.toll_amount));
  const venue = round2(num(ride.airport_port_fee));
  const tip = round2(num(ride.tip_amount));
  const price = round2(num(ride.price));
  const base = round2(price - toll - venue);

  const lines: ReceiptLine[] = [{ label: 'Base fare', amount: base }];
  if (toll > 0) lines.push({ label: 'Tolls', amount: toll });
  if (venue > 0) lines.push({ label: 'Airport/Port fee', amount: venue });
  if (tip > 0) lines.push({ label: 'Tip', amount: tip });

  return { lines, total: round2(price + tip) };
}

/** Assunto do e-mail. Curto, com o valor — é o que se lê na lista sem abrir. */
export function receiptSubject(ride: ReceiptRide, company: ReceiptCompany): string {
  const { total } = receiptFareLines(ride);
  return `${company.legalName} — receipt for your ride (${money(total)})`;
}

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

const money = (n: number) => `$${(Number(n) || 0).toFixed(2)}`;

function linha(k: string, v: string): string {
  if (!v) return '';
  return `<tr><td style="padding:6px 0;font-size:13px;color:#666;width:42%">${esc(k)}</td>` +
    `<td style="padding:6px 0;font-size:13px;color:#111;text-align:right;font-weight:600">${esc(v)}</td></tr>`;
}

/**
 * O corpo do e-mail. Estilo EM LINHA e layout em tabela de propósito: cliente
 * de e-mail descarta `<style>` externo e trata `flex`/`grid` de forma
 * imprevisível. Sem imagem remota — recibo que depende de imagem carregar é
 * recibo que chega quebrado com "exibir imagens?" por cima.
 */
export function receiptHtml(
  ride: ReceiptRide,
  parties: ReceiptParties,
  company: ReceiptCompany,
): string {
  const { lines, total } = receiptFareLines(ride);
  const quando = ride.completed_at ?? ride.created_at ?? null;
  const dataLegivel = quando ? new Date(quando).toUTCString().replace(' GMT', ' UTC') : '';

  const infos = [
    linha('Ride', ride.id.slice(0, 8).toUpperCase()),
    linha('Date', dataLegivel),
    linha('From', ride.origin_address ?? ''),
    linha('To', ride.destination_address ?? ''),
    ride.distance_km != null ? linha('Distance', `${(Number(ride.distance_km) * 0.621371).toFixed(1)} mi`) : '',
    ride.duration_min != null ? linha('Duration', `${ride.duration_min} min`) : '',
    parties.driverName ? linha('Driver', parties.driverName) : '',
    parties.vehicle ? linha('Vehicle', parties.vehicle) : '',
  ].join('');

  const tarifa = lines
    .map((l) => `<tr><td style="padding:6px 0;font-size:13px;color:#666">${esc(l.label)}</td>` +
      `<td style="padding:6px 0;font-size:13px;color:#111;text-align:right;font-weight:600">${money(l.amount)}</td></tr>`)
    .join('');

  const licenca = company.licenseNumber
    ? `${esc(company.legalName)} — License: ${esc(company.licenseNumber)}`
    : esc(company.legalName);

  const saudacao = parties.passengerName ? `Hi ${esc(parties.passengerName.trim().split(' ')[0])},` : 'Hi,';
  const suporte = company.supportEmail
    ? `<p style="font-size:12px;color:#666;margin:16px 0 0">Questions about this ride? Reply to this email or write to ${esc(company.supportEmail)}.</p>`
    : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" /></head>
<body style="margin:0;padding:24px;background:#f5f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px">
  <h1 style="font-size:18px;margin:0 0 4px">Receipt for your ride</h1>
  <p style="font-size:12px;color:#444;margin:0 0 18px">${licenca}</p>
  <p style="font-size:14px;margin:0 0 18px">${saudacao} thanks for riding with us. Here is the receipt for your trip.</p>
  <table style="width:100%;border-collapse:collapse;margin-bottom:18px">${infos}</table>
  <table style="width:100%;border-collapse:collapse">
    ${tarifa}
    <tr><td style="border-top:1px solid #ddd;padding-top:10px;font-size:15px;font-weight:700">Total</td>
        <td style="border-top:1px solid #ddd;padding-top:10px;font-size:15px;font-weight:700;text-align:right">${money(total)}</td></tr>
  </table>
  ${suporte}
</div>
</body></html>`;
}
