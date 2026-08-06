import {
  makeEtaBaseline,
  projectEtaSeconds,
  etaSecondsToMinutes,
  arrivalDate,
} from '../etaTracker';

const T0 = 1_700_000_000_000; // epoch fixo (ms) para determinismo

describe('makeEtaBaseline', () => {
  it('converte ETA em minutos para baseline em segundos', () => {
    expect(makeEtaBaseline(7, T0)).toEqual({ seconds: 420, atMs: T0 });
  });

  it('retorna null para ETA ausente/inválido', () => {
    expect(makeEtaBaseline(null, T0)).toBeNull();
    expect(makeEtaBaseline(undefined, T0)).toBeNull();
    expect(makeEtaBaseline(Number.NaN, T0)).toBeNull();
    expect(makeEtaBaseline(-1, T0)).toBeNull();
  });
});

describe('projectEtaSeconds', () => {
  it('decrementa pelo tempo real decorrido quando andando', () => {
    const b = makeEtaBaseline(7, T0)!; // 420 s
    expect(projectEtaSeconds(b, T0)).toBe(420);
    expect(projectEtaSeconds(b, T0 + 60_000)).toBe(360); // 1 min depois
    expect(projectEtaSeconds(b, T0 + 120_000)).toBe(300);
  });

  it('CONGELA o decremento quando parado (B3: trânsito parado)', () => {
    const b = makeEtaBaseline(7, T0)!;
    expect(projectEtaSeconds(b, T0 + 120_000, { stopped: true })).toBe(420);
  });

  it('nunca fica negativo', () => {
    const b = makeEtaBaseline(1, T0)!; // 60 s
    expect(projectEtaSeconds(b, T0 + 120_000)).toBe(0);
  });

  it('clock skew (now < baseline) devolve a baseline cheia', () => {
    const b = makeEtaBaseline(5, T0)!; // 300 s
    expect(projectEtaSeconds(b, T0 - 10_000)).toBe(300);
  });

  it('sem baseline → null', () => {
    expect(projectEtaSeconds(null, T0)).toBeNull();
  });
});

describe('etaSecondsToMinutes', () => {
  it('arredonda para cima, mínimo 1 enquanto houver tempo', () => {
    expect(etaSecondsToMinutes(420)).toBe(7);
    expect(etaSecondsToMinutes(61)).toBe(2);
    expect(etaSecondsToMinutes(1)).toBe(1);
  });

  it('0 s → 0 (chegou)', () => {
    expect(etaSecondsToMinutes(0)).toBe(0);
  });

  it('null → null', () => {
    expect(etaSecondsToMinutes(null)).toBeNull();
  });
});

describe('arrivalDate', () => {
  it('agora + ETA restante', () => {
    const d = arrivalDate(T0, 420);
    expect(d!.getTime()).toBe(T0 + 420_000);
  });

  it('null sem ETA', () => {
    expect(arrivalDate(T0, null)).toBeNull();
  });
});
