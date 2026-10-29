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
  /** Taxa de espera no embarque (0091) — cobrança à parte, mas parte da viagem. */
  wait_fee_amount?: number | null;
  distance_km?: number | null;
  duration_min?: number | null;
  origin_address?: string | null;
  destination_address?: string | null;
  completed_at?: string | null;
  /** Embarque. Junto com `completed_at` é o que diz QUANDO a corrida aconteceu. */
  boarded_at?: string | null;
  /**
   * Criação do PEDIDO. Numa agendada é o dia da reserva, não o da viagem — por
   * isso o recibo NUNCA usa este campo como data. Fica na interface só porque
   * o `buildWaybill` do app o aceita e os testes passam o mesmo insumo aos dois.
   */
  created_at?: string | null;
}

/** A cobrança da gorjeta — lida da Stripe, que é a fonte do valor e da hora. */
export interface ReceiptTip {
  rideId: string;
  amount: number;
  /** Quando a gorjeta foi cobrada (ISO). */
  chargedAt: string;
  /** "Visa •••• 4242", quando a Stripe informar. */
  card?: string | null;
  /** Fim da corrida a que a gorjeta se refere (ISO). */
  rideCompletedAt?: string | null;
}

export interface ReceiptParties {
  passengerName?: string | null;
  /** E-mail do passageiro, impresso no bloco "Cobrado de" junto do nome completo. */
  passengerEmail?: string | null;
  driverName?: string | null;
  vehicle?: string | null;
}

export interface ReceiptCompany {
  legalName: string;
  licenseNumber?: string | null;
  supportEmail?: string | null;
  /**
   * `src` da logo no topo. No e-mail é `cid:goxl-logo` (anexo inline — ver
   * `receiptLogo.ts`); num PDF gerado localmente pode ser um `data:` URI.
   * Nunca uma URL remota: recibo que depende de imagem carregar chega quebrado.
   * Sem ela, o cabeçalho cai para o nome da empresa em texto.
   */
  logoSrc?: string | null;
}

/** Fuso em que as viagens acontecem — a data do recibo sai nele. */
export const RECEIPT_TIME_ZONE = 'America/New_York';

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
  const wait = round2(num(ride.wait_fee_amount));
  const price = round2(num(ride.price));
  const base = round2(price - toll - venue);

  const lines: ReceiptLine[] = [{ label: 'Base fare', amount: base }];
  if (toll > 0) lines.push({ label: 'Tolls', amount: toll });
  if (venue > 0) lines.push({ label: 'Airport/Port fee', amount: venue });
  if (wait > 0) lines.push({ label: 'Wait time', amount: wait });
  if (tip > 0) lines.push({ label: 'Tip', amount: tip });

  return { lines, total: round2(price + wait + tip) };
}

// ── IDIOMA ─────────────────────────────────────────────────────────────────
//
// O recibo sai no idioma que o passageiro escolheu para operar o app —
// `profiles.language`, gravado no cadastro (RegisterScreen) e trocado no
// Perfil. Os mesmos três do app (`src/i18n/translations.ts`). Qualquer outro
// valor, ou nulo, cai para inglês, que é o padrão do app.
//
// A MATEMÁTICA não muda com o idioma: `receiptFareLines` segue devolvendo os
// rótulos em inglês (é o que o teste compara com o `buildWaybill`), e a
// tradução acontece só na hora de desenhar.

export type ReceiptLang = 'en' | 'es' | 'pt';

