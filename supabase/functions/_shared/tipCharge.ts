// Decisões PURAS da cobrança de gorjeta — sem I/O, sem globais do Deno (mesmo
// padrão de _shared/chargeCycle.ts, _shared/refundFlow.ts e
// _shared/staleRideSweep.ts: roda igual na Edge Function e no Jest do app).
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE ISTO CONSERTA, E COMO SE SABE QUE ESTAVA QUEBRADO
// ─────────────────────────────────────────────────────────────────────────────
//
// Conferido contra a conta Stripe de produção em 05/09/2026: em toda a história
// do app existe **UM** PaymentIntent com `metadata.type = 'tip'` —
// `pi_3U5PGQCgSu88OSlV1dhyGTtQ`, $10,00, `succeeded`, corrida
// `6acaf884-9e16-43a9-9ae9-5845cc7364d9`, 17/08/2026. No banco, essa mesma
// corrida tem `tip_amount = 10` e `tip_payment_intent_id = NULL` — e a coluna
// está NULA em 100% das 84 corridas que têm `tip_amount > 0`.
//
// As duas metades desse fato são dois defeitos diferentes:
//
//   1. A GORJETA ÓRFÃ. `_shared/tipPayout.ts` usa `tip_payment_intent_id` como
//      `source_transaction` do transfer. Sem ele, a gorjeta NUNCA chega ao
//      motorista — ela vai 100% para ele (migração 0064), então o dinheiro
//      cobrado do passageiro fica parado. A versão da `tip-ride` que rodava em
//      17/08 (commit 1c57718) gravava só `tip_amount`; o `tip_payment_intent_id`
//      entrou depois (ea57da5). Mas o modo de falha continua vivo no código
//      atual: o resultado do `.update()` é DESCARTADO, então Stripe cobrar e o
//      banco recusar dá exatamente a mesma órfã, em silêncio, sem reparador.
//
//   2. A GORJETA TRANCADA NO PRIMEIRO VALOR. A chave de idempotência era
//      `tip_<rideId>`, sem o valor. A primeira tentativa QUEIMA a chave com os
//      parâmetros dela. Se ela falhar (recusa off-session, rede, cartão sem
//      saldo) e o passageiro tentar OUTRO valor, o Stripe recusa com
//      `idempotency_error` — 400 com um texto de engenharia em inglês — e
//      aquela corrida não aceita mais gorjeta nenhuma, para sempre. É o item
//      P2-5 da AUDITORIA.md, que estava aberto.
//
// A chave passa a incluir o valor: duplo-toque no MESMO valor continua
// idempotente (que é a proteção que importa contra cobrança dupla), e um valor
// diferente é um pedido de verdade, não uma repetição.

/**
 * Chave de idempotência da cobrança de gorjeta.
 *
 * O valor entra na chave DE PROPÓSITO. Ver o cabeçalho: sem ele, a primeira
 * tentativa tranca a corrida no valor que falhou.
 *
 * O que a chave garante e o que NÃO garante: o Stripe descarta chaves depois de
 * ~24 h (mesma nota de `_shared/chargeCycle.ts`). Dentro dessa janela, duas
 * chamadas com o mesmo par (corrida, valor) devolvem o MESMO PaymentIntent.
 * Passado o prazo, a chave é nova — quem impede a cobrança dupla aí é a busca
 * por gorjeta já cobrada (`acharGorjetaCobrada`), não a chave.
 */
export function tipIdempotencyKey(rideId: string, amountCents: number): string {
  return `tip_${rideId}_${amountCents}`;
}

/** A forma mínima de um PaymentIntent que a decisão precisa enxergar. */
export interface TipIntentLike {
  id: string;
  status: string;
  amount: number;
  metadata?: Record<string, string | undefined> | null;
}

