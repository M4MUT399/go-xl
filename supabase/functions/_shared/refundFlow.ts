// SEQUÊNCIA de dinheiro do estorno — reverter → estornar → paid = false →
// registrar — atrás de PORTAS injetáveis, sem `npm:stripe`, sem
// `jsr:@supabase/supabase-js` e sem globais do Deno (mesmo padrão de
// _shared/payout.ts, _shared/chargeCycle.ts e _shared/refundReversal.ts: roda
// igual na Edge Function e no Jest do app).
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE ISTO SAIU DE DENTRO DA EDGE FUNCTION
// ─────────────────────────────────────────────────────────────────────────────
// A aritmética do estorno já era pura e testada (refundReversal.ts). O que NÃO
// era testado — e é onde os defeitos de dinheiro moram — é a SEQUÊNCIA: em que
// ordem as chamadas acontecem, e o que é escrito quando uma delas sai pela
// metade. `refund-ride/index.ts` importava `npm:stripe@17` e
// `jsr:@supabase/supabase-js@2` no topo, então nenhum teste do Jest conseguia
// carregar o arquivo para exercitar essa sequência.
//
// O buraco concreto que isto fecha (o refund que RESOLVE com status ruim):
// a versão anterior tratava com todo o cuidado o caso de `refunds.create`
// LANÇAR — gravava `refund_failed_after_reversal` e alertava — e deixava
// completamente descoberto o caso de ele RESOLVER com `status` ruim
// ('failed', 'canceled', 'requires_action' são status reais de refund do
// Stripe). Nesse caminho a função devolvia 400 seco DEPOIS de já ter revertido
// o transfer: o motorista tinha sido debitado dos 80-85%, o passageiro não
// tinha recebido nada de volta, a corrida continuava `paid = true` (portanto
// elegível a repasse de novo) e não sobrava uma linha escrita em lugar nenhum.
//
// Os dois casos são o MESMO acidente — "a reversão saiu e o estorno não" — e
// agora passam pelo mesmo `reversalOrphaned()`.

import { summarizeRefund, type ReversalPlan, type TipDisposition } from './refundReversal.ts';

/** Refund do Stripe, só o que decide o desfecho. */
export interface RefundShape {
  id: string;
  /** 'succeeded' | 'pending' | 'failed' | 'canceled' | 'requires_action' | null */
  status?: string | null;
  amount?: number | null;
}

/** Linha de `stripe_reconciliation` que este fluxo sabe escrever. */
export interface RefundAuditRow {
  eventId: string;
  rideId: string;
  driverId: string | null;
  payoutId: string | null;
  amountCents: number;
  needsAttention: boolean;
  code: string;
  reason: string;
  raw: Record<string, unknown>;
}

/** Erro de escrita do PostgREST, na forma mínima. */
export interface DbWriteError {
  message: string;
  code?: string | null;
}

/**
 * Tudo que o fluxo precisa do mundo externo. A Edge Function liga cada porta ao
 * Stripe/Supabase de verdade; o teste liga a objetos de mentira.
 */
export interface RefundPorts {
  /**
   * RESERVA a corrida ANTES de qualquer chamada que mova dinheiro. Opcional: só
   * o chamador que corre contra outros escritores precisa (a varredura). Ver
   * `runRefundFlow`, seção 0.
   *
   * O contrato é um UPDATE CONDICIONAL que devolve a linha afetada — "reservei"
   * é ter tomado a linha, não ter lido um estado um instante antes.
   */
  claim?(rideId: string): Promise<{ claimed: boolean; detail?: string | null }>;

  /**
   * DESFAZ a reserva quando nenhum dinheiro chegou a sair. Só chamada depois de
   * um `claim` que deu certo e de um estorno que NÃO se concretizou.
   */
  compensateClaim?(rideId: string, detail: string): Promise<void>;

  /** `transfers.createReversal`. Só chamada quando `plan.action === 'reverse'`. */
  createReversal(input: {
    transferId: string;
    amountCents: number;
    rideId: string;
  }): Promise<{ id: string }>;

  /** `refunds.create` no PaymentIntent da tarifa. */
  createRefund(input: {
    paymentIntentId: string;
    rideId: string;
    reversalId: string | null;
    /** Derivada do PaymentIntent, não da corrida — ver runRefundFlow. */
    idempotencyKey: string;
  }): Promise<RefundShape>;

  /** `update rides set paid = false`. */
  markUnpaid(rideId: string): Promise<{ error: DbWriteError | null }>;

  /** Upsert idempotente em `stripe_reconciliation`. Nunca lança. */
  recordAudit(row: RefundAuditRow): Promise<void>;

