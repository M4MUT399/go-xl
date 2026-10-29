// Decisão PURA da varredura de corridas CONCLUÍDAS E NÃO COBRADAS — sem I/O,
// sem globais do Deno (mesmo padrão de `_shared/staleRideSweep.ts`, que é a
// varredura simétrica: aquela devolve dinheiro cobrado que não virou viagem,
// esta cobra viagem que aconteceu e não virou dinheiro).
//
// ─────────────────────────────────────────────────────────────────────────────
// O BURACO, MEDIDO E NÃO SUPOSTO
// ─────────────────────────────────────────────────────────────────────────────
//
// Levantamento das 128 corridas concluídas desde 01/07/2026, contra o banco e a
// conta Stripe de produção (05/09/2026):
//
//   • até 30/07 — ~120 corridas, quase todas IMEDIATAS: todas cobradas pelo app.
//   • de 17/08 em diante — 5 corridas, TODAS AGENDADAS: NENHUMA cobrada pelo app.
//
// Quatro das cinco foram salvas à mão (os PaymentIntents delas carregam
// `metadata.retroativo = "true"`, do `supabase/scripts/charge_unpaid_ride.ts`).
// A quinta ficou 1 dia parada sem que nada percebesse. Corrida imediata cobra;
// corrida agendada não cobra — 5 em 5.
//
// A CAUSA é que todo ponto de cobrança de uma agendada mora num celular:
//
//   • `acceptRide` cobra, mas agendada com motorista já confirmado nunca passa
//     por ele;
//   • `activate()` cobra, e desde a 457f7ee quem o chama é o motorista pelo
//     banner "Iniciar rota" — entrar na corrida por outro caminho não cobra;
//   • a rede de segurança da conclusão (fc17578, `updateRideStatus`) é
//     `void (async () => …)`: dispara e esquece, no telefone do motorista, no
//     instante em que ele fecha a tela da viagem. Falhou? Vira `reportError`,
//     que hoje só escreve no console do aparelho.
//
// E o fecho do buraco: NADA no servidor olhava uma corrida concluída com
// `paid = false`. O `sweep-stale-requesting` só enxerga `status = 'requesting'`
// — `classifyStaleRide` devolve `not_requesting` para uma concluída e passa
// direto. Ou seja: viagem entregue, motorista a receber, e o dinheiro nunca
// cobrado, sem aparecer em relatório nenhum.
//
// ─────────────────────────────────────────────────────────────────────────────
// A DIREÇÃO SEGURA DO ERRO É O CONTRÁRIO DA OUTRA VARREDURA
// ─────────────────────────────────────────────────────────────────────────────
//
// Lá, na dúvida, ESTORNA-SE menos (estornar a viagem de quem está embarcando é
// pior que deixar dinheiro parado mais um ciclo). Aqui, na dúvida, COBRA-SE
// menos — e pelo mesmo tipo de razão, só que mais forte: uma cobrança indevida
// sai do cartão de uma pessoa que não pediu nada naquele momento, e desfazê-la
// custa estorno, explicação e confiança. Não cobrar deixa uma linha num
// relatório.
//
// Daí os quatro "não" que não são redundância da consulta: a corrida pode mudar
// de estado entre a leitura e a cobrança, e a releitura antes de mover dinheiro
// passa por esta mesma função.

/** Corrida candidata, na forma mínima que a decisão precisa. */
export interface UnpaidRideCandidate {
  id: string;
  status?: string | null;
  paid?: boolean | null;
  /** Tarifa gravada, em dólares. */
  price?: number | null;
  driver_id?: string | null;
  /** ISO. Conclusão da viagem. */
  completed_at?: string | null;
  /** Já existe cobrança registrada? Então esta varredura NÃO cria outra. */
  stripe_payment_intent_id?: string | null;
}

export type UnpaidSweepVerdict =
  | { charge: true; amountCents: number; ageMs: number }
  | {
      charge: false;
      reason:
        | 'not_completed'
        | 'already_paid'
        | 'has_intent'
        | 'no_driver'
        | 'invalid_amount'
        | 'too_recent'
        | 'too_old';
      /** Precisa de olho humano (relatório), em vez de simplesmente ignorar. */
      needsAttention: boolean;
      ageMs: number;
    };

