// Testes das decisões da cobrança de gorjeta (_shared/tipCharge.ts).
//
// O que estes testes provam: a chave de idempotência SEPARA valores diferentes
// da mesma corrida (o defeito P2-5: a primeira tentativa trancava a corrida no
// valor que falhou), o reparador só reconhece gorjeta REALMENTE cobrada, e o
// erro que chega à tela deixa de ser texto de engenharia em inglês.
//
// O que estes testes NÃO provam: que o Stripe honra a chave, que
// `paymentIntents.list` devolve a página que contém a gorjeta procurada, ou que
// o UPDATE do banco grava. Isso só um Stripe de verdade e um Postgres de
// verdade provam — aqui provamos a decisão diante dessas respostas.

import {
  acharGorjetaCobrada,
  descreverFalhaDeGorjeta,
  tipIdempotencyKey,
  type TipIntentLike,
} from '../tipCharge';

const CORRIDA = '6acaf884-9e16-43a9-9ae9-5845cc7364d9';

function intent(over: Partial<TipIntentLike> = {}): TipIntentLike {
  return {
    id: 'pi_teste',
    status: 'succeeded',
    amount: 1000,
    metadata: { type: 'tip', rideId: CORRIDA },
    ...over,
  };
}

describe('tipIdempotencyKey', () => {
  it('repete a mesma chave para o mesmo par (corrida, valor)', () => {
    expect(tipIdempotencyKey(CORRIDA, 500)).toBe(tipIdempotencyKey(CORRIDA, 500));
  });

  // ESTE é o teste do defeito. Com a chave antiga (`tip_<rideId>`) as duas
  // chamadas abaixo davam a MESMA string, e o Stripe recusava a segunda com
  // `idempotency_error` — a corrida não aceitava mais gorjeta nenhuma depois de
  // uma tentativa recusada.
  it('separa valores diferentes da MESMA corrida', () => {
    expect(tipIdempotencyKey(CORRIDA, 500)).not.toBe(tipIdempotencyKey(CORRIDA, 1000));
  });

  it('separa corridas diferentes com o mesmo valor', () => {
    expect(tipIdempotencyKey('corrida-a', 500)).not.toBe(tipIdempotencyKey('corrida-b', 500));
  });
});

describe('acharGorjetaCobrada', () => {
  it('acha a gorjeta liquidada desta corrida', () => {
    const achada = acharGorjetaCobrada([intent({ id: 'pi_gorjeta' })], CORRIDA);
    expect(achada?.id).toBe('pi_gorjeta');
  });

  it('ignora a TARIFA da mesma corrida', () => {
    const tarifa = intent({ id: 'pi_tarifa', metadata: { type: 'fare', rideId: CORRIDA } });
    expect(acharGorjetaCobrada([tarifa], CORRIDA)).toBeNull();
  });

  it('ignora a gorjeta de OUTRA corrida', () => {
    const outra = intent({ metadata: { type: 'tip', rideId: 'outra-corrida' } });
    expect(acharGorjetaCobrada([outra], CORRIDA)).toBeNull();
  });

  // Uma tentativa recusada não tirou dinheiro de ninguém. Tratá-la como gorjeta
  // paga bloquearia a gorjeta de novo — que é o defeito, não o conserto.
  it.each(['requires_payment_method', 'canceled', 'processing', 'requires_action'])(
    'ignora intent em %s (nada foi cobrado)',
    (status) => {
      expect(acharGorjetaCobrada([intent({ status })], CORRIDA)).toBeNull();
    },
  );

  it('ignora intent sem metadata', () => {
    expect(acharGorjetaCobrada([intent({ metadata: null })], CORRIDA)).toBeNull();
  });

  it('devolve null numa lista vazia', () => {
    expect(acharGorjetaCobrada([], CORRIDA)).toBeNull();
  });

  it('escolhe a liquidada mesmo vindo depois de tentativas recusadas', () => {
    const lista = [
      intent({ id: 'pi_recusada', status: 'requires_payment_method' }),
      intent({ id: 'pi_ok' }),
    ];
    expect(acharGorjetaCobrada(lista, CORRIDA)?.id).toBe('pi_ok');
  });
});

describe('descreverFalhaDeGorjeta', () => {
  it('não vaza o texto de engenharia do Stripe para a tela', () => {
    const cru = 'Keys for idempotent requests can only be used with the same parameters they were originally used with.';
    const { message } = descreverFalhaDeGorjeta({ type: 'idempotency_error', message: cru });
    expect(message).not.toContain('idempotent');
    expect(message).toMatch(/aguarde/i);
  });

  it('explica cartão recusado', () => {
    const { message, status } = descreverFalhaDeGorjeta({ code: 'card_declined' });
    expect(message).toMatch(/recusou/i);
    expect(status).toBe(400);
  });

  it('explica saldo insuficiente', () => {
    const { message } = descreverFalhaDeGorjeta({ raw: { code: 'card_declined', decline_code: 'insufficient_funds' } });
    expect(message).toMatch(/saldo insuficiente/i);
  });

  // O caso de campo mais comum: `stripe_payment_method_id` aponta para um método
  // que não existe nesta conta Stripe (AUDITORIA, item F).
  it('explica forma de pagamento inexistente', () => {
    const { message } = descreverFalhaDeGorjeta({ code: 'resource_missing' });
    expect(message).toMatch(/não está mais válida/i);
  });

  it('cai num texto genérico — e nunca em string vazia — para erro desconhecido', () => {
    for (const e of [undefined, null, new Error('boom'), 'texto solto', {}]) {
      const { message } = descreverFalhaDeGorjeta(e);
      expect(message.trim().length).toBeGreaterThan(0);
    }
  });
});
