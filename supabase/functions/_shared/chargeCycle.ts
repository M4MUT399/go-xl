// Decisão PURA do CICLO DE COBRANÇA de uma corrida — sem I/O, sem globais do
// Deno (mesmo padrão de _shared/payout.ts e _shared/money.ts, então roda igual
// na Edge Function e no Jest do app).
//
// Duas perguntas moram aqui, e as duas são dinheiro:
//
//   1. qual chave de idempotência usar nesta cobrança;
//   2. o PaymentIntent que o Stripe devolveu representa dinheiro que ENTROU de
//      verdade, ou é o eco de uma cobrança que já foi estornada?
//
// ─────────────────────────────────────────────────────────────────────────────
// O BUG QUE ISTO CONSERTA
// ─────────────────────────────────────────────────────────────────────────────
// `charge-ride` usava `idempotencyKey: charge_<rideId>` — uma chave PERMANENTE
// por corrida. A chave de idempotência do Stripe não é "não cobre duas vezes":
// é "reproduza a RESPOSTA da primeira chamada". Então, depois de um estorno
// (refund-ride grava `paid = false` mas o PaymentIntent continua existindo),
// qualquer nova chamada de charge-ride para aquela corrida NÃO cobrava nada —
// recebia de volta o PaymentIntent ORIGINAL, já estornado, com
// `status === 'succeeded'`, e gravava `paid = true`. A corrida voltava a ser
// elegível a repasse lastreada por uma cobrança que já tinha sido devolvida ao
// passageiro: o motorista recebe 80-85% de dinheiro que a plataforma não tem.
//
// E não precisa de má-fé para chegar lá: useRide.ts:1909-1923 é uma rede de
// segurança que cobra na conclusão sempre que `paid` for falso. Um cancelamento
// do motorista estorna a corrida (DriverNavigateScreen.tsx:753) e, se a escrita
// seguinte de `status = 'cancelled'` falhar (o próprio call site mantém a
// corrida ativa nesse caso, :753-760), a viagem ainda pode ser concluída depois
// → rede de segurança → replay do intent estornado → `paid = true` com zero
// dólar cobrado.

/**
 * Chave de idempotência POR CICLO de cobrança.
 *
 * A proteção original continua de pé — duas chamadas paralelas para a mesma
 * corrida, no MESMO estado, derivam a MESMA chave e o Stripe só cria uma
 * cobrança. O que muda é que a chave deixa de ser eterna: ela carrega o
 * PaymentIntent que a corrida já tinha, então um novo ciclo (isto é, uma
 * cobrança DEPOIS de um estorno) nasce com chave diferente e vira cobrança
 * NOVA, de verdade, em vez de eco da antiga.
 *
 * Por que o primeiro ciclo mantém exatamente `charge_<rideId>`, sem sufixo:
 * corridas cobradas em produção nas últimas 24 h já gastaram essa chave no
 * Stripe. Se o primeiro ciclo passasse a usar outro texto, uma corrida cuja
 * cobrança saiu mas cuja gravação no banco falhou seria cobrada DE NOVO na
 * primeira retentativa. Preservar a chave antiga para `prior = null` mantém
 * essas corridas exatamente onde estavam.
 *
 * @param rideId id da corrida
 * @param priorIntentId `rides.stripe_payment_intent_id` ANTES desta cobrança
 */
export function chargeIdempotencyKey(rideId: string, priorIntentId?: string | null): string {
  const prior = (priorIntentId ?? '').trim();
  return prior ? `charge_${rideId}_after_${prior}` : `charge_${rideId}`;
}

/**
 * O erro de releitura é PERMANENTE (o intent não existe) ou TRANSITÓRIO?
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUE ESSA DISTINÇÃO É DINHEIRO
 * ─────────────────────────────────────────────────────────────────────────────
 * `charge-ride` relê o PaymentIntent anterior da corrida antes de criar uma
 * cobrança nova, e trata QUALQUER falha dessa releitura como "não dá para
 * conferir → 503, tente de novo". Para um erro de rede isso é exatamente certo:
 * seguir às cegas cobraria o passageiro duas vezes.
 *
 * Mas `resource_missing` (HTTP 404) não é uma falha de leitura: é uma RESPOSTA.
 * O Stripe está afirmando que aquele id não existe naquela conta — um id de
 * outro ambiente (teste em produção, ou o contrário), um intent apagado, um
 * backfill errado. Um erro permanente devolvido como 503 significa que TODA
 * retentativa falha do mesmo jeito, para sempre: a corrida nunca é cobrada,
 * nunca é concluída, e o passageiro fica preso numa viagem que não fecha. O 503
 * promete "tente de novo" para um erro que nunca vai mudar.
 *
 * Nesse caso o certo é o oposto do 503: não existe cobrança anterior para
 * proteger, então não existe risco de cobrar duas vezes — segue-se para uma
 * cobrança NOVA (que, por sinal, nasce com chave de idempotência distinta,
 * porque `chargeIdempotencyKey` carrega o id anterior no sufixo).
 *
 * A forma do erro do `npm:stripe` varia entre `e.code`, `e.raw.code` e
 * `e.statusCode`/`e.raw.statusCode` dependendo de como ele foi construído, e
 * nada disso é conferível a partir de um objeto de teste — por isso lemos os
 * três, e por isso isto é uma função pura, coberta por teste, em vez de um
 * `if` enterrado num `catch`.
 */