/**
 * Acha, numa lista de PaymentIntents do cliente, a gorjeta JÁ COBRADA E
 * LIQUIDADA desta corrida.
 *
 * É o reparador da órfã e, ao mesmo tempo, a trava contra cobrança dupla quando
 * a chave de idempotência já expirou: antes de criar qualquer cobrança nova, a
 * `tip-ride` pergunta ao Stripe — que é a autoridade sobre o que foi cobrado —
 * se esta corrida já tem gorjeta paga. Se tem, o conserto é gravar no banco o
 * que faltou, não cobrar de novo.
 *
 * Só `succeeded` conta. Um intent em `requires_payment_method` (recusado) ou
 * `canceled` é uma tentativa que NÃO tirou dinheiro de ninguém, e tratá-lo como
 * gorjeta paga bloquearia a gorjeta de novo — que é o defeito, não o conserto.
 */
export function acharGorjetaCobrada<T extends TipIntentLike>(
  intents: readonly T[],
  rideId: string,
): T | null {
  for (const pi of intents) {
    if (pi.status !== 'succeeded') continue;
    if (pi.metadata?.type !== 'tip') continue;
    if (pi.metadata?.rideId !== rideId) continue;
    return pi;
  }
  return null;
}

/** Erro traduzido para quem está com o telefone na mão. */
export interface TipFailure {
  message: string;
  status: number;
}

/** Formato mínimo de um erro da biblioteca do Stripe. */
interface StripeErrorLike {
  type?: string;
  code?: string;
  decline_code?: string;
  raw?: { type?: string; code?: string; decline_code?: string; message?: string };
  message?: string;
}

/**
 * Traduz o erro do Stripe para uma frase que o passageiro consegue agir.
 *
 * O que existia antes era `msg = e.raw?.message ?? e.message ?? String(e)` e ia
 * cru para o `Alert.alert` do app — em inglês, em vocabulário de engenharia de
 * pagamentos. "Keys for idempotent requests can only be used with the same
 * parameters they were originally used with" não diz a ninguém o que fazer.
 *
 * A mensagem técnica não some: quem a registra é o log da função. O que muda é
 * o que chega à tela.
 */
export function descreverFalhaDeGorjeta(e: unknown): TipFailure {
  const err = (e ?? {}) as StripeErrorLike;
  const code = err.code ?? err.raw?.code ?? '';
  const declinio = err.decline_code ?? err.raw?.decline_code ?? '';
  const tipo = err.type ?? err.raw?.type ?? '';

  if (tipo === 'idempotency_error' || code === 'idempotency_key_in_use') {
    // Não deveria mais acontecer com a chave por (corrida, valor), mas se
    // acontecer o passageiro precisa saber que é para esperar, não desistir.
    return { message: 'Sua gorjeta anterior ainda está sendo processada. Aguarde alguns segundos e tente de novo.', status: 409 };
  }

  if (code === 'authentication_required') {
    return { message: 'Seu banco pediu uma confirmação para esta cobrança. Abra o app do banco, autorize e tente de novo.', status: 400 };
  }

  if (declinio === 'insufficient_funds') {
    return { message: 'Não foi possível cobrar a gorjeta: saldo insuficiente no cartão.', status: 400 };
  }

  if (code === 'card_declined' || declinio) {
    return { message: 'Seu cartão recusou a cobrança da gorjeta. Tente outro cartão em Pagamento.', status: 400 };
  }

  if (code === 'expired_card') {
    return { message: 'O cartão salvo está vencido. Atualize-o em Pagamento e tente de novo.', status: 400 };
  }

  if (code === 'resource_missing') {
    // É o caso de campo mais comum hoje: `stripe_payment_method_id` aponta para
    // um método que não existe nesta conta Stripe (AUDITORIA, item F).
    return { message: 'A forma de pagamento salva não está mais válida. Cadastre-a de novo em Pagamento.', status: 400 };
  }

  return { message: 'Não foi possível processar a gorjeta agora. Tente de novo em instantes.', status: 500 };
}
