import { isAcceptableFix, GeoKalman, lowPass, MAX_ACCURACY_M } from '../filter';

describe('nav/filter — descarte de leituras ruins', () => {
  test('descarta accuracy acima do limite (25 m)', () => {
    expect(isAcceptableFix({ accuracy: 30, timestampMs: 100 }, null)).toBe(false);
  });
  test('aceita accuracy no limite e abaixo', () => {
    expect(isAcceptableFix({ accuracy: MAX_ACCURACY_M, timestampMs: 100 }, null)).toBe(true);
    expect(isAcceptableFix({ accuracy: 8, timestampMs: 100 }, null)).toBe(true);
  });
  test('aceita accuracy desconhecida (não pune quem não reporta)', () => {
    expect(isAcceptableFix({ timestampMs: 100 }, null)).toBe(true);
  });
  test('descarta timestamp fora de ordem ou duplicado', () => {
    expect(isAcceptableFix({ accuracy: 5, timestampMs: 100 }, 100)).toBe(false); // igual
    expect(isAcceptableFix({ accuracy: 5, timestampMs: 90 }, 100)).toBe(false); // mais antigo
    expect(isAcceptableFix({ accuracy: 5, timestampMs: 101 }, 100)).toBe(true); // mais novo
  });
});

describe('nav/filter — Kalman de posição', () => {
  test('primeira leitura inicializa e retorna a própria medição', () => {
    const k = new GeoKalman();
    expect(k.process(10, 20, 5, 1000)).toEqual({ lat: 10, lng: 20 });
    expect(k.getVariance()).toBeCloseTo(25, 6); // accuracy² = 5²
  });

  test('medições repetidas reduzem a variância (menos tremor)', () => {
    const k = new GeoKalman();
    k.process(10, 20, 5, 1000);
    const v1 = k.getVariance();
    k.process(10, 20, 5, 2000);
    const v2 = k.getVariance();
    expect(v2).toBeLessThan(v1);
  });

  test('suaviza: a saída fica entre a estimativa anterior e a medição', () => {
    const k = new GeoKalman();
    k.process(0, 0, 5, 0); // inicializa em (0,0)
    const out = k.process(10, 0, 5, 1000); // medição salta para lat 10
    expect(out.lat).toBeGreaterThan(0);
    expect(out.lat).toBeLessThan(10);
    expect(out.lng).toBeCloseTo(0, 6);
  });

  test('reset reancora o filtro numa nova posição', () => {
    const k = new GeoKalman();
    k.process(0, 0, 5, 0);
    k.reset(50, 60, 5, 5000);
    expect(k.process(50, 60, 5, 6000)).toEqual({ lat: 50, lng: 60 });
  });
});

describe('nav/filter — low-pass', () => {
  test('sem valor anterior devolve o próximo', () => {
    expect(lowPass(null, 5, 0.5)).toBe(5);
  });
  test('alpha 0.5 faz a média', () => {
    expect(lowPass(0, 10, 0.5)).toBe(5);
  });
  test('alpha clampado em [0,1]', () => {
    expect(lowPass(0, 10, 0)).toBe(0);
    expect(lowPass(0, 10, 1)).toBe(10);
    expect(lowPass(0, 10, 5)).toBe(10);
  });
});
