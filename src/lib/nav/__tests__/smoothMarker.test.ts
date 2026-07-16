import { destinationPoint, haversineMeters, bearingBetween } from '../geo';
import {
  DEFAULT_SMOOTH,
  continuousHeading,
  deadReckon,
  inferHeading,
  interpolationDuration,
  resolveTarget,
  type MarkerFix,
} from '../smoothMarker';

describe('destinationPoint (geo)', () => {
  it('projeta a distância pedida no rumo pedido (ida e volta consistente)', () => {
    const from = { lat: 28.5383, lng: -81.3792 };
    const p = destinationPoint(from, 90, 1000); // 1 km a leste
    expect(haversineMeters(from, p)).toBeCloseTo(1000, 0);
    expect(bearingBetween(from, p)).toBeCloseTo(90, 1);
  });
  it('distância <= 0 devolve o próprio ponto', () => {
    const from = { lat: 10, lng: 20 };
    expect(destinationPoint(from, 45, 0)).toEqual(from);
    expect(destinationPoint(from, 45, -5)).toEqual(from);
  });
});

describe('interpolationDuration', () => {
  it('primeiro fix (sem anterior) → 0 (crava, sem glide)', () => {
    expect(interpolationDuration(null, 1000)).toBe(0);
  });
  it('usa o intervalo entre fixes, clampado à faixa', () => {
    expect(interpolationDuration(0, 1000)).toBe(1000);
    expect(interpolationDuration(0, 200)).toBe(DEFAULT_SMOOTH.minInterpolateMs); // piso
    expect(interpolationDuration(0, 9000)).toBe(DEFAULT_SMOOTH.maxInterpolateMs); // teto
  });
});

describe('resolveTarget (snap-na-rota)', () => {
  // rota reta leste→oeste na latitude de Orlando
  const route = [
    { lat: 28.54, lng: -81.40 },
    { lat: 28.54, lng: -81.36 },
  ];
  it('sem rota → devolve o fix cru', () => {
    expect(resolveTarget({ lat: 28.5399, lng: -81.38 }, null)).toEqual({ lat: 28.5399, lng: -81.38 });
  });
  it('fix perto da via (poucos metros) → cola na rota (mesma lng, lat da via)', () => {
    const r = resolveTarget({ lat: 28.5401, lng: -81.38 }, route); // ~11 m ao norte
    expect(r.lat).toBeCloseTo(28.54, 4);
    expect(r.lng).toBeCloseTo(-81.38, 4);
  });
  it('fix longe da via (além de snapMaxMeters) → NÃO cola, usa o cru', () => {
    const far = { lat: 28.55, lng: -81.38 }; // ~1.1 km ao norte
    expect(resolveTarget(far, route)).toEqual(far);
  });
});

describe('deadReckon', () => {
  const base: MarkerFix = { lat: 28.54, lng: -81.38, heading: 90, speedMps: 10, timestampMs: 0 };
  it('projeta à frente pelo rumo/velocidade dentro da janela', () => {
    const p = deadReckon(base, 1000); // 1 s a 10 m/s = ~10 m a leste
    expect(haversineMeters({ lat: base.lat, lng: base.lng }, p)).toBeCloseTo(10, 0);
    expect(bearingBetween({ lat: base.lat, lng: base.lng }, p)).toBeCloseTo(90, 1);
  });
  it('limita a projeção a deadReckonMaxMs (não inventa posição além de 3 s)', () => {
    const capped = deadReckon(base, 10_000); // pediu 10 s → limita a 3 s
    const at3s = deadReckon(base, DEFAULT_SMOOTH.deadReckonMaxMs);
    expect(capped).toEqual(at3s);
    expect(haversineMeters({ lat: base.lat, lng: base.lng }, capped)).toBeCloseTo(30, 0);
  });
  it('parado (velocidade baixa) → não projeta', () => {
    const still = { ...base, speedMps: 0.5 };
    expect(deadReckon(still, 3000)).toEqual({ lat: base.lat, lng: base.lng });
  });
  it('sem rumo → não projeta', () => {
    const noHeading = { ...base, heading: null };
    expect(deadReckon(noHeading, 3000)).toEqual({ lat: base.lat, lng: base.lng });
  });
});

describe('continuousHeading (arco mais curto + congelamento)', () => {
  it('primeiro rumo → o próprio, normalizado', () => {
    expect(continuousHeading(null, { heading: 90, speedMps: 10 })).toBe(90);
  });
  it('cruza o zero pelo arco curto (acumulando continuidade)', () => {
    // current 359, alvo 1 → +2 (=361 contínuo), não -358
    expect(continuousHeading(359, { heading: 1, speedMps: 10 })).toBeCloseTo(361, 5);
  });
  it('parado → congela o rumo atual (não gira no semáforo)', () => {
    expect(continuousHeading(120, { heading: 300, speedMps: 0.2 })).toBe(120);
  });
  it('rumo do GPS inválido → congela', () => {
    expect(continuousHeading(120, { heading: -1, speedMps: 10 })).toBe(120);
  });
  it('velocidade DESCONHECIDA (posição do servidor) → confia no rumo, não congela', () => {
    // current 10, alvo 40, sem speed → gira +30
    expect(continuousHeading(10, { heading: 40 })).toBeCloseTo(40, 5);
  });
});

describe('inferHeading (fallback sem curso do GPS)', () => {
  it('passo grande → rumo do deslocamento', () => {
    const h = inferHeading({ lat: 28.54, lng: -81.38 }, { lat: 28.54, lng: -81.37 });
    expect(h).toBeCloseTo(90, 0);
  });
  it('passo minúsculo (< 2 m) → null (não confia)', () => {
    expect(inferHeading({ lat: 28.54, lng: -81.38 }, { lat: 28.540001, lng: -81.38 })).toBeNull();
  });
});
