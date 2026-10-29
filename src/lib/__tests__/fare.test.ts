import {
  estimatePrice, waitFeeFor, fareAfterRouteChange, surgeForHour, orlandoHour,
  WAIT_FEE_PER_MINUTE,
} from '../fare';

const MIN = 60_000;

describe('estimatePrice (movida de useRide sem mudar a conta)', () => {
  it('mínimo efetivo ≈ $13,09', () => {
    expect(estimatePrice(0, 0, 1)).toBe(13.09);
  });
  it('10 mi em 20 min sem pico', () => {
    // (3 + 10*1.46 + 20*0.2 = 21.6) + 3 = 24.6 × 1.1 = 27.06
    expect(estimatePrice(10 / 0.621371, 20, 1)).toBe(27.06);
  });
});

describe('waitFeeFor — 5 min grátis, depois $0,75 por minuto cheio', () => {
  const t0 = Date.parse('2026-10-29T15:00:00Z');
  it('sem chegada marcada não cobra', () => {
    expect(waitFeeFor(null, t0)).toEqual({ minutes: 0, amount: 0 });
  });
  it('dentro da carência não cobra', () => {
    expect(waitFeeFor(t0, t0 + 5 * MIN)).toEqual({ minutes: 0, amount: 0 });
  });
  it('minuto incompleto não conta', () => {
    expect(waitFeeFor(t0, t0 + 5 * MIN + 59_000)).toEqual({ minutes: 0, amount: 0 });
  });
  it('9 min de espera = 4 min cobrados = $3,00', () => {
    expect(waitFeeFor(t0, t0 + 9 * MIN)).toEqual({ minutes: 4, amount: 4 * WAIT_FEE_PER_MINUTE });
  });
  it('teto de 60 min cobrados', () => {
    expect(waitFeeFor(t0, t0 + 300 * MIN)).toEqual({ minutes: 60, amount: 45 });
  });
  it('embarque antes da chegada (relógio torto) não cobra', () => {
    expect(waitFeeFor(t0, t0 - MIN)).toEqual({ minutes: 0, amount: 0 });
  });
});

describe('fareAfterRouteChange — aplica a DIFERENÇA da fórmula', () => {
  const quoted = { distanceKm: 16, durationMin: 20 };
  it('rota igual mantém a tarifa cobrada (mesmo que diferente da fórmula)', () => {
    expect(fareAfterRouteChange(30, quoted, quoted, 1)).toBe(30);
  });
  it('rota maior soma só o trecho a mais', () => {
    const next = { distanceKm: 24, durationMin: 30 };
    const delta = estimatePrice(24, 30, 1) - estimatePrice(16, 20, 1);
    expect(fareAfterRouteChange(30, quoted, next, 1)).toBeCloseTo(30 + delta, 2);
  });
  it('rota menor devolve, mas nunca abaixo do mínimo', () => {
    expect(fareAfterRouteChange(14, { distanceKm: 40, durationMin: 50 }, { distanceKm: 1, durationMin: 2 }, 1))
      .toBe(estimatePrice(0, 0, 1));
  });
});

describe('pico pelo relógio de Orlando', () => {
  it('tabela', () => {
    expect(surgeForHour(8)).toBe(1.3);
    expect(surgeForHour(18)).toBe(1.3);
    expect(surgeForHour(2)).toBe(1.2);
    expect(surgeForHour(12)).toBe(1);
  });
  it('12:30Z de 29/10 é 8h em Orlando (EDT)', () => {
    expect(orlandoHour('2026-10-29T12:30:00Z')).toBe(8);
  });
});
