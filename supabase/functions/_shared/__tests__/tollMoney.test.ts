import { moneyParaDolares, pedagioEmUSD, type GoogleMoney } from '../tollMoney';

/**
 * O pedágio vai INTEIRO para o motorista (ver src/lib/split.ts), e sai do bolso
 * do passageiro. Um erro de leitura aqui não aparece como exceção: aparece como
 * cobrança errada num recibo, dias depois, e vira reclamação.
 *
 * Os valores abaixo são os do exemplo oficial da Routes API (US$ 4,40 = units
 * "4" + nanos 400000000) e casos que já morderam integrações de Money antes.
 */

describe('moneyParaDolares', () => {
  it('o exemplo oficial da Google: units 4 + nanos 400000000 = 4,40', () => {
    expect(moneyParaDolares({ currencyCode: 'USD', units: '4', nanos: 400000000 })).toBe(4.4);
  });

  // Se alguém ler nanos como centavos, 4,40 vira 4.000.000,00.
  it('nanos são bilionésimos, não centavos', () => {
    expect(moneyParaDolares({ units: '0', nanos: 500000000 })).toBe(0.5);
    expect(moneyParaDolares({ units: '0', nanos: 990000000 })).toBe(0.99);
    expect(moneyParaDolares({ units: '0', nanos: 10000000 })).toBe(0.01);
  });

  it('units é string e precisa ser convertida', () => {
    expect(moneyParaDolares({ units: '12' })).toBe(12);
    // int64 grande: o valor absurdo tem de sair como número, para o teto da
    // 0065 barrá-lo, e não como concatenação de texto.
    expect(moneyParaDolares({ units: '9007199254740' })).toBe(9007199254740);
  });

  it('campos ausentes valem zero', () => {
    expect(moneyParaDolares({})).toBe(0);
    expect(moneyParaDolares({ units: undefined, nanos: undefined })).toBe(0);
  });

  it('lixo não vira valor', () => {
    expect(moneyParaDolares({ units: 'abc' })).toBe(0);
    expect(moneyParaDolares({ nanos: NaN })).toBe(0);
  });

  it('arredonda a centavos', () => {
    expect(moneyParaDolares({ units: '1', nanos: 555000000 })).toBe(1.56);
    expect(moneyParaDolares({ units: '1', nanos: 554000000 })).toBe(1.55);
  });
});

describe('pedagioEmUSD', () => {
  it('soma o item em dólar', () => {
    expect(pedagioEmUSD([{ currencyCode: 'USD', units: '6', nanos: 250000000 }])).toBe(6.25);
  });

  it('sem currencyCode assume dólar', () => {
    expect(pedagioEmUSD([{ units: '3' }])).toBe(3);
  });

  // A lista traz UM ITEM POR MOEDA. Somar tudo daria um número sem significado.
  it('ignora moeda estrangeira e soma só o dólar', () => {
    const preco: GoogleMoney[] = [
      { currencyCode: 'USD', units: '4', nanos: 400000000 },
      { currencyCode: 'MXN', units: '250' },
    ];
    expect(pedagioEmUSD(preco)).toBe(4.4);
  });

  // A distinção que evita cobrar de menos sem ninguém perceber.
  it('sem item em dólar devolve NULO, não zero', () => {
    expect(pedagioEmUSD([{ currencyCode: 'MXN', units: '250' }])).toBeNull();
  });

  it('lista vazia ou ausente devolve nulo', () => {
    expect(pedagioEmUSD([])).toBeNull();
    expect(pedagioEmUSD(undefined)).toBeNull();
    expect(pedagioEmUSD(null)).toBeNull();
  });

  it('não devolve negativo', () => {
    expect(pedagioEmUSD([{ units: '-5' }])).toBe(0);
  });

  it('vários itens em dólar são somados', () => {
    expect(pedagioEmUSD([
      { currencyCode: 'USD', units: '2', nanos: 500000000 },
      { currencyCode: 'USD', units: '1', nanos: 250000000 },
    ])).toBe(3.75);
  });
});
