// Decisão PURA do ESTORNO de uma corrida — sem I/O, sem globais do Deno (mesmo
// padrão de _shared/payout.ts): a Edge Function `refund-ride` faz as chamadas ao
// Stripe e ao banco, mas QUEM DECIDE o que precisa ser desfeito, quanto, e o que
// precisa virar pendência humana mora aqui e é coberto por teste.
//
// ─────────────────────────────────────────────────────────────────────────────
// O BURACO QUE ISTO FECHA
// ─────────────────────────────────────────────────────────────────────────────
// O modelo de pagamento é Separate Charges & Transfers (decisão do dono, não se
// mexe): a plataforma cobra o cartão do passageiro na hora e a parte do
// motorista sai DEPOIS, num transfer semanal para a conta conectada dele
// (run-weekly-payouts / request-payout). São dois movimentos independentes.
//
// `refund-ride` só conhecia o primeiro. Ele criava o refund no Stripe e gravava
// `paid = false` — e parava aí. Enquanto a corrida ainda não tinha entrado num
// repasse, isso bastava: a elegibilidade é `paid = true and payout_id is null`,
// então `paid = false` já a tira da fila. Mas depois que o repasse SAIU, não há
// fila nenhuma para tirar a corrida — o dinheiro já está na conta do motorista.
// O passageiro recebia 100% de volta, o motorista ficava com 80-85%, e a
// diferença saía do bolso da plataforma sem uma linha de log. `transfers
// .createReversal` não aparecia em lugar nenhum do repositório.
//
// A resposta de manual: reverter o transfer. O problema de mundo real: a conta
// conectada pode não ter saldo para devolver (o motorista já sacou). Por isso
// este módulo trata "não deu para reverter" como um RESULTADO de primeira
// classe — com valor, motivo e marcação de pendência — e não como um catch
// vazio. O estorno do passageiro segue (ele não pode ficar refém do saldo do
// motorista), mas nunca em silêncio.

/** Forma mínima de um transfer do Stripe, só o que decide a reversão. */
export interface TransferShape {
  id: string;
  /** Centavos originalmente transferidos. */
  amount: number;
  /** Centavos já revertidos deste transfer. */
  amount_reversed?: number | null;
  destination?: string | { id?: string } | null;
  metadata?: Record<string, string> | null;
}

export interface MatchTransferInput {
  /** Corrida cujo transfer procuramos. */
  rideId: string;
  /** Repasse em que ela saiu (`rides.payout_id` ou `rides.tip_payout_id`). */
  payoutId?: string | null;
  /** Conta conectada do motorista — cinto de segurança contra reverter a conta errada. */
  accountId: string;
  /** 'fare' = transfer da tarifa; 'tip' = transfer da gorjeta (metadata.kind='tip'). */
  kind: 'fare' | 'tip';
}

function destinationId(t: TransferShape): string | null {
  const d = t.destination;
  if (!d) return null;
  return typeof d === 'string' ? d : (d.id ?? null);
}

/**
 * Acha, numa lista de transfers do Stripe, o que pertence a ESTA corrida.
 *
 * Por que procurar em vez de ler do banco: nenhuma coluna guarda o transfer por
 * corrida. `run-weekly-payouts` e `request-payout` criam UM transfer por corrida
 * (com `metadata.ride_id`) mas só persistem o PRIMEIRO id do lote, em
 * `payouts.stripe_transfer_id` (_shared/payout.ts:147, reconcileSettlement);
 * `_shared/tipPayout.ts:89` nem guarda o id. Então o único lugar onde a
 * associação transfer↔corrida existe é o `metadata` do próprio Stripe.
 *
 * Três filtros, todos obrigatórios:
 *   • `metadata.ride_id` — é a corrida certa;
 *   • `kind` — tarifa e gorjeta são transfers SEPARADOS (ver 0064); reverter o
 *     da gorjeta achando que é o da tarifa tiraria do motorista um dinheiro que
 *     não está sendo estornado ao passageiro;
 *   • `destination` — a conta conectada bate com a do motorista da corrida.
 *
 * `payoutId` é conferido quando ambos os lados o têm. Se o transfer não trouxer
 * `metadata.payout_id`, os outros três filtros já identificam a linha, e exigir
 * o quarto faria a busca falhar em transfers legados.
 */