export function isMissingIntentError(e: unknown): boolean {
  const se = e as {
    code?: unknown;
    statusCode?: unknown;
    raw?: { code?: unknown; statusCode?: unknown } | null;
  } | null;
  if (!se || typeof se !== 'object') return false;

  const code = se.code ?? se.raw?.code ?? null;
  if (code === 'resource_missing') return true;

  const status = se.statusCode ?? se.raw?.statusCode ?? null;
  return status === 404;
}

/**
 * `resource_missing` é AMBÍGUO — e a ambiguidade custa uma cobrança em dobro.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * O QUE `isMissingIntentError` NÃO SABE
 * ─────────────────────────────────────────────────────────────────────────────
 * `isMissingIntentError` acima devolve `true` para `resource_missing` (ou 404), e
 * `charge-ride` tratava isso como "não existe cobrança anterior a proteger" e
 * seguia para uma cobrança NOVA. Mas o Stripe devolve exatamente o mesmo
 * `resource_missing` para um PaymentIntent que EXISTE e apenas não é visível
 * para a chave em uso: rotação de chave, chave de outra conta, troca de
 * live × test. O próprio comentário do call site nomeia "id de outro ambiente"
 * como causa provável — e nesse cenário o intent anterior está vivo e cobrado.
 *
 * Sob uma chave errada, TODA corrida com intent anterior cai neste ramo e cobra o
 * passageiro DE NOVO, uma atrás da outra. `needs_attention` depois disso é
 * detecção com o dinheiro já movido.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * O QUE DÁ PARA PROVAR LOCALMENTE, SEM UMA CHAMADA DE API
 * ─────────────────────────────────────────────────────────────────────────────
 * Duas coisas, e nenhuma delas depende de acreditar no Stripe:
 *
 *   • FORMA. Um PaymentIntent do Stripe é `pi_` + um identificador alfanumérico
 *     razoavelmente longo. Um valor que não tem essa forma — um `ch_...`, um
 *     `seti_...`, um UUID vindo de um backfill errado, uma string truncada —
 *     NUNCA foi um PaymentIntent, em conta NENHUMA. Aí não existe cobrança
 *     anterior a proteger, e seguir para uma cobrança nova é seguro.
 *
 *   • MODO. Ids do Stripe que carregam `_test_` no meio (`cs_test_`, `pi_test_`
 *     em fixtures/mocks) contra uma chave `sk_live_`/`rk_live_` — e o inverso —
 *     são um descasamento de ambiente PROVADO pelo texto, sem perguntar a
 *     ninguém.
 *     ATENÇÃO ao limite: PaymentIntents de teste REAIS não carregam marca alguma
 *     no id (é `pi_3...` nos dois modos). Então este critério pega só o
 *     subconjunto que se declara — nunca o caso geral de live × test. Ele
 *     ADICIONA certeza; não substitui a regra abaixo.
 *
 * Fora desses dois casos o veredito é AMBÍGUO, e ambíguo significa NÃO COBRAR:
 * o chamador devolve 503 e tenta de novo. Ficar preso num 503 é reversível
 * (basta corrigir a chave); cobrar o passageiro duas vezes não é.
 */
export type MissingIntentVerdict =
  | { provablyForeign: true; reason: 'malformed_id' | 'livemode_mismatch' }
  | { provablyForeign: false; reason: 'ambiguous' };

/** `pi_` + pelo menos 16 caracteres alfanuméricos (os reais têm bem mais). */
const PAYMENT_INTENT_ID = /^pi_[A-Za-z0-9]{16,}$/;

export function classifyMissingIntent(
  priorIntentId: string | null | undefined,
  stripeSecretKey: string | null | undefined,
): MissingIntentVerdict {
  const id  = (priorIntentId ?? '').trim();
  const key = (stripeSecretKey ?? '').trim();

  // Descasamento de modo DECLARADO no próprio texto do id.
  const idIsTest  = id.includes('_test_');
  const idIsLive  = id.includes('_live_');
  const keyIsTest = key.startsWith('sk_test_') || key.startsWith('rk_test_');
  const keyIsLive = key.startsWith('sk_live_') || key.startsWith('rk_live_');
  if ((idIsTest && keyIsLive) || (idIsLive && keyIsTest)) {
    return { provablyForeign: true, reason: 'livemode_mismatch' };
  }

  // Nunca foi um PaymentIntent, em conta nenhuma.
  if (!PAYMENT_INTENT_ID.test(id)) {
    return { provablyForeign: true, reason: 'malformed_id' };
  }

  // Id bem-formado que o Stripe diz não existir: pode ser um intent apagado —
  // ou um intent vivo numa conta que esta chave não enxerga. Indistinguível
  // daqui. Não se cobra em cima disso.
  return { provablyForeign: false, reason: 'ambiguous' };
}