const TEXTOS = {
  en: {
    pickup: 'Pickup', dropoff: 'Drop-off', card: 'Card',
    tipSubject: 'tip receipt', tipTitle: 'Tip receipt',
    tipThanks: 'thank you for the tip! It goes to your driver. Here is the receipt for this charge.',
    tipChargedOn: 'Charged on', rideDate: 'Ride date', tipTotal: 'Tip',
    locale: 'en-US', subject: 'receipt for your ride', title: 'Receipt for your ride',
    hi: 'Hi', hiAnon: 'Hi,', thanks: 'thanks for riding with us. Here is the receipt for your trip.',
    ride: 'Ride', date: 'Date', from: 'From', to: 'To', distance: 'Distance', duration: 'Duration',
    driver: 'Driver', vehicle: 'Vehicle', total: 'Total', license: 'License',
    support: 'Questions about this ride? Reply to this email or write to',
    'Base fare': 'Base fare', Tolls: 'Tolls', 'Airport/Port fee': 'Airport/Port fee', Tip: 'Tip',
    'Wait time': 'Wait time', billedTo: 'Billed to', name: 'Name', email: 'Email',
    thanksWithTip: 'thanks for riding with us — and for the tip, which goes to your driver. Here is the receipt for your trip.',
  },
  es: {
    pickup: 'Recogida', dropoff: 'Llegada', card: 'Tarjeta',
    tipSubject: 'recibo de propina', tipTitle: 'Recibo de propina',
    tipThanks: '¡gracias por la propina! Va para tu conductor. Aquí está el recibo de este cobro.',
    tipChargedOn: 'Cobrada el', rideDate: 'Fecha del viaje', tipTotal: 'Propina',
    locale: 'es-US', subject: 'recibo de tu viaje', title: 'Recibo de tu viaje',
    hi: 'Hola', hiAnon: 'Hola,', thanks: 'gracias por viajar con nosotros. Aquí está el recibo de tu viaje.',
    ride: 'Viaje', date: 'Fecha', from: 'Origen', to: 'Destino', distance: 'Distancia', duration: 'Duración',
    driver: 'Conductor', vehicle: 'Vehículo', total: 'Total', license: 'Licencia',
    support: '¿Preguntas sobre este viaje? Responde a este correo o escribe a',
    'Base fare': 'Tarifa base', Tolls: 'Peajes', 'Airport/Port fee': 'Tasa de aeropuerto/puerto', Tip: 'Propina',
    'Wait time': 'Tiempo de espera', billedTo: 'Facturado a', name: 'Nombre', email: 'Correo',
    thanksWithTip: 'gracias por viajar con nosotros — y por la propina, que va para tu conductor. Aquí está el recibo de tu viaje.',
  },
  pt: {
    pickup: 'Embarque', dropoff: 'Chegada', card: 'Cartão',
    tipSubject: 'recibo da gorjeta', tipTitle: 'Recibo da gorjeta',
    tipThanks: 'obrigado pela gorjeta! Ela vai para o seu motorista. Aqui está o recibo desta cobrança.',
    tipChargedOn: 'Cobrada em', rideDate: 'Data da corrida', tipTotal: 'Gorjeta',
    locale: 'pt-BR', subject: 'recibo da sua corrida', title: 'Recibo da sua corrida',
    hi: 'Olá', hiAnon: 'Olá,', thanks: 'obrigado por viajar com a gente. Aqui está o recibo da sua corrida.',
    ride: 'Corrida', date: 'Data', from: 'Origem', to: 'Destino', distance: 'Distância', duration: 'Duração',
    driver: 'Motorista', vehicle: 'Veículo', total: 'Total', license: 'Licença',
    support: 'Dúvidas sobre esta corrida? Responda este e-mail ou escreva para',
    'Base fare': 'Tarifa base', Tolls: 'Pedágios', 'Airport/Port fee': 'Taxa de aeroporto/porto', Tip: 'Gorjeta',
    'Wait time': 'Tempo de espera', billedTo: 'Cobrado de', name: 'Nome', email: 'E-mail',
    thanksWithTip: 'obrigado por viajar com a gente — e pela gorjeta, que vai para o seu motorista. Aqui está o recibo da sua corrida.',
  },
} as const;

/** Normaliza o que vem do banco (`'pt'`, `'PT'`, `'pt-BR'`, nulo…) para um dos três. */
export function receiptLang(v: unknown): ReceiptLang {
  const c = String(v ?? '').trim().toLowerCase().slice(0, 2);
  return c === 'pt' || c === 'es' ? c : 'en';
}