export function findRideTransfer(
  transfers: TransferShape[],
  input: MatchTransferInput,
): TransferShape | null {
  for (const t of transfers) {
    const meta = t.metadata ?? {};
    if (meta.ride_id !== input.rideId) continue;

    const isTip = meta.kind === 'tip';
    if (input.kind === 'tip' ? !isTip : isTip) continue;

    if (destinationId(t) !== input.accountId) continue;

    if (input.payoutId && meta.payout_id && meta.payout_id !== input.payoutId) continue;

    return t;
  }
  return null;
}

export type ReversalPlan =
  | { action: 'reverse'; transferId: string; amountCents: number }
  | { action: 'skip'; reason: 'already_reversed'; transferId: string }
  | { action: 'skip'; reason: 'nothing_transferred' | 'transfer_not_found' | 'no_driver_account' };

export interface PlanReversalInput {
  /** `rides.payout_id` — nulo significa que a tarifa nunca entrou num repasse. */
  payoutId?: string | null;
  /** Conta conectada do motorista, se ele tiver uma. */
  accountId?: string | null;
  /** O transfer localizado no Stripe (null quando a busca não achou). */
  transfer?: TransferShape | null;
}

/**
 * O que fazer com a parte do motorista.
 *
 * `payoutId` nulo é o caso feliz e o mais comum: o dinheiro do motorista ainda
 * está na plataforma, e gravar `paid = false` já basta — a corrida deixa de ser
 * elegível (`paid = true and payout_id is null`) e nunca vira transfer.
 *
 * Com `payoutId` preenchido o dinheiro OU já saiu OU está saindo agora (as duas
 * funções de repasse reservam a corrida ANTES de chamar o Stripe e só limpam
 * `payout_id` se o transfer falhar). Nos dois casos o certo é procurar o
 * transfer e revertê-lo.
 *
 * O valor revertido é o que AINDA NÃO foi revertido daquele transfer
 * (`amount - amount_reversed`), e não `rides.driver_amount`: o transfer é o
 * registro do que de fato saiu, e a subtração torna a operação repetível sem
 * reverter duas vezes (uma retentativa depois de uma falha parcial encontra
 * `amount_reversed` já preenchido e devolve `already_reversed`).
 */
export function planDriverReversal(input: PlanReversalInput): ReversalPlan {
  if (!input.payoutId) return { action: 'skip', reason: 'nothing_transferred' };
  if (!input.accountId) return { action: 'skip', reason: 'no_driver_account' };
  if (!input.transfer) return { action: 'skip', reason: 'transfer_not_found' };

  const remaining = input.transfer.amount - (input.transfer.amount_reversed ?? 0);
  if (remaining <= 0) {
    return { action: 'skip', reason: 'already_reversed', transferId: input.transfer.id };
  }
  return { action: 'reverse', transferId: input.transfer.id, amountCents: remaining };
}

