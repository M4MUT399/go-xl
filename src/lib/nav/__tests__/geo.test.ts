import {
  normalizeDeg,
  shortestAngleDelta,
  lerpAngle,
  circularMean,
  haversineMeters,
  bearingBetween,
  sphericalInterpolate,
  nearestPointOnPath,
  splitPathAtSnap,
} from '../geo';

describe('nav/geo — ângulos', () => {
  test('normalizeDeg mantém em [0,360)', () => {
    expect(normalizeDeg(0)).toBe(0);
    expect(normalizeDeg(360)).toBe(0);
    expect(normalizeDeg(-10)).toBe(350);
    expect(normalizeDeg(730)).toBe(10);
  });

  describe('shortestAngleDelta — cruzamento 359°→1°', () => {
    test('359 → 1 é +2 (não -358)', () => {
      expect(shortestAngleDelta(359, 1)).toBe(2);
    });
    test('1 → 359 é -2 (não +358)', () => {
      expect(shortestAngleDelta(1, 359)).toBe(-2);
    });
    test('90 → 270 escolhe um lado consistente (±180)', () => {
      expect(Math.abs(shortestAngleDelta(90, 270))).toBe(180);
    });
    test('sem diferença = 0', () => {
      expect(shortestAngleDelta(42, 42)).toBe(0);
    });
  });

  describe('lerpAngle — interpola pelo caminho mais curto', () => {
    test('350 → 10 no meio passa por 0, não por 180', () => {
      expect(lerpAngle(350, 10, 0.5)).toBeCloseTo(0, 6);
    });
    test('t=0 devolve a origem, t=1 devolve o destino', () => {
      expect(lerpAngle(350, 10, 0)).toBeCloseTo(350, 6);
      expect(lerpAngle(350, 10, 1)).toBeCloseTo(10, 6);
    });
  });

  describe('circularMean — média circular de rumos', () => {
    test('média de 0 e 90 é 45', () => {
      expect(circularMean([0, 90])).toBeCloseTo(45, 6);
    });
    test('média de 350 e 10 é ~0 (respeita o wrap)', () => {
      expect(Math.abs(shortestAngleDelta(circularMean([350, 10]), 0))).toBeLessThan(1e-6);
    });
    test('lista vazia = 0', () => {
      expect(circularMean([])).toBe(0);
    });
  });
});

describe('nav/geo — distância e rumo', () => {
  test('haversine: 1° de longitude no equador ≈ 111.195 km', () => {
    expect(haversineMeters({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(111194.9, 0);
  });

  test('bearing: para o norte = 0, para o leste = 90', () => {
    expect(bearingBetween({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(0, 4);
    expect(bearingBetween({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBeCloseTo(90, 4);
  });
});

describe('nav/geo — interpolação esférica de posição', () => {
  test('t=0 e t=1 devolvem os extremos', () => {
    const a = { lat: 10, lng: 20 };
    const b = { lat: 11, lng: 21 };
    expect(sphericalInterpolate(a, b, 0)).toEqual(a);
    expect(sphericalInterpolate(a, b, 1)).toEqual(b);
  });

  test('meio do caminho no equador é o ponto médio exato', () => {
    const mid = sphericalInterpolate({ lat: 0, lng: 0 }, { lat: 0, lng: 10 }, 0.5);
    expect(mid.lat).toBeCloseTo(0, 6);
    expect(mid.lng).toBeCloseTo(5, 6);
  });

  test('não salta: passo curto fica entre origem e destino', () => {
    const p = sphericalInterpolate({ lat: 40, lng: -74 }, { lat: 40.001, lng: -74.001 }, 0.3);
    expect(p.lat).toBeGreaterThan(40);
    expect(p.lat).toBeLessThan(40.001);
    expect(p.lng).toBeLessThan(-74);
    expect(p.lng).toBeGreaterThan(-74.001);
  });
});

describe('nav/geo — snap na rota', () => {
  const path = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 1 },
  ];

  test('projeta o ponto no segmento e mede o desvio perpendicular', () => {
    const snap = nearestPointOnPath({ lat: 0.001, lng: 0.5 }, path)!;
    expect(snap.index).toBe(0);
    expect(snap.snapped.lat).toBeCloseTo(0, 6);
    expect(snap.snapped.lng).toBeCloseTo(0.5, 6);
    expect(snap.t).toBeCloseTo(0.5, 3);
    expect(snap.distanceM).toBeCloseTo(111.1, 0); // 0.001° de latitude
  });

  test('rota vazia → null', () => {
    expect(nearestPointOnPath({ lat: 0, lng: 0 }, [])).toBeNull();
  });

  test('splitPathAtSnap separa percorrido e restante sem buraco', () => {
    const p3 = [
      { lat: 0, lng: 0 },
      { lat: 0, lng: 1 },
      { lat: 0, lng: 2 },
    ];
    const snap = nearestPointOnPath({ lat: 0, lng: 0.5 }, p3)!;
    const { traveled, remaining } = splitPathAtSnap(p3, snap);
    // ponto de junção é o mesmo nos dois traçados
    expect(traveled[traveled.length - 1]).toEqual(remaining[0]);
    expect(traveled[0]).toEqual(p3[0]);
    expect(remaining[remaining.length - 1]).toEqual(p3[2]);
  });
});