/** Assunto do e-mail. Curto, com o valor — é o que se lê na lista sem abrir. */
export function receiptSubject(ride: ReceiptRide, company: ReceiptCompany, lang: ReceiptLang = 'en'): string {
  const { total } = receiptFareLines(ride);
  return `${company.legalName} — ${TEXTOS[lang].subject} (${money(total)})`;
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

function dataHora(iso: string | null | undefined, T: Textos): string {
  if (!iso) return '';
  // Hora de Orlando, que é onde a viagem aconteceu. Em UTC o passageiro via
  // "19:33" numa corrida que ele lembra como 15:33 — e confere contra a fatura.
  return new Date(iso).toLocaleString(T.locale, {
    timeZone: RECEIPT_TIME_ZONE, weekday: 'short', month: 'short', day: 'numeric',
    year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
}

type Textos = (typeof TEXTOS)[ReceiptLang];

/**
 * A moldura comum aos dois recibos: faixa escura com a logo, título, empresa,
 * saudação e o rodapé de suporte. Estilo EM LINHA e layout em tabela de
 * propósito: cliente de e-mail descarta `<style>` externo e trata `flex`/`grid`
 * de forma imprevisível. Sem imagem remota — recibo que depende de imagem
 * carregar é recibo que chega quebrado com "exibir imagens?" por cima.
 */
function moldura(
  T: Textos, lang: ReceiptLang, company: ReceiptCompany, parties: ReceiptParties,
  titulo: string, frase: string, miolo: string,
): string {
  const licenca = company.licenseNumber
    ? `${esc(company.legalName)} — ${T.license}: ${esc(company.licenseNumber)}`
    : esc(company.legalName);

  // Logo dourada sobre a faixa escura — o mesmo par de cores do app. Largura
  // fixa em atributo E em estilo: o Outlook ignora o CSS e usa o atributo.
  const cabecalho = company.logoSrc
    ? `<img src="${esc(company.logoSrc)}" alt="${esc(company.legalName)}" width="146" height="40" ` +
      `style="display:block;width:146px;height:40px;border:0" />`
    : `<span style="font-size:22px;font-weight:700;letter-spacing:2px;color:#c9a54c">${esc(company.legalName)}</span>`;

  const saudacao = parties.passengerName ? `${T.hi} ${esc(parties.passengerName.trim().split(' ')[0])},` : T.hiAnon;
  const suporte = company.supportEmail
    ? `<p style="font-size:12px;color:#666;margin:16px 0 0">${T.support} ${esc(company.supportEmail)}.</p>`
    : '';

  return `<!DOCTYPE html><html lang="${lang}"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" /></head>
<body style="margin:0;padding:24px;background:#f5f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden">
  <table style="width:100%;border-collapse:collapse;background:#0e0e1a"><tr>
    <td style="padding:22px 28px">${cabecalho}</td>
    <td style="padding:22px 28px;text-align:right;font-size:11px;letter-spacing:1.5px;color:#c9a54c;text-transform:uppercase">Executive XL</td>
  </tr></table>
<div style="padding:28px">
  <h1 style="font-size:18px;margin:0 0 4px">${titulo}</h1>
  <p style="font-size:12px;color:#444;margin:0 0 18px">${licenca}</p>
  <p style="font-size:14px;margin:0 0 18px">${saudacao} ${frase}</p>
  ${cobradoDe(T, parties)}
  ${miolo}
  ${suporte}
</div>
</div>
</body></html>`;
}

/**
 * Bloco "Cobrado de": nome completo e e-mail do passageiro (pedido do Edson,
 * 29/10/2026). Recibo sem o nome de quem pagou não serve de comprovante para
 * reembolso de despesa — que é para o que o passageiro executivo o usa.
 */
function cobradoDe(T: Textos, parties: ReceiptParties): string {
  const nome = parties.passengerName?.trim();
  const email = parties.passengerEmail?.trim();
  if (!nome && !email) return '';
  return `<table style="width:100%;border-collapse:collapse;margin:0 0 18px;background:#f7f7f9;border-radius:8px">
    <tr><td colspan="2" style="padding:10px 12px 2px;font-size:11px;letter-spacing:1px;color:#888;text-transform:uppercase">${esc(T.billedTo)}</td></tr>
    ${nome ? `<tr><td style="padding:2px 12px;font-size:13px;color:#666;width:30%">${esc(T.name)}</td><td style="padding:2px 12px;font-size:13px;color:#111;font-weight:600;text-align:right">${esc(nome)}</td></tr>` : ''}
    ${email ? `<tr><td style="padding:2px 12px 10px;font-size:13px;color:#666">${esc(T.email)}</td><td style="padding:2px 12px 10px;font-size:13px;color:#111;font-weight:600;text-align:right">${esc(email)}</td></tr>` : ''}
  </table>`;
}

const linhaTotal = (rotulo: string, valor: number) =>
  `<tr><td style="border-top:1px solid #ddd;padding-top:10px;font-size:15px;font-weight:700">${rotulo}</td>` +
  `<td style="border-top:1px solid #ddd;padding-top:10px;font-size:15px;font-weight:700;text-align:right">${money(valor)}</td></tr>`;

/**
 * O recibo DA CORRIDA.
 *
 * A data é a da VIAGEM: embarque (`boarded_at`) e chegada (`completed_at`).
 * Nunca `created_at` — numa corrida agendada esse é o dia em que o passageiro
 * reservou, que pode ser uma semana antes, e o recibo ficaria com a data da
 * reserva no lugar da data da corrida.
 */
export function receiptHtml(
  ride: ReceiptRide,
  parties: ReceiptParties,
  company: ReceiptCompany,
  lang: ReceiptLang = 'en',
): string {
  const T = TEXTOS[lang];
  const { lines, total } = receiptFareLines(ride);

  const infos = [
    linha(T.ride, ride.id.slice(0, 8).toUpperCase()),
    linha(T.pickup, dataHora(ride.boarded_at, T)),
    linha(T.dropoff, dataHora(ride.completed_at, T)),
    linha(T.from, ride.origin_address ?? ''),
    linha(T.to, ride.destination_address ?? ''),
    ride.distance_km != null ? linha(T.distance, `${(Number(ride.distance_km) * 0.621371).toFixed(1)} mi`) : '',
    ride.duration_min != null ? linha(T.duration, `${ride.duration_min} min`) : '',
    parties.driverName ? linha(T.driver, parties.driverName) : '',
    parties.vehicle ? linha(T.vehicle, parties.vehicle) : '',
  ].join('');

  const tarifa = lines
    .map((l) => `<tr><td style="padding:6px 0;font-size:13px;color:#666">${esc((T as Record<string, string>)[l.label] ?? l.label)}</td>` +
      `<td style="padding:6px 0;font-size:13px;color:#111;text-align:right;font-weight:600">${money(l.amount)}</td></tr>`)
    .join('');

  const miolo = `<table style="width:100%;border-collapse:collapse;margin-bottom:18px">${infos}</table>
  <table style="width:100%;border-collapse:collapse">
    ${tarifa}
    ${linhaTotal(T.total, total)}
  </table>`;

  return moldura(T, lang, company, parties, T.title, num(ride.tip_amount) > 0 ? T.thanksWithTip : T.thanks, miolo);
}

/**
 * O recibo DA GORJETA. A gorjeta é uma cobrança à parte no cartão — outro
 * PaymentIntent, outro dia às vezes (Steve Horn deu a da corrida de 08/10 no
 * dia 09) — então tem recibo próprio, com o valor e a hora DAQUELA cobrança.
 * Assim cada e-mail bate com uma linha da fatura do passageiro.
 */
export function tipReceiptHtml(
  tip: ReceiptTip,
  parties: ReceiptParties,
  company: ReceiptCompany,
  lang: ReceiptLang = 'en',
): string {
  const T = TEXTOS[lang];
  const infos = [
    linha(T.ride, tip.rideId.slice(0, 8).toUpperCase()),
    linha(T.rideDate, dataHora(tip.rideCompletedAt, T)),
    linha(T.tipChargedOn, dataHora(tip.chargedAt, T)),
    parties.driverName ? linha(T.driver, parties.driverName) : '',
    tip.card ? linha(T.card, tip.card) : '',
  ].join('');

  const miolo = `<table style="width:100%;border-collapse:collapse;margin-bottom:18px">${infos}</table>
  <table style="width:100%;border-collapse:collapse">
    ${linhaTotal(T.tipTotal, round2(tip.amount))}
  </table>`;

  return moldura(T, lang, company, parties, T.tipTitle, T.tipThanks, miolo);
}

export function tipReceiptSubject(tip: ReceiptTip, company: ReceiptCompany, lang: ReceiptLang = 'en'): string {
  return `${company.legalName} — ${TEXTOS[lang].tipSubject} (${money(round2(tip.amount))})`;
}
