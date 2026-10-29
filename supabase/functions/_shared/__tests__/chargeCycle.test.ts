import {
  chargeIdempotencyKey,
  verifyChargeCollected,
  isMissingIntentError,
  type SettledIntentShape,
} from '../chargeCycle';

// Os valores esperados aqui são LITERAIS escritos à mão. Nenhum teste recalcula
// a fórmula do código para depois conferir contra ela mesma — se a regra da
// chave mudar, estes testes têm de ser reescritos de propósito, não passar
// sozinhos.

describe('chargeIdempotencyKey — a chave é por CICLO, não eterna', () => {
  test('primeiro ciclo (corrida nunca cobrada) preserva EXATAMENTE a chave antiga', () => {
    // Isto não é estética: corridas cobradas em produção nas últimas 24 h já
    // gastaram `charge_<id>` no Stripe. Mudar o texto do primeiro ciclo faria
    // uma retentativa (cobrança feita, gravação no banco falhou) cobrar o
    // cartão DE NOVO.
    expect(chargeIdempotencyKey('ride-1')).toBe('charge_ride-1');
    expect(chargeIdempotencyKey('ride-1', null)).toBe('charge_ride-1');
    expect(chargeIdempotencyKey('ride-1', undefined)).toBe('charge_ride-1');
    expect(chargeIdempotencyKey('ride-1', '')).toBe('charge_ride-1');
    expect(chargeIdempotencyKey('ride-1', '   ')).toBe('charge_ride-1');
  });

  test('cobrança DEPOIS de um estorno nasce com chave diferente', () => {
    // O bug original: a chave eterna fazia o Stripe devolver o PaymentIntent já
    // estornado, com status succeeded, e a corrida voltava a paid = true sem um
    // centavo entrar.
    expect(chargeIdempotencyKey('ride-1', 'pi_ABC')).toBe('charge_ride-1_after_pi_ABC');
  });

  test('duas chamadas paralelas no MESMO estado derivam a MESMA chave', () => {
    // A proteção pela qual a chave foi criada continua de pé: o Stripe só cria
    // uma cobrança para as duas.
    expect(chargeIdempotencyKey('ride-9', 'pi_X')).toBe(chargeIdempotencyKey('ride-9', 'pi_X'));
    expect(chargeIdempotencyKey('ride-9')).toBe(chargeIdempotencyKey('ride-9'));
  });

  test('ciclos sucessivos (estorno → cobra → estorno → cobra) não colidem', () => {
    const c1 = chargeIdempotencyKey('r', null);
    const c2 = chargeIdempotencyKey('r', 'pi_1');
    const c3 = chargeIdempotencyKey('r', 'pi_2');
    expect(new Set([c1, c2, c3]).size).toBe(3);
  });

  test('corridas diferentes nunca compartilham chave', () => {
    expect(chargeIdempotencyKey('a', 'pi_1')).not.toBe(chargeIdempotencyKey('b', 'pi_1'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// verifyChargeCollected — a segunda camada: o dinheiro entrou MESMO?
// ─────────────────────────────────────────────────────────────────────────────
// A chave de idempotência é um cache do lado do Stripe, com TTL de ~24 h, e não
// sabe de estornos feitos por fora (painel, disputa, script). Estes casos são
// FORMAS de objeto do Stripe montadas à mão — nenhuma chamada de API foi feita.

const ok: SettledIntentShape = {
  id: 'pi_ok',
  status: 'succeeded',
  amount: 5000,
  amount_received: 5000,
  latest_charge: { refunded: false, amount_refunded: 0, captured: true, status: 'succeeded' },
};

describe('verifyChargeCollected — só aprova dinheiro que entrou', () => {
  test('cobrança capturada e integral → aprovada', () => {
    expect(verifyChargeCollected(ok)).toEqual({ collected: true });
  });

  test('intent que não sucedeu → not_succeeded', () => {
    const r = verifyChargeCollected({ ...ok, status: 'requires_payment_method' });
    expect(r.collected).toBe(false);
    if (!r.collected) {
      expect(r.code).toBe('not_succeeded');
      expect(r.detail).toBe('status=requires_payment_method');
    }
  });

  test('charge TOTALMENTE estornada → refunded (é o eco do bug da chave eterna)', () => {
    const r = verifyChargeCollected({
      ...ok,
      latest_charge: { refunded: true, amount_refunded: 5000, captured: true },
    });
    expect(r.collected).toBe(false);
    if (!r.collected) expect(r.code).toBe('refunded');
  });

  test('estorno PARCIAL também reprova', () => {
    // `refunded` fica false num estorno parcial; quem denuncia é amount_refunded.
    // Reprovar importa porque o repasse saca o transfer desta mesma cobrança via
    // source_transaction — ela precisa lastrear o driver_amount INTEIRO.
    const r = verifyChargeCollected({
      ...ok,
      latest_charge: { refunded: false, amount_refunded: 1, captured: true },
    });
    expect(r.collected).toBe(false);
    if (!r.collected) {
      expect(r.code).toBe('refunded');
      expect(r.detail).toBe('charge estornada (amount_refunded=1)');
    }
  });

  test('autorização sem captura → not_captured', () => {
    const r = verifyChargeCollected({
      ...ok,
      latest_charge: { refunded: false, amount_refunded: 0, captured: false },
    });
    expect(r.collected).toBe(false);
    if (!r.collected) expect(r.code).toBe('not_captured');
  });

  test('captured ausente NÃO reprova sozinho — quem decide é amount_received', () => {
    // Um objeto parcial (sem o campo) não pode ser tratado como "não capturada".
    expect(verifyChargeCollected({
      id: 'pi_x', status: 'succeeded', amount: 5000, amount_received: 5000,
      latest_charge: { refunded: false },
    })).toEqual({ collected: true });
  });

  test('recebeu menos do que pediu → short_paid', () => {
    const r = verifyChargeCollected({ ...ok, amount: 5000, amount_received: 4999 });
    expect(r.collected).toBe(false);
    if (!r.collected) {
      expect(r.code).toBe('short_paid');
      expect(r.detail).toBe('amount_received=4999 < amount=5000');
    }
  });

  test('amount_received ausente conta como zero e reprova', () => {
    const r = verifyChargeCollected({ id: 'pi_y', status: 'succeeded', amount: 5000 });
    expect(r.collected).toBe(false);
    if (!r.collected) {
      expect(r.code).toBe('short_paid');
      expect(r.detail).toBe('amount_received=0 < amount=5000');
    }
  });

  test('sem latest_charge, um intent íntegro ainda passa', () => {
    expect(verifyChargeCollected({
      id: 'pi_z', status: 'succeeded', amount: 100, amount_received: 100, latest_charge: null,
    })).toEqual({ collected: true });
  });

  test('estorno vence a checagem de valor (a ordem importa no diagnóstico)', () => {
    // Um intent estornado costuma manter amount_received cheio; se a checagem de
    // valor viesse antes, o motivo relatado seria o errado.
    const r = verifyChargeCollected({
      id: 'pi_w', status: 'succeeded', amount: 5000, amount_received: 5000,
      latest_charge: { refunded: true, amount_refunded: 5000, captured: true },
    });
    expect(r.collected).toBe(false);
    if (!r.collected) expect(r.code).toBe('refunded');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D3: erro PERMANENTE de leitura do PaymentIntent anterior ≠ erro TRANSITÓRIO
// ─────────────────────────────────────────────────────────────────────────────
// O buraco: `charge-ride` devolvia 503 `prior_intent_unreadable` para QUALQUER
// throw da releitura do intent anterior — inclusive `resource_missing`, que é
// permanente. Uma corrida cujo PaymentIntent antigo não existe mais (apagado no
// painel, criado em outro modo/conta, id de teste) NUNCA mais podia ser cobrada:
// toda tentativa batia no mesmo 503 e o 503 convida a retentar para sempre.
//
// A forma dos erros abaixo é a documentada pela biblioteca do Stripe (`code`
// e `statusCode`, com o par espelhado em `raw`). NÃO foi observada contra um
// Stripe de verdade neste ambiente — é leitura de documentação. O que estes
// testes provam é a nossa classificação diante dessas formas.

describe('isMissingIntentError — permanente vs. transitório', () => {
  test('resource_missing no topo é permanente', () => {
    expect(isMissingIntentError({ code: 'resource_missing', statusCode: 404 })).toBe(true);
  });

  test('resource_missing só dentro de raw também conta', () => {
    // Dependendo do caminho, a lib expõe o código só no erro cru.
    expect(isMissingIntentError({ raw: { code: 'resource_missing' } })).toBe(true);
  });

  test('404 sem código nomeado ainda é "não existe"', () => {
    expect(isMissingIntentError({ statusCode: 404 })).toBe(true);
    expect(isMissingIntentError({ raw: { statusCode: 404 } })).toBe(true);
  });

  test('falha de rede/instabilidade NÃO é permanente — 503 continua certo', () => {
    // Este é o lado que não pode regredir: tratar um timeout como "intent
    // inexistente" faria a função cobrar o cartão DE NOVO por cima de uma
    // cobrança que talvez exista.
    expect(isMissingIntentError(new Error('network timeout'))).toBe(false);
    expect(isMissingIntentError({ code: 'api_connection_error', statusCode: 500 })).toBe(false);
    expect(isMissingIntentError({ statusCode: 429, code: 'rate_limit' })).toBe(false);
    expect(isMissingIntentError({ statusCode: 503 })).toBe(false);
  });

  test('erro de autenticação/permissão NÃO vira cobrança nova', () => {
    expect(isMissingIntentError({ code: 'api_key_expired', statusCode: 401 })).toBe(false);
    expect(isMissingIntentError({ statusCode: 403 })).toBe(false);
  });

  test('valores degenerados não explodem nem passam por permanentes', () => {
    expect(isMissingIntentError(null)).toBe(false);
    expect(isMissingIntentError(undefined)).toBe(false);
    expect(isMissingIntentError('resource_missing')).toBe(false);
    expect(isMissingIntentError(404)).toBe(false);
    expect(isMissingIntentError({})).toBe(false);
  });

  test('404 em texto NÃO conta — só o campo numérico', () => {
    // Evita casar por acidente com uma mensagem que só menciona 404.
    expect(isMissingIntentError({ statusCode: '404' })).toBe(false);
    expect(isMissingIntentError({ message: 'HTTP 404' })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// `resource_missing` é AMBÍGUO — classifyMissingIntent / breaker
// ─────────────────────────────────────────────────────────────────────────────
// `isMissingIntentError` (acima) responde "o Stripe disse que sumiu". Isso NÃO
// é o mesmo que "nunca foi desta conta": o mesmo código sai quando o objeto
// existe e a chave em uso não enxerga (rotação, live × test, chave restrita).
// Seguir para uma cobrança nova nesse caso cobra o passageiro duas vezes.
//
// O que estes testes NÃO provam: que o Stripe devolve `resource_missing` nesses
// cenários (isso é documentação da Stripe, não código nosso), nem qual é o
// prefixo real de um intent de teste em produção. O limite está documentado no
// próprio módulo: um `pi_3...` legítimo não declara ambiente, então
// `livemode_mismatch` só pega o subconjunto auto-declarante.

import { classifyMissingIntent, createMissingIntentBreaker } from '../chargeCycle';

describe('classifyMissingIntent — só passa o que se desqualifica sozinho', () => {
  test('id bem-formado com chave live: AMBÍGUO (não move dinheiro)', () => {
    expect(
      classifyMissingIntent('pi_3Qw8ZxAbCdEfGhIj0K1L2M3N', 'sk_live_51Hxxxxxxxxxxxx'),
    ).toEqual({ provablyForeign: false, reason: 'ambiguous' });
  });

  test('id bem-formado com chave test: AMBÍGUO', () => {
    expect(
      classifyMissingIntent('pi_3Qw8ZxAbCdEfGhIj0K1L2M3N', 'sk_test_51Hxxxxxxxxxxxx'),
    ).toEqual({ provablyForeign: false, reason: 'ambiguous' });
  });

  test('id que DECLARA test contra chave live: provado estrangeiro', () => {
    expect(classifyMissingIntent('pi_3_test_AbCdEfGhIjKlMnOp', 'sk_live_51Hxxx')).toEqual({
      provablyForeign: true,
      reason: 'livemode_mismatch',
    });
  });

  test('id que DECLARA live contra chave test: provado estrangeiro', () => {
    expect(classifyMissingIntent('pi_3_live_AbCdEfGhIjKlMnOp', 'sk_test_51Hxxx')).toEqual({
      provablyForeign: true,
      reason: 'livemode_mismatch',
    });
  });

  test('chave restrita (rk_) também classifica ambiente', () => {
    expect(classifyMissingIntent('pi_3_test_AbCdEfGhIjKlMnOp', 'rk_live_51Hxxx').provablyForeign)
      .toBe(true);
    expect(classifyMissingIntent('pi_3_live_AbCdEfGhIjKlMnOp', 'rk_test_51Hxxx').provablyForeign)
      .toBe(true);
  });

  test('ambientes concordando: cai no formato, e o formato reprova o mesmo id', () => {
    // ATENÇÃO — o que este teste revela sobre o alcance REAL da verificação.
    //
    // Um id que DECLARA ambiente (`pi_3_test_...`) não tem a forma de um
    // PaymentIntent de verdade: o regex é `^pi_[A-Za-z0-9]{16,}$` e o `_` do
    // meio já o reprova. Logo, todo id que o `livemode_mismatch` pegaria, o
    // `malformed_id` também pegaria — os dois devolvem `provablyForeign: true`
    // e só o rótulo muda.
    //
    // Na prática, então, `provablyForeign` equivale a "o id não tem forma de
    // PaymentIntent". PaymentIntent REAL não carrega marca de ambiente:
    // `pi_3...` sai igual em teste e em produção. É por isso que o teste
    // seguinte é o CAMINHO NORMAL, e é por isso que o DISJUNTOR — e não esta
    // classificação — é o que segura a cobrança em série com chave trocada.
    // Não conte a este teste um mérito que ele não tem.
    expect(classifyMissingIntent('pi_3_test_AbCdEfGhIjKlMnOp', 'sk_test_51Hxxx')).toEqual({
      provablyForeign: true,
      reason: 'malformed_id',
    });
  });

  test('id REAL de PaymentIntent é ambíguo com QUALQUER chave — inclusive trocada', () => {
    // O caso que importa em produção: chave rotacionada, ids bem-formados. A
    // classificação não salva ninguém aqui, e é justamente por isso que o
    // desfecho passou a ser 503 em vez de cobrança nova.
    for (const key of ['sk_live_51Hxxx', 'sk_test_51Hxxx', 'rk_live_51Hxxx', '']) {
      expect(classifyMissingIntent('pi_3Qw8ZxAbCdEfGhIj0K1L2M3N', key).provablyForeign).toBe(false);
    }
  });

  test('id fora do formato de PaymentIntent: provado estrangeiro', () => {
    expect(classifyMissingIntent('ch_3Qw8ZxAbCdEfGhIj0K1L', 'sk_live_51Hxxx')).toEqual({
      provablyForeign: true,
      reason: 'malformed_id',
    });
    expect(classifyMissingIntent('lixo', 'sk_live_51Hxxx').reason).toBe('malformed_id');
    expect(classifyMissingIntent('pi_curto', 'sk_live_51Hxxx').reason).toBe('malformed_id');
    expect(classifyMissingIntent('', 'sk_live_51Hxxx').reason).toBe('malformed_id');
    expect(classifyMissingIntent(null, 'sk_live_51Hxxx').reason).toBe('malformed_id');
    expect(classifyMissingIntent(undefined, 'sk_live_51Hxxx').reason).toBe('malformed_id');
  });

  test('chave AUSENTE não inventa mismatch — id bom continua ambíguo', () => {
    // Sem saber o ambiente da chave, não há como provar discordância. Ambíguo
    // não move dinheiro, que é o desfecho seguro.
    expect(classifyMissingIntent('pi_3Qw8ZxAbCdEfGhIj0K1L2M3N', '')).toEqual({
      provablyForeign: false,
      reason: 'ambiguous',
    });
    expect(classifyMissingIntent('pi_3Qw8ZxAbCdEfGhIj0K1L2M3N', null).provablyForeign).toBe(false);
  });
});

describe('createMissingIntentBreaker — o padrão só aparece em série', () => {
  test('a primeira ocorrência NÃO abre o disjuntor', () => {
    const b = createMissingIntentBreaker(1);
    expect(b.tripped()).toBe(false);
    expect(b.record()).toBe(false);
    expect(b.tripped()).toBe(false);
    expect(b.count()).toBe(1);
  });

  test('a segunda abre, e não fecha sozinho', () => {
    const b = createMissingIntentBreaker(1);
    b.record();
    expect(b.record()).toBe(true);
    expect(b.tripped()).toBe(true);
    expect(b.count()).toBe(2);

    expect(b.record()).toBe(true);
    expect(b.tripped()).toBe(true);
    expect(b.count()).toBe(3);
  });

  test('cada disjuntor é independente (um isolate não contamina o outro)', () => {
    const a = createMissingIntentBreaker(1);
    const b = createMissingIntentBreaker(1);
    a.record();
    a.record();
    expect(a.tripped()).toBe(true);
    expect(b.tripped()).toBe(false);
    expect(b.count()).toBe(0);
  });

  test('limite configurável', () => {
    const b = createMissingIntentBreaker(3);
    expect(b.record()).toBe(false);
    expect(b.record()).toBe(false);
    expect(b.record()).toBe(false);
    expect(b.record()).toBe(true);
  });

  test('limite 0 abre na PRIMEIRA ocorrência', () => {
    const b = createMissingIntentBreaker(0);
    expect(b.record()).toBe(true);
  });
});
