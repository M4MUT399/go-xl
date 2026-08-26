// Decisão PURA da varredura de corridas COBRADAS E ABANDONADAS — sem I/O, sem
// globais do Deno (mesmo padrão de _shared/payout.ts, _shared/chargeCycle.ts e
// _shared/refundFlow.ts: roda igual na Edge Function e no Jest do app).
//
// ─────────────────────────────────────────────────────────────────────────────
// O BURACO QUE ISTO FECHA
// ─────────────────────────────────────────────────────────────────────────────
// `acceptRide` cobra o cartão do passageiro ANTES de travar a corrida
// (useRide.ts:1624) — de propósito: se o cartão recusa, a corrida não é tomada.
// Se o UPDATE seguinte falhar (:1668-1690), o cliente chama `reofferRide` e
// devolve a corrida ao leque SEM ESTORNAR. O único estorno desse caso é uma rede
// de segurança do lado do CLIENTE (useRide.ts:759-770): se o app do passageiro
// fechar, mudar de tela ou perder a rede, ninguém estorna nunca.
//
// O desfecho é uma corrida parada em `status = 'requesting'` com `paid = true`:
// o passageiro está cobrado, nenhum motorista foi designado, a viagem não vai
// acontecer e NADA no servidor varre esse estado. O dinheiro fica com a
// plataforma por omissão. Nem o repasse resgata isso — a elegibilidade exige
// `driver_id is not null` e `driver_amount is not null`
// (run-weekly-payouts/index.ts:268-273), e uma corrida `requesting` não tem
// nenhum dos dois.
//
// Este módulo decide QUAIS corridas entram na varredura. O estorno em si reusa a
// mesma sequência testada do refund-ride (_shared/refundFlow.ts).

/** Corrida candidata, na forma mínima que a decisão precisa. */
export interface StaleRideCandidate {
  id: string;
  status?: string | null;
  paid?: boolean | null;
  stripe_payment_intent_id?: string | null;
  /** ISO. Criação da corrida. */
  created_at?: string | null;
  /** ISO. Corrida agendada só vira `requesting` perto desta hora. */
  scheduled_for?: string | null;
}

export type SweepVerdict =
  | { sweep: true; ageMs: number }
  | {
      sweep: false;
      reason: 'not_requesting' | 'not_paid' | 'no_payment_intent' | 'too_recent';
      ageMs: number;
    };

export interface SweepOptions {
  nowMs: number;
  /** Idade mínima para considerar a corrida abandonada. */
  minAgeMs: number;
  /**
   * `PaymentIntent.created * 1000` — quando a Edge Function conseguiu reler o
   * intent no Stripe. É a resposta AUTORITATIVA para "há quanto tempo este
   * passageiro foi cobrado?", que é a pergunta que realmente importa aqui.
   * `null`/ausente quando a releitura não foi feita ou falhou.
   */
  chargeCreatedMs?: number | null;
}

function parseMs(iso?: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Âncora temporal da corrida: o instante MAIS RECENTE entre os que conhecemos.
 *
 * O `max` não é preciosismo, é a única direção segura do erro. Uma corrida
 * AGENDADA nasce dias antes de ser ativada: ela fica `scheduled`, e só no
 * horário marcado é cobrada e passa a `requesting` (useRide.ts:844-866,
 * `activate`). Ancorar em `created_at` sozinho varreria — e ESTORNARIA — uma
 * corrida agendada no segundo seguinte à ativação, com o motorista a caminho.
 * Pegar o mais recente entre `created_at`, `scheduled_for` e a criação do
 * PaymentIntent faz a varredura errar sempre para o lado de NÃO estornar.
 *
 * Sem nenhuma âncora legível, devolve `null` e o chamador NÃO varre.
 */
export function sweepAnchorMs(
  ride: StaleRideCandidate,
  chargeCreatedMs?: number | null,
): number | null {
  const candidates = [
    parseMs(ride.created_at),
    parseMs(ride.scheduled_for),
    typeof chargeCreatedMs === 'number' && Number.isFinite(chargeCreatedMs) ? chargeCreatedMs : null,
  ].filter((n): n is number => n !== null);
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

/**
 * Esta corrida está cobrada e abandonada há tempo suficiente para ser estornada?
 *
 * Os quatro "não" são deliberadamente redundantes com o filtro da consulta: a
 * consulta é uma otimização (não trazer o banco inteiro), a decisão é aqui. Uma
 * corrida pode mudar de estado entre a consulta e o estorno — o aceite de um
 * motorista, por exemplo — e a releitura antes de mover dinheiro passa por esta
 * mesma função.
 *
 * Sem âncora temporal legível o veredito é `too_recent`, não `sweep`: preferir
 * não estornar é o erro reversível; estornar a viagem de alguém que está
 * embarcando não é.
 */
export function classifyStaleRide(
  ride: StaleRideCandidate,
  opts: SweepOptions,
): SweepVerdict {
  const anchor = sweepAnchorMs(ride, opts.chargeCreatedMs);
  const ageMs = anchor === null ? 0 : opts.nowMs - anchor;

  if (ride.status !== 'requesting') return { sweep: false, reason: 'not_requesting', ageMs };
  if (ride.paid !== true) return { sweep: false, reason: 'not_paid', ageMs };
  // Sem PaymentIntent não há o que estornar — e `paid = true` sem intent é um
  // estado que a restrição `rides_paid_requires_payment_intent` (0065) proíbe.
  if (!ride.stripe_payment_intent_id) return { sweep: false, reason: 'no_payment_intent', ageMs };
  if (anchor === null) return { sweep: false, reason: 'too_recent', ageMs };
  if (ageMs < opts.minAgeMs) return { sweep: false, reason: 'too_recent', ageMs };

  return { sweep: true, ageMs };
}