/**
 * DISJUNTOR de `resource_missing` — o segundo já é padrão, e padrão é chave
 * errada, não corrida azarada.
 *
 * Um `resource_missing` isolado é plausível (um id sujo, um intent apagado à
 * mão). DOIS na mesma vida de isolate já não é: é a assinatura de uma chave
 * trocada, e é exatamente aí que a cobrança nova vira cobrança em dobro em
 * SÉRIE, passageiro atrás de passageiro.
 *
 * Isto é estado de MÓDULO na Edge Function, o que quer dizer que ele vive
 * enquanto o isolate viver e se perde quando o Deno o recicla. É o certo aqui:
 * o disjuntor existe para cortar a rajada, não para ser memória permanente — e
 * a memória permanente já existe, nas linhas de conciliação.
 *
 * Fábrica em vez de um contador solto: assim o teste consegue exercitar o
 * comportamento sem depender de ordem entre arquivos de teste.
 */
export interface MissingIntentBreaker {
  /** Contabiliza um `resource_missing`. Devolve `true` se o disjuntor ABRIU. */
  record(): boolean;
  /** Já abriu? (não contabiliza) */
  tripped(): boolean;
  /** Quantos `resource_missing` foram vistos. */
  count(): number;
}

export function createMissingIntentBreaker(limit = 1): MissingIntentBreaker {
  let seen = 0;
  return {
    record() {
      seen += 1;
      return seen > limit;
    },
    tripped() {
      return seen > limit;
    },
    count() {
      return seen;
    },
  };
}

/**
 * Forma mínima de um PaymentIntent relida do Stripe, já com `latest_charge`
 * expandida. Só os campos que decidem "entrou dinheiro?".
 */
export interface SettledIntentShape {
  id: string;
  status: string;
  /** Valor pedido, em centavos. */
  amount: number;
  /** Valor efetivamente recebido, em centavos. */
  amount_received?: number | null;
  latest_charge?: {
    refunded?: boolean | null;
    amount_refunded?: number | null;
    /** `true` quando a cobrança foi capturada de fato. */
    captured?: boolean | null;
    status?: string | null;
  } | null;
}

export type ChargeVerdict =
  | { collected: true }
  | { collected: false; code: 'not_succeeded' | 'refunded' | 'not_captured' | 'short_paid'; detail: string };

/**
 * O dinheiro está REALMENTE na plataforma?
 *
 * Isto existe porque a chave de idempotência sozinha não basta como garantia. A
 * chave é um cache do lado do Stripe e ele a descarta depois de ~24 h; e um
 * PaymentIntent também pode ter sido estornado por fora (painel do Stripe,
 * disputa, script). Então, antes de gravar `paid = true`, a Edge Function
 * RELÊ o intent (GET, que nunca é servido pelo cache de idempotência — só POST
 * com chave é) e passa o resultado por aqui.
 *
 * Estorno PARCIAL também reprova: `amount_refunded > 0` significa que a
 * cobrança não lastreia mais o `driver_amount` inteiro, e o repasse saca dessa
 * mesma cobrança via `source_transaction`.
 */
export function verifyChargeCollected(intent: SettledIntentShape): ChargeVerdict {
  if (intent.status !== 'succeeded') {
    return { collected: false, code: 'not_succeeded', detail: `status=${intent.status}` };
  }

  const charge = intent.latest_charge ?? null;
  if (charge) {
    const refunded = charge.refunded === true || (charge.amount_refunded ?? 0) > 0;
    if (refunded) {
      return {
        collected: false,
        code: 'refunded',
        detail: `charge estornada (amount_refunded=${charge.amount_refunded ?? 0})`,
      };
    }
    // `captured === false` é autorização sem captura: o dinheiro não entrou.
    // `undefined`/`null` (campo ausente) NÃO reprova — pode ser um objeto
    // parcial; quem decide nesse caso é amount_received, logo abaixo.
    if (charge.captured === false) {
      return { collected: false, code: 'not_captured', detail: 'charge não capturada' };
    }
  }

  const received = intent.amount_received ?? 0;
  if (received < intent.amount) {
    return {
      collected: false,
      code: 'short_paid',
      detail: `amount_received=${received} < amount=${intent.amount}`,
    };
  }

  return { collected: true };
}
