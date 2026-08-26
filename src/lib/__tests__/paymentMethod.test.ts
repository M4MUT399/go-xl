/**
 * A descrição da forma de pagamento na tela.
 *
 * O caso que originou o módulo é o primeiro teste: perfil com método salvo,
 * `type: 'link'`, `card_brand` e `card_last4` NULOS. A tela antiga renderizava
 * "CARTÃO •••• •••• •••• " e a passageira concluía que não tinha nada salvo —
 * quando tinha método anexado, padrão e cobrável.
 *
 * O que estes testes protegem, e que não é óbvio: a função NUNCA pode devolver
 * string vazia nem inventar "cartão" quando não sabe. Foi supor cartão que
 * produziu o defeito.
 */

import {
  descreverFormaDePagamento,
  eCartao,
  temFormaDePagamento,
} from '../paymentMethod';

const PM = 'pm_1U6YoaCgSu88OSlV4eBBmGGI';

describe('o caso da corrida f28f2887', () => {
  const jennifer = {
    stripe_payment_method_id: PM,
    payment_method_type: 'link',
    payment_method_label: 'Link · jennifer@exemplo.com',
    card_brand: null,
    card_last4: null,
  };

  it('reconhece que existe forma de pagamento', () => {
    expect(temFormaDePagamento(jennifer)).toBe(true);
  });

  it('NÃO diz que é cartão', () => {
    expect(eCartao(jennifer)).toBe(false);
  });

  it('mostra o Link com o e-mail, não um cartão em branco', () => {
    expect(descreverFormaDePagamento(jennifer)).toBe('Link · jennifer@exemplo.com');
  });
});

describe('cartão', () => {
  it('usa o rótulo do servidor quando existe', () => {
    expect(descreverFormaDePagamento({
      stripe_payment_method_id: PM,
      payment_method_type: 'card',
      payment_method_label: 'visa •••• 4242',
    })).toBe('visa •••• 4242');
  });

  it('reconstrói do jeito antigo quando o rótulo não veio', () => {
    expect(descreverFormaDePagamento({
      stripe_payment_method_id: PM,
      card_brand: 'visa',
      card_last4: '4242',
    })).toBe('Visa •••• 4242');
  });

  it('mantém marca desconhecida em maiúsculas em vez de descartá-la', () => {
    expect(descreverFormaDePagamento({
      stripe_payment_method_id: PM,
      card_brand: 'elo',
      card_last4: '1234',
    })).toBe('ELO •••• 1234');
  });

  it('sem marca, ainda mostra os últimos quatro', () => {
    expect(descreverFormaDePagamento({
      stripe_payment_method_id: PM,
      card_last4: '4242',
    })).toBe('Cartão •••• 4242');
  });
});

describe('perfil ANTIGO, de antes da 0078', () => {
  // Produção só ganha as colunas novas depois da migration, e perfis já
  // existentes ficam com elas nulas. A tela não pode piorar nesse intervalo.
  it('cartão antigo continua legível', () => {
    expect(descreverFormaDePagamento({
      stripe_payment_method_id: PM,
      card_brand: 'mastercard',
      card_last4: '5555',
      payment_method_type: null,
      payment_method_label: null,
    })).toBe('Mastercard •••• 5555');
  });

  it('Link antigo (sem tipo, sem rótulo, sem cartão) não vira cartão em branco', () => {
    const r = descreverFormaDePagamento({
      stripe_payment_method_id: PM,
      card_brand: null,
      card_last4: null,
      payment_method_type: null,
      payment_method_label: null,
    });
    expect(r).toBe('Forma de pagamento salva');
    expect(r).not.toMatch(/••••/);
    expect(r.trim()).not.toBe('');
  });

  it('e o eCartao não chuta que é cartão', () => {
    expect(eCartao({ stripe_payment_method_id: PM })).toBe(false);
  });
});

describe('sem forma de pagamento', () => {
  it.each([
    ['perfil nulo', null],
    ['perfil vazio', {}],
    ['sem payment_method_id, mesmo com sobra de cartão', { card_brand: 'visa', card_last4: '4242' }],
  ])('%s', (_nome, p) => {
    expect(temFormaDePagamento(p)).toBe(false);
    expect(descreverFormaDePagamento(p)).toBe('Nenhuma forma de pagamento');
  });
});

describe('invariantes que não podem cair', () => {
  const casos = [
    { stripe_payment_method_id: PM },
    { stripe_payment_method_id: PM, payment_method_type: 'link' },
    { stripe_payment_method_id: PM, payment_method_type: 'us_bank_account' },
    { stripe_payment_method_id: PM, payment_method_label: '   ' },
    { stripe_payment_method_id: PM, card_brand: 'visa' },
    { stripe_payment_method_id: PM, card_last4: '' },
  ];

  it.each(casos.map((c, i) => [i, c]))('caso %i nunca devolve texto vazio', (_i, p) => {
    expect(descreverFormaDePagamento(p).trim().length).toBeGreaterThan(0);
  });

  it.each(casos.map((c, i) => [i, c]))('caso %i nunca finge cartão sem ter os 4 dígitos', (_i, p) => {
    const r = descreverFormaDePagamento(p);
    if (r.includes('••••')) {
      expect(r).toMatch(/•••• \S+$/);
    }
  });

  it('rótulo só com espaços cai para o próximo critério, não vira linha em branco', () => {
    expect(descreverFormaDePagamento({
      stripe_payment_method_id: PM,
      payment_method_label: '   ',
      card_brand: 'visa',
      card_last4: '4242',
    })).toBe('Visa •••• 4242');
  });
});
