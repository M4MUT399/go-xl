import {
  zoomForSpeed,
  headingForMotion,
  updateOffRoute,
  initialOffRouteState,
  SLOW_ZOOM,
  FAST_ZOOM,
  BASE_ZOOM,
} from '../follow';

const kmhToMps = (kmh: number): number => kmh / 3.6;

describe('nav/follow — zoom dinâmico por velocidade', () => {
  test('parado ou lento (≤ 30 km/h) aproxima para 18.5', () => {
    expect(zoomForSpeed(0)).toBe(SLOW_ZOOM);
    expect(zoomForSpeed(kmhToMps(30))).toBe(SLOW_ZOOM);
    expect(zoomForSpeed(-5)).toBe(SLOW_ZOOM); // velocidade inválida = parado
  });
  test('rodovia (≥ 80 km/h) afasta para 16.5', () => {
    expect(zoomForSpeed(kmhToMps(80))).toBe(FAST_ZOOM);
    expect(zoomForSpeed(kmhToMps(120))).toBe(FAST_ZOOM);
  });
  test('velocidade intermediária (~55 km/h) fica no base ~17.5', () => {
    expect(zoomForSpeed(kmhToMps(55))).toBeCloseTo(BASE_ZOOM, 2);
  });
  test('nula/indefinida = parado', () => {
    expect(zoomForSpeed(null)).toBe(SLOW_ZOOM);
    expect(zoomForSpeed(undefined)).toBe(SLOW_ZOOM);
  });
});

describe('nav/follow — heading de navegação (congela parado)', () => {
  test('movendo com curso válido usa o curso do GPS', () => {
    expect(headingForMotion({ speedMps: 5, course: 90, lastHeading: 0 })).toBe(90);
  });
  test('parado/lento congela o último heading', () => {
    expect(headingForMotion({ speedMps: 1, course: 90, lastHeading: 45 })).toBe(45);
    expect(headingForMotion({ speedMps: 0, course: 90, lastHeading: 33 })).toBe(33);
  });
  test('curso inválido (negativo) congela o último heading', () => {
    expect(headingForMotion({ speedMps: 10, course: -1, lastHeading: 200 })).toBe(200);
  });
  test('velocidade ausente é tratada como parado', () => {
    expect(headingForMotion({ speedMps: null, course: 90, lastHeading: 12 })).toBe(12);
  });
  test('normaliza o curso para [0,360)', () => {
    expect(headingForMotion({ speedMps: 10, course: 370, lastHeading: 0 })).toBe(10);
  });
});

describe('nav/follow — re-rota por desvio contínuo', () => {
  test('dentro do corredor (≤ 40 m) não dispara e zera o cronômetro', () => {
    const r = updateOffRoute({ since: 1000 }, 20, 5000);
    expect(r.reroute).toBe(false);
    expect(r.state.since).toBeNull();
  });

  test('fora da rota começa a contar mas ainda não dispara', () => {
    const r = updateOffRoute(initialOffRouteState, 50, 1000);
    expect(r.reroute).toBe(false);
    expect(r.state.since).toBe(1000);
  });

  test('fora por menos de 5 s não dispara', () => {
    const r = updateOffRoute({ since: 1000 }, 50, 1000 + 4999);
    expect(r.reroute).toBe(false);
    expect(r.state.since).toBe(1000);
  });

  test('fora por 5 s contínuos dispara UMA vez e reseta', () => {
    const r = updateOffRoute({ since: 1000 }, 60, 1000 + 5000);
    expect(r.reroute).toBe(true);
    expect(r.state.since).toBeNull();
  });

  test('voltar para a rota reseta o cronômetro mesmo após muito tempo fora', () => {
    const r = updateOffRoute({ since: 1000 }, 10, 999999);
    expect(r.reroute).toBe(false);
    expect(r.state.since).toBeNull();
  });
});
