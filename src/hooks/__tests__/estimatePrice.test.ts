/**
 * O PREÇO QUE O PASSAGEIRO VÊ.
 *
 * `estimatePrice` decide quanto se cobra por toda corrida do app e, até agora,
 * não tinha teste nenhum: a tarifa por milha era um número solto no meio de um
 * arquivo de 1.800 linhas. Trocar 1,21 por 1,46 não quebrava nada, e trocar por
 * 14,6 também não.
 *
 * Estes testes fixam a COMPOSIÇÃO, não só o resultado. Um teste que apenas
 * comparasse com um número mágico passaria a mentir junto com o código no dia
 * em que alguém mudasse duas constantes que se cancelam.
 */

jest.mock('../../lib/supabase', () => ({ supabase: { from: jest.fn(), channel: jest.fn(), removeChannel: jest.fn() } }));
jest.mock('../../lib/notifications', () => ({ dismissRideNotifications: () => {} }));
jest.mock('../../lib/routing', () => ({ getRoute: () => Promise.resolve(null) }));
jest.mock('../../lib/rideOfferEvents', () => ({ logRideOfferEvent: () => {} }));
jest.mock('../../lib/offerAlertManager', () => ({ offerAlertManager: { stopAll: () => {} } }));
jest.mock('../../lib/errorReporting', () => ({ reportError: () => {} }));
jest.mock('../useFeatureFlag', () => ({ useFeatureFlag: () => false }));

import { estimatePrice, estimateDuration } from '../useRide';
import { KM_TO_MILES } from '../../lib/format';

/** Reconstrói o preço a partir da regra escrita, para comparar com o código. */
function esperado(milhas: number, minutos: number, surge: number) {
  const BASE = 3.0, POR_MILHA = 1.46, POR_MIN = 0.2, MIN_METRADO = 8.9, BOOKING = 3.0, MARKUP = 1.1;
  const metrado = BASE + milhas * POR_MILHA + minutos * POR_MIN;
  const comSurge = Math.max(metrado * surge, MIN_METRADO);
  return Math.round((comSurge + BOOKING) * MARKUP * 100) / 100;
}

const KM = (milhas: number) => milhas / KM_TO_MILES;

describe('a composição do preço', () => {
  it.each([
    [1, 0, 1.0],
    [10, 20, 1.0],
    [13.6, 30, 1.0],
    [10, 20, 1.3],
    [5, 12, 1.2],
  ])('%s mi, %s min, surge %s bate com a regra escrita', (mi, min, surge) => {
    expect(estimatePrice(KM(mi), min, surge)).toBeCloseTo(esperado(mi, min, surge), 2);
  });
});

describe('o prêmio de milha da GoXL', () => {
  // A diferença entre duas distâncias isola a tarifa por milha: base, booking e
  // mínimo são constantes e se cancelam na subtração.
  //
  // A medição é feita sobre 100 MILHAS e dividida. Sobre uma milha só, o
  // arredondamento a centavos do final de `estimatePrice` domina o resultado e
  // a milha marginal aparece como $1,60 ou $1,61 conforme o trecho — ver o
  // teste de granularidade abaixo, que registra esse comportamento em vez de
  // escondê-lo.
  const porMilhaCobrada = (surge = 1.0) =>
    (estimatePrice(KM(110), 0, surge) - estimatePrice(KM(10), 0, surge)) / 100;

  it('em hora normal o passageiro paga $1,606 por milha', () => {
    // $1,46 de tarifa × 1,10 de markup.
    expect(porMilhaCobrada()).toBeCloseTo(1.46 * 1.1, 3);
  });

  it('o acréscimo sobre a Uber XL NÃO é $0,25 líquidos', () => {
    // É a consequência de pôr o prêmio na tarifa base: os 10% incidem sobre ele.
    expect(porMilhaCobrada() - 1.21 * 1.1).toBeCloseTo(0.275, 3);
  });

  it('no pico o acréscimo cresce junto com o surge', () => {
    expect(porMilhaCobrada(1.3) - 1.21 * 1.3 * 1.1).toBeCloseTo(0.3575, 3);
  });

  // Não é defeito, é consequência de cobrar em centavos. Fica escrito para que
  // ninguém "conserte" o arredondamento achando que a conta está errada.
  it('a milha marginal oscila um centavo por causa do arredondamento', () => {
    // A diferença sai em centavos, então é em centavos que ela se compara —
    // 1.60 subtraído em ponto flutuante vira 1.5999999999999979.
    const emCentavos = (mi: number) =>
      Math.round((estimatePrice(KM(mi + 1), 0, 1) - estimatePrice(KM(mi), 0, 1)) * 100);

    const marginais = [10, 11, 12, 13, 14].map(emCentavos);
    for (const c of marginais) expect(c).toBeGreaterThanOrEqual(160);
    for (const c of marginais) expect(c).toBeLessThanOrEqual(162);
    // E de fato oscila: não é sempre o mesmo centavo.
    expect(new Set(marginais).size).toBeGreaterThan(1);
  });
});

describe('o piso da tarifa', () => {
  it('corrida mínima não fica abaixo de $13,09', () => {
    // (mínimo metrado $8,90 + booking $3,00) × 1,10. É o valor que a
    // RequestRideScreen usa como MIN_PRICE_FALLBACK.
    expect(estimatePrice(0, 0, 1.0)).toBeCloseTo(13.09, 2);
    expect(estimatePrice(KM(0.1), 1, 1.0)).toBeCloseTo(13.09, 2);
  });

  it('o piso vale sobre a parte metrada, então o booking sempre entra', () => {
    expect(estimatePrice(0, 0, 1.0)).toBeGreaterThan(3.0 * 1.1);
  });
});

describe('o preço nunca é negativo nem quebrado', () => {
  it('distância negativa não vira desconto', () => {
    expect(estimatePrice(-100, 0, 1.0)).toBeGreaterThanOrEqual(0);
  });

  it('duração negativa é tratada como zero', () => {
    expect(estimatePrice(KM(10), -50, 1.0)).toBeCloseTo(estimatePrice(KM(10), 0, 1.0), 2);
  });

  it('sai sempre com dois decimais', () => {
    for (const mi of [1, 3.7, 13.6, 42.123]) {
      const p = estimatePrice(KM(mi), 17, 1.0);
      // `p * 100` não serve de comparação: 77,99 × 100 dá 7798.999999999999 em
      // ponto flutuante. O que interessa é que o valor não tem terceiro decimal.
      expect(Number(p.toFixed(2))).toBe(p);
    }
  });
});

describe('estimateDuration — o tempo quando não há rota', () => {
  it('usa 30 mph e arredonda para cima', () => {
    expect(estimateDuration(KM(30))).toBe(60);
    expect(estimateDuration(KM(15))).toBe(30);
  });

  it('nunca devolve zero para distância real', () => {
    expect(estimateDuration(KM(0.1))).toBeGreaterThan(0);
  });
});