  /** Webhook externo + push aos admins. Nunca lança. */
  alertAdmins(message: string, meta: Record<string, unknown>): Promise<void>;
}

export interface RefundFlowInput {
  rideId: string;
  /** `rides.stripe_payment_intent_id` — já validado como presente pelo chamador. */
  paymentIntentId: string;
  /** Plano vindo de `planDriverReversal`. */
  plan: ReversalPlan;
  driverId: string | null;
  payoutId: string | null;
  driverAmount: number | null;
  tipAmount: number | null;
  tipPayoutId: string | null;
  rideStatus: string | null;
  /** Situação da gorjeta — ver TipDisposition em refundReversal.ts. */
  tip: TipDisposition;
}

export type RefundFlowResult =
  | { ok: true; status: 200; body: Record<string, unknown> }
  | { ok: false; status: number; body: Record<string, unknown> };

/**
 * Chave de idempotência do estorno, derivada do PAYMENT INTENT e não da corrida.
 *
 * Todo movimento de dinheiro do repositório carrega uma
 * (`charge-ride`, `tip-ride:122`, `run-weekly-payouts:183`,
 * `_shared/tipPayout.ts:90`, e a própria reversão em `refund-ride`); o
 * `refunds.create` era o único sem. Hoje uma retentativa depois de um timeout de
 * rede é recusada pelo Stripe com `charge_already_refunded`, então a exposição é
 * um 500 espúrio, não um estorno em dobro — mas é a última mutação desprotegida.
 *
 * POR QUE O PAYMENT INTENT E NÃO A CORRIDA: uma chave `refund_<rideId>` seria
 * ETERNA por corrida — exatamente o defeito que `chargeIdempotencyKey` acabou de
 * remover do lado da cobrança. Uma corrida pode ser cobrada, estornada, cobrada
 * de novo (ciclo novo, PaymentIntent novo) e estornada de novo; com a chave por
 * corrida, o segundo estorno receberia de volta a RESPOSTA do primeiro — o
 * refund antigo, com status 'succeeded' — e o fluxo gravaria `paid = false`
 * achando que estornou, sem um centavo ter voltado. Amarrada ao PaymentIntent, a
 * chave avança sozinha a cada ciclo.
 */
export function refundIdempotencyKey(paymentIntentId: string): string {
  return `refund_${paymentIntentId}`;
}

/** Status de refund que significam "o dinheiro está a caminho do passageiro". */
function refundIsGoingThrough(status?: string | null): boolean {
  return status === 'succeeded' || status === 'pending';
}

/**
 * "A caminho" NÃO é "chegou" — e a diferença é dinheiro do motorista.
 *
 * `refundIsGoingThrough` aceita 'pending' como sucesso, e isso está certo para
 * decidir o FLUXO: um refund pendente não deve derrubar a operação nem devolver
 * erro ao chamador. O que estava errado era o que se escrevia depois. Quando a
 * reversão do transfer FOI EXECUTADA (o motorista já foi debitado) e o refund
 * ficou 'pending', o dinheiro saiu do motorista contra um estorno que ainda pode
 * FALHAR no emissor do cartão — e falha assíncrona chega DEPOIS da resposta
 * HTTP, onde `reversalOrphaned()` estruturalmente não alcança. Nesse intervalo a
 * linha de conciliação afirmava `code: 'reversed'`, `needsAttention: false`,
 * `balanced: true`: os livros diziam que fechou, com um debitado e um não
 * ressarcido.
 *
 * Isto marca esse intervalo como PENDÊNCIA ABERTA — uma linha que um humano
 * fecha quando o refund liquidar (ou escala, se falhar). Quem AVISA que falhou é
 * o handler de `refund.failed` / `charge.refund.updated` do stripe-webhook.
 *
 * POR QUE SÓ 'pending', E NÃO "qualquer coisa diferente de succeeded": o caso
 * comum, de longe, é o refund voltar 'succeeded' na mesma chamada — e esse
 * caminho continua saindo daqui `balanced: true`, sem pendência e sem alerta.
 * Marcar o caso comum seria fabricar fadiga de alerta e, com ela, cegueira para
 * o caso que importa. Os status ruins ('failed', 'canceled', 'requires_action')
 * nem chegam aqui: são barrados antes, por `refundIsGoingThrough`.
 *
 * Sem reversão (`reversed === false`) não há exposição NENHUMA a marcar: o
 * dinheiro do motorista continua onde estava, e um refund pendente que falhe
 * apenas deixa a corrida `paid = false` sem estorno — pendência de outra
 * natureza, que o webhook registra.
 */
