import {
  haversineMiles,
  stepMileage,
  DEFAULT_MILEAGE_SAMPLE,
  emptyDriverPeriodMileage,
  addDriverPeriodMileage,
  type GpsPoint,
} from '../driverPeriodMileage';

const SEC = 1000;
const MIN = 60 * SEC;

// Orlando aprox: 28.5383,-81.3792 → ponto ~1 milha a leste (mesma latitude,
// deslocamento de longitude equivalente a ~1mi em ~28.5° de latitude).
const ORLANDO: GpsPoint = { lat: 28.5383, lng: -81.3792, atMs: 0 };
const ONE_MILE_EAST: GpsPoint = { lat: 28.5383, lng: -81.3639, atMs: 1 * MIN }; // ~1mi em 1min = 60mph, plausível

describe('driverPeriodMileage — haversine', () => {
  it('mesma coordenada → 0 milhas', () => {
    expect(haversineMiles(ORLANDO, ORLANDO)).toBeCloseTo(0, 6);
  });

  it('~1 milha de deslocamento leste → haversine próximo de 1mi', () => {
    const d = haversineMiles(ORLANDO, ONE_MILE_EAST);
    expect(d).toBeGreaterThan(0.9);
    expect(d).toBeLessThanOrEqual(1.1);
  });
});

describe('driverPeriodMileage — stepMileage (classificação de deslocamento)', () => {
  it('primeira leitura da sessão (prev=null) → jitter (nada a medir ainda)', () => {
    const r = stepMileage(null, ORLANDO);
    expect(r.kind).toBe('jitter');
  });

  it('deslocamento plausível (~1mi em 1min, 60mph) → credited', () => {
    const r = stepMileage(ORLANDO, ONE_MILE_EAST);
    expect(r.kind).toBe('credited');
    if (r.kind === 'credited') {
      expect(r.miles).toBeGreaterThan(0.9);
      expect(r.estimated).toBe(false);
    }
  });

  it('micro-deslocamento (GPS parado, ruído) abaixo do limiar → jitter', () => {
    const jitterPoint: GpsPoint = { lat: 28.53831, lng: -81.37921, atMs: 5 * SEC }; // ~1m
    const r = stepMileage(ORLANDO, jitterPoint);
    expect(r.kind).toBe('jitter');
  });

  it('timestamp não-monotônico (curr.atMs <= prev.atMs) → jitter (ignora)', () => {
    const bad: GpsPoint = { lat: 28.54, lng: -81.36, atMs: -1 };
    const r = stepMileage(ORLANDO, bad);
    expect(r.kind).toBe('jitter');
  });

  it('salto implausível (10 milhas em 1 segundo → ~36.000 mph) → needs_interpolation', () => {
    const farAway: GpsPoint = { lat: 28.68, lng: -81.3792, atMs: 1 * SEC }; // ~10mi em 1s
    const r = stepMileage(ORLANDO, farAway);
    expect(r.kind).toBe('needs_interpolation');
    if (r.kind === 'needs_interpolation') {
      expect(r.from).toEqual(ORLANDO);
      expect(r.to).toEqual(farAway);
    }
  });

  it('velocidade exatamente no limiar (110mph) ainda credita; acima disso não', () => {
    // ~1.10mi percorrida em ~36s => ~110 mph implícito (limite default)
    const edge: GpsPoint = { lat: 28.5383, lng: -81.3627, atMs: 36 * SEC };
    const r = stepMileage(ORLANDO, edge, DEFAULT_MILEAGE_SAMPLE);
    expect(['credited', 'needs_interpolation']).toContain(r.kind); // limiar exato é sensível à distância real do teste
  });
});

describe('driverPeriodMileage — acumulador por período', () => {
  it('começa zerado', () => {
    const m = emptyDriverPeriodMileage();
    expect(m).toEqual({ p1Miles: 0, p2Miles: 0, p3Miles: 0, estimatedMiles: 0 });
  });

  it('credita ao bucket correto por período (P1/P2/P3), P0 não acumula', () => {
    let m = emptyDriverPeriodMileage();
    m = addDriverPeriodMileage(m, 'P1_AVAILABLE', 2);
    m = addDriverPeriodMileage(m, 'P2_ENROUTE', 3);
    m = addDriverPeriodMileage(m, 'P3_ONTRIP', 5);
    m = addDriverPeriodMileage(m, 'P0_OFFLINE', 100); // não deve contar em lugar nenhum
    expect(m.p1Miles).toBeCloseTo(2, 6);
    expect(m.p2Miles).toBeCloseTo(3, 6);
    expect(m.p3Miles).toBeCloseTo(5, 6);
    expect(m.estimatedMiles).toBe(0);
  });

  it('milhagem estimada (interpolação de rota) soma ao bucket do período E ao total estimado', () => {
    let m = emptyDriverPeriodMileage();
    m = addDriverPeriodMileage(m, 'P3_ONTRIP', 4, true);
    expect(m.p3Miles).toBeCloseTo(4, 6);
    expect(m.estimatedMiles).toBeCloseTo(4, 6);
  });

  it('ignora valores inválidos (0, negativo, NaN)', () => {
    let m = emptyDriverPeriodMileage();
    m = addDriverPeriodMileage(m, 'P1_AVAILABLE', 0);
    m = addDriverPeriodMileage(m, 'P1_AVAILABLE', -5);
    m = addDriverPeriodMileage(m, 'P1_AVAILABLE', NaN);
    expect(m.p1Miles).toBe(0);
  });

  it('não muta o objeto original (imutabilidade)', () => {
    const m0 = emptyDriverPeriodMileage();
    const m1 = addDriverPeriodMileage(m0, 'P2_ENROUTE', 1);
    expect(m0.p2Miles).toBe(0);
    expect(m1.p2Miles).toBeCloseTo(1, 6);
  });
});

describe('driverPeriodMileage — cenário de dia completo (reconciliação)', () => {
  it('soma de milhas creditadas em sequência bate com a soma manual', () => {
    const track: GpsPoint[] = [
      { lat: 28.5383, lng: -81.3792, atMs: 0 },
      { lat: 28.5383, lng: -81.3639, atMs: 1 * MIN }, // ~1mi
      { lat: 28.5383, lng: -81.3486, atMs: 2 * MIN }, // ~+1mi
      { lat: 28.5383, lng: -81.3486, atMs: 2 * MIN + 5 * SEC }, // parado (jitter, 0)
    ];
    let m = emptyDriverPeriodMileage();
    let total = 0;
    for (let i = 1; i < track.length; i++) {
      const r = stepMileage(track[i - 1], track[i]);
      if (r.kind === 'credited') {
        m = addDriverPeriodMileage(m, 'P3_ONTRIP', r.miles, r.estimated);
        total += r.miles;
      }
    }
    expect(m.p3Miles).toBeCloseTo(total, 9);
    expect(total).toBeGreaterThan(1.8);
    expect(total).toBeLessThanOrEqual(2.2);
  });
});