export interface UnpaidSweepOptions {
  nowMs: number;
  /**
   * Carência antes de a varredura assumir a corrida. Existe para NÃO correr
   * contra a rede de segurança do app: se o telefone do motorista ainda vai
   * cobrar, que cobre ele. As duas são idempotentes pela chave
   * `charge_<rideId>`, então o pior caso é desperdício de chamada — mas a
   * carência também evita cobrar uma corrida que o passageiro está prestes a
   * contestar com o motorista ainda no carro.
   */
  minAgeMs: number;
  /**
   * Teto de idade. Passado dele a varredura PARA de cobrar sozinha e passa a
   * pedir atenção humana.
   *
   * Isto não é preciosismo: no dia em que esta função entrar no ar existem
   * corridas antigas não cobradas no banco (as de julho, de teste, com
   * PaymentIntent de outra conta). Sem teto, o primeiro ciclo sairia cobrando
   * cartões semanas depois da viagem — uma cobrança que ninguém reconhece é
   * indistinguível de fraude para quem a recebe, e vira disputa.
   */
  maxAgeMs: number;
  /** Mínimo aceito pelo Stripe (50 centavos em USD). */
  minAmountCents?: number;
}

const MIN_AMOUNT_CENTS_PADRAO = 50;

function parseMs(iso?: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Esta corrida deve ser cobrada agora pela varredura?
 *
 * Sem `completed_at` legível não há como medir idade, e sem idade não há como
 * respeitar carência nem teto. O veredito nesse caso é `too_recent` com pedido
 * de atenção — nunca `charge`: preferir não cobrar é o erro reversível.
 */
export function classifyUnpaidRide(
  ride: UnpaidRideCandidate,
  opts: UnpaidSweepOptions,
): UnpaidSweepVerdict {
  const concluida = parseMs(ride.completed_at);
  const ageMs = concluida === null ? 0 : opts.nowMs - concluida;

  // Só viagem que ACONTECEU gera cobrança. Cancelada não, em andamento não.
  if (ride.status !== 'completed') {
    return { charge: false, reason: 'not_completed', needsAttention: false, ageMs };
  }

  if (ride.paid === true) {
    return { charge: false, reason: 'already_paid', needsAttention: false, ageMs };
  }

  // `paid = false` COM PaymentIntent gravado é ambíguo, e a ambiguidade é cara:
  // pode ser cobrança estornada (não recobrar — o estorno foi uma decisão), pode
  // ser webhook que não gravou a flag (já está pago), pode ser intent de outra
  // conta Stripe. Nenhuma dessas se resolve criando uma SEGUNDA cobrança. Vai
  // para o relatório com pedido de atenção.
  if (ride.stripe_payment_intent_id) {
    return { charge: false, reason: 'has_intent', needsAttention: true, ageMs };
  }

  // Sem motorista, uma corrida "concluída" é um estado que não deveria existir —
  // e cobrar por uma viagem sem ninguém para receber o repasse seria só reter
  // dinheiro. Relatório, não cobrança.
  if (!ride.driver_id) {
    return { charge: false, reason: 'no_driver', needsAttention: true, ageMs };
  }

  const amountCents = Math.round((ride.price ?? 0) * 100);
  const minimo = opts.minAmountCents ?? MIN_AMOUNT_CENTS_PADRAO;
  if (!Number.isFinite(amountCents) || amountCents < minimo) {
    return { charge: false, reason: 'invalid_amount', needsAttention: true, ageMs };
  }

  if (concluida === null) {
    return { charge: false, reason: 'too_recent', needsAttention: true, ageMs };
  }

  if (ageMs < opts.minAgeMs) {
    return { charge: false, reason: 'too_recent', needsAttention: false, ageMs };
  }

  if (ageMs > opts.maxAgeMs) {
    return { charge: false, reason: 'too_old', needsAttention: true, ageMs };
  }

  return { charge: true, amountCents, ageMs };
}