export function reversalAheadOfRefund(input: {
  reversed: boolean;
  refundStatus?: string | null;
}): boolean {
  return input.reversed && input.refundStatus === 'pending';
}

/** Mensagem legível de um erro do Stripe (mesma extração da Edge Function). */
function errMessage(e: unknown): string {
  const se = e as { raw?: { message?: string }; message?: string };
  return se?.raw?.message ?? se?.message ?? String(e);
}

/**
 * Roda a sequência de dinheiro do estorno.
 *
 * A ORDEM É A PARTE QUE IMPORTA e não muda: reverter o transfer do motorista
 * ANTES de estornar o passageiro. O transfer é sacado da própria cobrança
 * (`source_transaction`), então reverter primeiro devolve o dinheiro ao saldo da
 * plataforma e só então o refund sai desse saldo; na ordem inversa a plataforma
 * fica descoberta no intervalo.
 */
export async function runRefundFlow(
  ports: RefundPorts,
  input: RefundFlowInput,
): Promise<RefundFlowResult> {
  const { rideId, plan } = input;

  // ═══════════════════════════════════════════════════════════════════════════
  // 0) RESERVAR ANTES DE GASTAR
  // ═══════════════════════════════════════════════════════════════════════════
  // Ler o estado da corrida e DEPOIS chamar o Stripe deixa uma janela do tamanho
  // de uma ida e volta de rede em que outra pessoa muda a linha. Na varredura
  // isso é o defeito mais afiado do módulo: `charge-ride:154` devolve
  // `already_paid` SEM criar PaymentIntent novo quando `r.paid` é true, e o
  // aceite do motorista (useRide.ts:1666-1680) só filtra por
  // `.eq('status','requesting')` — então uma corrida presa em `requesting` +
  // `paid = true` ainda pode ser aceita, sem gerar cobrança nenhuma. Se esse
  // aceite cair entre a releitura da varredura e o `refunds.create`, o estorno
  // sai numa viagem EM ANDAMENTO: o passageiro anda de graça e o motorista nunca
  // recebe (run-weekly-payouts:269 exige `paid = true`).
  //
  // A reserva fecha a janela porque não é uma leitura: é um UPDATE condicional
  // que só casa se a corrida AINDA estiver no estado do defeito. Quem perder a
  // corrida contra o aceite simplesmente não pega linha nenhuma e não gasta.
  const claimed = !!ports.claim;
  if (ports.claim) {
    const claim = await ports.claim(rideId);
    if (!claim.claimed) {
      return {
        ok: false,
        status: 409,
        body: {
          error: 'A corrida mudou de estado antes do estorno — nada foi movido.',
          code: 'claim_lost',
          detail: claim.detail ?? null,
        },
      };
    }
  }

  /**
   * Devolve a corrida ao estado anterior à reserva. Só faz sentido quando NENHUM
   * dinheiro saiu — se o estorno tiver acontecido, desfazer a reserva mentiria.
   */
  const undoClaim = async (detail: string): Promise<void> => {
    if (!claimed || !ports.compensateClaim) return;
    await ports.compensateClaim(rideId, detail);
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // 1) A parte do motorista já saiu? Se saiu, reverte ANTES de estornar.
  // ═══════════════════════════════════════════════════════════════════════════
  let reversed = false;
  let reversalError: string | null = null;
  let reversalId: string | null = null;

  if (plan.action === 'reverse') {
    try {
      const rev = await ports.createReversal({
        transferId: plan.transferId,
        amountCents: plan.amountCents,
        rideId,
      });
      reversed = true;
      reversalId = rev.id;
    } catch (e) {
      // O caso real e esperado: `balance_insufficient` — o motorista já sacou.
      // NÃO derruba o estorno do passageiro; vira pendência registrada.
      reversalError = errMessage(e);
    }
  }

  const reversedCents = plan.action === 'reverse' ? plan.amountCents : 0;

  /**
   * O acidente que não pode acabar em silêncio: a reversão SAIU e o estorno ao
   * passageiro NÃO. O motorista foi debitado por um estorno que o passageiro
   * nunca recebeu, e a corrida continua `paid = true` — portanto elegível a
   * repasse de novo (run-weekly-payouts/index.ts:271-274). Registra e alerta
   * antes de devolver o erro ao chamador.
   */
  const reversalOrphaned = async (
    suffix: string,
    detail: string,
    raw: Record<string, unknown>,
  ): Promise<void> => {
    if (!reversed) return;
    await ports.recordAudit({
      eventId: `refund_fail_${rideId}_${reversalId}_${suffix}`,
      rideId,
      driverId: input.driverId,
      payoutId: input.payoutId,
      amountCents: reversedCents,
      needsAttention: true,
      code: 'refund_failed_after_reversal',
      reason:
        `Transfer ${plan.action === 'reverse' ? plan.transferId : '?'} REVERTIDO (reversal ${reversalId}, ` +
        `${reversedCents} centavos), mas o estorno ao passageiro NÃO se concretizou: ${detail}. ` +
        'O motorista foi debitado, o passageiro não foi estornado e a corrida segue paid = true ' +
        '(portanto elegível a repasse de novo) — resolva manualmente.',
      raw: { reversal_id: reversalId, ride_status: input.rideStatus, ...raw },
    });
    await ports.alertAdmins(
      `Estorno da corrida ${rideId}: a reversão do repasse ao motorista foi feita mas o estorno ao passageiro NÃO saiu (${detail}). Resolva manualmente.`,
      { type: 'refund_failed_after_reversal', rideId },
    );
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // 2) Estorno do passageiro
  // ═══════════════════════════════════════════════════════════════════════════
  let refund: RefundShape;
  try {
    refund = await ports.createRefund({
      paymentIntentId: input.paymentIntentId,
      rideId,
      reversalId,
      idempotencyKey: refundIdempotencyKey(input.paymentIntentId),
    });
  } catch (e) {
    // `refunds.create` LANÇOU. NENHUM centavo voltou ao passageiro, então a
    // reserva precisa ser desfeita — senão a corrida fica `paid = false` (e, na
    // varredura, `cancelled`) com o dinheiro ainda no Stripe: passageiro cobrado,
    // corrida morta, e o repasse já não a alcança.
    await undoClaim(`refunds.create lançou: ${errMessage(e)}`);
    await reversalOrphaned('threw', errMessage(e), { failure: 'exception' });
    return { ok: false, status: 500, body: { error: errMessage(e) } };
  }

  if (!refundIsGoingThrough(refund.status)) {
    // `refunds.create` RESOLVEU com status ruim. Mesmo acidente do catch acima —
    // e era exatamente este ramo que devolvia 400 seco sem registrar nada.
    const detail = `o Stripe devolveu o refund ${refund.id} com status ${refund.status}`;
    // Mesmo raciocínio do catch acima: 'failed'/'canceled'/'requires_action'
    // significam que o passageiro NÃO foi ressarcido, então a reserva é desfeita.
    await undoClaim(detail);
    await reversalOrphaned('status', detail, {
      failure: 'bad_status',
      refund_id: refund.id,
      refund_status: refund.status ?? null,
    });
    return {
      ok: false,
      status: 400,
      body: {
        error: `Estorno retornou status inesperado: ${refund.status}`,
        code: 'refund_not_succeeded',
        refund_id: refund.id,
        // Sem isto o chamador não tem como saber que o motorista já foi debitado.
        reversal: { reversed, reversal_id: reversalId, unrecovered_cents: reversed ? reversedCents : 0 },
      },
    };
  }

  // Marca a corrida como não-paga (estornada). É isto que a tira da fila de
  // repasse quando ela ainda não tinha saído.
  //
  // O erro desta gravação NÃO pode ser ignorado: o dinheiro já voltou ao
  // passageiro, e uma corrida que continua `paid = true` com `payout_id` nulo
  // permanece ELEGÍVEL a repasse (run-weekly-payouts/index.ts:271-274) — o
  // motorista receberia 80-85% de uma cobrança que não existe mais. Como o
  // estorno no Stripe é irreversível a esta altura, o certo não é falhar e sim
  // registrar a pendência com o valor exposto e chamar um humano.
  //
  // Quando houve RESERVA (seção 0) o `paid = false` já foi gravado por ela — e
  // gravar de novo aqui seria pior do que redundante: `markUnpaid` filtra por
  // `.eq('paid', true)`, então a segunda escrita não casa linha nenhuma, não
  // devolve erro, e o resultado seria indistinguível de sucesso mesmo se a
  // reserva tivesse sido desfeita por outra pessoa nesse meio-tempo.
  const { error: paidErr } = claimed ? { error: null } : await ports.markUnpaid(rideId);
  if (paidErr) {
    await ports.recordAudit({
      eventId: `refund_unpaid_write_${refund.id}`,
      rideId,
      driverId: input.driverId,
      payoutId: input.payoutId,
      amountCents: Math.round((input.driverAmount ?? 0) * 100),
      needsAttention: true,
      code: 'paid_flag_write_failed',
      reason:
        `Estorno ${refund.id} concluído no Stripe, mas gravar paid = false FALHOU: ${paidErr.message}. ` +
        'Enquanto a corrida seguir paid = true com payout_id nulo ela continua elegível a repasse e pode ' +
        'pagar o motorista por uma cobrança já devolvida. Corrija a mão.',
      raw: { refund_id: refund.id, db_error: paidErr.message, db_code: paidErr.code ?? null },
    });
    await ports.alertAdmins(
      `Estorno da corrida ${rideId} saiu no Stripe mas o banco NÃO gravou paid = false (${paidErr.message}). Ela continua elegível a repasse — corrija imediatamente.`,
      { type: 'refund_paid_flag_write_failed', rideId },
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3) Registro de conciliação — SEMPRE, inclusive quando fechou certinho
  // ═══════════════════════════════════════════════════════════════════════════
  const outcome = summarizeRefund({ plan, reversed, reversalError, tip: input.tip });

  // Reversão executada + refund ainda 'pending' = motorista debitado contra um
  // estorno que ainda não é definitivo. Ver reversalAheadOfRefund.
  const pendingExposure = reversalAheadOfRefund({ reversed, refundStatus: refund.status });
  const pendingNote = pendingExposure
    ? ` PENDÊNCIA ABERTA: o refund ${refund.id} voltou com status 'pending' — o dinheiro AINDA NÃO ` +
      `chegou ao passageiro — e a reversão de ${reversedCents} centavos do transfer do motorista JÁ FOI ` +
      'EXECUTADA. Enquanto o refund não liquidar, o motorista está debitado por um ressarcimento que ' +
      'ainda pode falhar no emissor do cartão. Feche esta linha quando o refund virar succeeded; se ele ' +
      'falhar, o handler de refund.failed/charge.refund.updated do stripe-webhook abre a pendência crítica.'
    : '';

  await ports.recordAudit({
    eventId: `refund_${refund.id}`,
    rideId,
    driverId: input.driverId,
    payoutId: input.payoutId,
    amountCents: refund.amount ?? 0,
    needsAttention: outcome.needsAttention || pendingExposure,
    code: outcome.code,
    reason: outcome.reason + pendingNote,
    raw: {
      refund_id: refund.id,
      refund_status: refund.status ?? null,
      reversal_id: reversalId,
      reversal_error: reversalError,
      transfer_id: plan.action === 'skip'
        ? ('transferId' in plan ? plan.transferId : null)
        : plan.transferId,
      unrecovered_cents: outcome.unrecoveredCents,
      // Centavos que saíram do motorista contra um estorno ainda não definitivo.
      // 0 no caminho normal (refund 'succeeded').
      pending_refund_exposure_cents: pendingExposure ? reversedCents : 0,
      tip_code: outcome.tipCode,
      driver_amount: input.driverAmount,
      tip_amount: input.tipAmount,
      tip_payout_id: input.tipPayoutId,
      ride_status: input.rideStatus,
    },
  });

  // DELIBERADO: `pendingExposure` sozinho NÃO dispara push. Ele já é uma linha
  // com `needs_attention = true`, que é a fila que um humano trabalha; um refund
  // 'pending' costuma liquidar sozinho em minutos/horas e acordar a equipe por
  // cada um deles transformaria o canal de alerta em ruído — e o ruído é o que
  // faz o alerta de verdade (refund.failed, no webhook) passar despercebido.
  if (outcome.needsAttention) {
    await ports.alertAdmins(
      `Estorno da corrida ${rideId} deixou os livros abertos (${outcome.code}/${outcome.tipCode}): ${outcome.reason}`,
      {
        type: 'refund_needs_attention',
        rideId,
        code: outcome.code,
        tipCode: outcome.tipCode,
        cents: outcome.unrecoveredCents,
      },
    );
  }

  return {
    ok: true,
    status: 200,
    body: {
      success: true,
      refund_id: refund.id,
      refund_status: refund.status ?? null,
      // O chamador precisa saber que o estorno saiu mas não fechou — hoje
      // ninguém falha por causa disso (o cancelamento segue), mas a informação
      // deixa de ser invisível.
      //
      // `pendingExposure` derruba o `balanced` porque os livros NÃO fecharam: o
      // motorista foi debitado e o passageiro ainda não recebeu. Dizer
      // `balanced: true` aqui era afirmar um fechamento que só se confirma
      // quando o refund liquidar.
      balanced: outcome.balanced && !pendingExposure,
      pending_refund_exposure_cents: pendingExposure ? reversedCents : 0,
      tip: { code: outcome.tipCode },
      reversal: {
        code: outcome.code,
        transfer_id: plan.action === 'reverse' ? plan.transferId : null,
        reversal_id: reversalId,
        unrecovered_cents: outcome.unrecoveredCents,
        error: reversalError,
      },
    },
  };
}