/**
 * Situação da GORJETA desta corrida no instante do estorno da tarifa.
 *
 * A gorjeta é cobrança separada (0064), com PaymentIntent próprio e transfer
 * próprio, e `refund-ride` NÃO a estorna. Mas o estorno da tarifa grava
 * `paid = false`, e é aí que os dois casos abaixo divergem — e por que o
 * segundo é uma armadilha silenciosa:
 *
 *   • 'transferred' — a gorjeta JÁ saiu para o motorista: `tip_payout_id`
 *     preenchido E o repasse correspondente `completed`. O passageiro não a
 *     recebe de volta e o motorista fica com ela. Pode ser o certo; é decisão
 *     humana.
 *
 *   • 'charged_payout_pending' — `tip_payout_id` preenchido, repasse AINDA NÃO
 *     `completed`. É a diferença entre "reservada" e "transferida", e ela
 *     importa: `claimPendingTips` (_shared/tipPayout.ts:47) grava
 *     `tip_payout_id` ANTES de `settleTips` chamar o Stripe. Se o transfer da
 *     gorjeta falhar, o `tip_payout_id` é devolvido a null
 *     (run-weekly-payouts/index.ts:207-209, request-payout equivalente) — mas
 *     até lá, e durante toda a execução do repasse, a corrida carrega um
 *     `tip_payout_id` sem transfer nenhum atrás dele. Derivar 'transferred' só
 *     da presença da coluna fazia a nota operacional AFIRMAR ao operador que "a
 *     gorjeta já foi repassada ao motorista" quando ela podia não ter saído.
 *     Isso se resolve sozinho em até ~15 min (`unstickStalePayouts`,
 *     request-payout/index.ts:102-122, que solta `tip_payout_id` dos repasses
 *     travados), mas dentro dessa janela o texto era falso e o operador podia
 *     agir sobre ele.
 *
 *   • 'charged_not_transferred' — a gorjeta foi COBRADA do passageiro
 *     (`tip_amount > 0`, gravado só depois da cobrança em tip-ride:132-134) mas
 *     AINDA NÃO tinha sido repassada (`tip_payout_id` nulo). Toda via de
 *     elegibilidade de repasse de gorjeta exige `paid = true`
 *     (_shared/tipPayout.ts:49, run-weekly-payouts/index.ts:284-286,
 *     request-payout/index.ts:247-251), então o `paid = false` deste estorno a
 *     torna PERMANENTEMENTE inelegível: o passageiro pagou, o motorista nunca
 *     vai receber, e o dinheiro fica com a plataforma. Antes disto o caso saía
 *     daqui como `no_payout_yet` / `balanced: true` / `needsAttention: false` —
 *     ou seja, sem uma linha escrita em lugar nenhum.
 */
export type TipDisposition =
  | 'none'
  | 'transferred'
  | 'charged_payout_pending'
  | 'charged_not_transferred';

/** Código estável da pendência de gorjeta, para log/registro. */
export type TipVerdict =
  | 'tip_none'
  | 'tip_transferred_not_refunded'
  | 'tip_payout_pending'
  | 'tip_charged_never_transferable';

export interface RefundOutcomeInput {
  /** O plano executado (ou pulado). */
  plan: ReversalPlan;
  /** Reversão de fato concluída no Stripe? Só relevante quando plan.action = 'reverse'. */
  reversed: boolean;
  /** Erro cru do Stripe quando a reversão falhou. */
  reversalError?: string | null;
  /** Situação da gorjeta desta corrida. Ver TipDisposition. */
  tip?: TipDisposition;
}

export interface RefundOutcome {
  /**
   * Os livros da TARIFA fecham sozinhos, sem intervenção humana?
   *
   * Fala só da tarifa de propósito: a gorjeta tem cobrança e transfer próprios e
   * NÃO é estornada aqui, então ela nunca "desequilibra" o estorno da tarifa —
   * ela abre uma pendência PARALELA, que sai em `tipCode` + `needsAttention`.
   */
  balanced: boolean;
  /** Vira pendência em stripe_reconciliation.needs_attention. */
  needsAttention: boolean;
  /** Código estável para log/registro. */
  code:
    | 'no_payout_yet'
    | 'reversed'
    | 'already_reversed'
    | 'reversal_failed'
    | 'transfer_not_found'
    | 'no_driver_account';
  /**
   * Pendência da GORJETA, independente do código da tarifa acima. Qualquer valor
   * diferente de 'tip_none' força `needsAttention`.
   */
  tipCode: TipVerdict;
  /** Centavos que a plataforma NÃO recuperou do motorista (0 quando fechou). */
  unrecoveredCents: number;
  /** Frase pronta para o registro de conciliação. */
  reason: string;
}

/**
 * Traduz "o que aconteceu" em "os livros fecham?" — e, quando não fecham, em
 * quanto e por quê.
 *
 * A regra que importa: NENHUM caminho devolve `balanced: true` com dinheiro
 * irrecuperado. Um estorno que não conseguiu reverter o repasse ainda acontece
 * (o passageiro não pode ficar refém do saldo do motorista), mas sai daqui
 * marcado, com valor, e vira linha de pendência.
 */
export function summarizeRefund(input: RefundOutcomeInput): RefundOutcome {
  const tip: TipDisposition = input.tip ?? 'none';

  const tipCode: TipVerdict =
    tip === 'transferred'             ? 'tip_transferred_not_refunded' :
    tip === 'charged_payout_pending'  ? 'tip_payout_pending' :
    tip === 'charged_not_transferred' ? 'tip_charged_never_transferable' :
                                        'tip_none';

  const tipNote =
    tip === 'transferred'
      ? ' A gorjeta desta corrida já foi repassada ao motorista e NÃO é estornada aqui (refund-ride só estorna a tarifa) — confira se ela deve ser devolvida também.'
    : tip === 'charged_payout_pending'
      ? ' GORJETA EM REPASSE NÃO CONCLUÍDO: a corrida tem tip_payout_id preenchido, mas o repasse correspondente NÃO está completed — a reserva é gravada ANTES do transfer sair (_shared/tipPayout.ts:47), então NÃO se pode afirmar que a gorjeta chegou ao motorista. Confira o repasse no Stripe antes de decidir. Se o transfer da gorjeta tiver falhado, o tip_payout_id volta a null sozinho (no máximo ~15 min, via unstickStalePayouts) e o caso vira o de gorjeta cobrada e nunca repassável — que este estorno torna PERMANENTE ao gravar paid = false.'
    : tip === 'charged_not_transferred'
      ? ' ARMADILHA DA GORJETA: a gorjeta desta corrida FOI COBRADA do passageiro mas AINDA NÃO havia sido repassada, e este estorno grava paid = false — o que a torna PERMANENTEMENTE inelegível a repasse, porque toda via de elegibilidade exige paid = true (_shared/tipPayout.ts:49, run-weekly-payouts/index.ts:284-286, request-payout/index.ts:247-251). Sem uma decisão humana o passageiro pagou a gorjeta, o motorista nunca a recebe e ela fica com a plataforma. Decida: estornar a gorjeta ao passageiro OU repassá-la ao motorista à mão.'
      : '';

  // A gorjeta nunca APAGA uma pendência da tarifa; ela só acrescenta a sua.
  // `balanced` continua falando apenas da tarifa (ver RefundOutcome.balanced).
  const attention = (o: Omit<RefundOutcome, 'tipCode'>): RefundOutcome => ({
    ...o,
    tipCode,
    needsAttention: o.needsAttention || tip !== 'none',
    reason: o.reason + tipNote,
  });

  if (input.plan.action === 'skip') {
    switch (input.plan.reason) {
      case 'nothing_transferred':
        return attention({
          balanced: true,
          needsAttention: false,
          code: 'no_payout_yet',
          unrecoveredCents: 0,
          reason: 'Estorno integral. A parte do motorista ainda não havia sido repassada — a corrida sai da fila de repasse com paid = false.',
        });
      case 'already_reversed':
        return attention({
          balanced: true,
          needsAttention: false,
          code: 'already_reversed',
          unrecoveredCents: 0,
          reason: `Estorno integral. O transfer ${input.plan.transferId} já estava totalmente revertido.`,
        });
      case 'transfer_not_found':
        return attention({
          balanced: false,
          needsAttention: true,
          code: 'transfer_not_found',
          unrecoveredCents: 0,
          reason: 'Estorno feito, mas o transfer da corrida NÃO foi localizado no Stripe apesar de payout_id estar preenchido. Verifique manualmente se a parte do motorista saiu e reverta-a à mão.',
        });
      case 'no_driver_account':
        return attention({
          balanced: false,
          needsAttention: true,
          code: 'no_driver_account',
          unrecoveredCents: 0,
          reason: 'Estorno feito, mas a corrida tem payout_id sem conta conectada do motorista para reverter. Estado inconsistente — apure manualmente.',
        });
    }
  }

  if (input.reversed) {
    return attention({
      balanced: true,
      needsAttention: false,
      code: 'reversed',
      unrecoveredCents: 0,
      reason: `Estorno integral com reversão de ${input.plan.amountCents} centavos do transfer ${input.plan.transferId}.`,
    });
  }

  return attention({
    balanced: false,
    needsAttention: true,
    code: 'reversal_failed',
    unrecoveredCents: input.plan.amountCents,
    reason: `Estorno feito, mas a reversão de ${input.plan.amountCents} centavos do transfer ${input.plan.transferId} FALHOU: ${input.reversalError ?? 'motivo não informado'}. A plataforma está no prejuízo neste valor até cobrá-lo do motorista (o caso típico é saldo insuficiente na conta conectada, quando o motorista já sacou).`,
  });
}
