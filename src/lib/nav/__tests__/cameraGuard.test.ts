import {
  clampAltitude,
  clampRegionDelta,
  clampZoom,
  firstValidCoord,
  isFiniteCoord,
  isNullIsland,
  sanitizeCoords,
  validateTarget,
  DEFAULT_GUARD,
} from '../cameraGuard';

describe('isFiniteCoord', () => {
  it('aceita coordenadas reais dentro dos limites', () => {
    expect(isFiniteCoord(28.53, -81.37)).toBe(true);
  });
  it('rejeita NaN / não-número / fora de faixa', () => {
    expect(isFiniteCoord(NaN, 10)).toBe(false);
    expect(isFiniteCoord(10, NaN)).toBe(false);
    expect(isFiniteCoord(null, 10)).toBe(false);
    expect(isFiniteCoord(91, 0)).toBe(false);
    expect(isFiniteCoord(0, 181)).toBe(false);
  });
});

describe('isNullIsland', () => {
  it('detecta (0,0) como Null Island', () => {
    expect(isNullIsland(0, 0)).toBe(true);
    expect(isNullIsland(1e-9, -1e-9)).toBe(true);
  });
  it('não confunde coordenada real com (0,0)', () => {
    expect(isNullIsland(28.53, -81.37)).toBe(false);
  });
});

describe('validateTarget', () => {
  const orlando = { lat: 28.5383, lng: -81.3792 };

  it('aceita um fix real sem última posição (primeiro do turno)', () => {
    expect(validateTarget(orlando, null)).toEqual({ ok: true });
  });

  it('rejeita null / undefined', () => {
    expect(validateTarget(null, orlando).ok).toBe(false);
    expect(validateTarget(undefined, orlando).ok).toBe(false);
  });

  it('rejeita NaN', () => {
    const r = validateTarget({ lat: NaN, lng: -81 }, orlando);
    expect(r).toEqual({ ok: false, reason: 'nan' });
  });

  it('rejeita (0,0) — GPS sem fix', () => {
    const r = validateTarget({ lat: 0, lng: 0 }, orlando);
    expect(r).toEqual({ ok: false, reason: 'null_island' });
  });

  it('rejeita fix com accuracy pior que o limite', () => {
    const r = validateTarget({ ...orlando, accuracy: 250 }, orlando);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('accuracy');
  });

  it('aceita fix com accuracy dentro do limite', () => {
    expect(validateTarget({ ...orlando, accuracy: 20 }, orlando).ok).toBe(true);
  });

  it('rejeita salto impossível (> 200 km) desde a última posição válida', () => {
    // ~1400 km ao norte de Orlando (Nova York) num único fix = lixo de GPS.
    const r = validateTarget({ lat: 40.7128, lng: -74.006 }, orlando);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('jump');
  });

  it('aceita um deslocamento plausível (poucos km)', () => {
    expect(validateTarget({ lat: 28.55, lng: -81.36 }, orlando).ok).toBe(true);
  });
});

describe('firstValidCoord — centro de montagem seguro (Bloco 1)', () => {
  const orlando = { lat: 28.5383, lng: -81.3792 };
  const pickup = { lat: 28.42, lng: -81.31 };

  it('escolhe o PRIMEIRO candidato válido (herança da última câmera)', () => {
    expect(firstValidCoord([orlando, pickup])).toEqual(orlando);
  });

  it('pula (0,0) e escolhe o próximo válido (GPS do aceite sem fix)', () => {
    expect(firstValidCoord([{ lat: 0, lng: 0 }, pickup])).toEqual(pickup);
  });

  it('pula null/undefined e escolhe o embarque', () => {
    expect(firstValidCoord([null, undefined, pickup])).toEqual(pickup);
  });

  it('pula NaN/Infinity (fix atrasado corrompido)', () => {
    expect(firstValidCoord([{ lat: NaN, lng: 10 }, { lat: Infinity, lng: 0 }, pickup])).toEqual(pickup);
  });

  it('retorna null quando TODOS os candidatos são lixo (não monta em região default)', () => {
    expect(firstValidCoord([null, { lat: 0, lng: 0 }, { lat: NaN, lng: NaN }])).toBeNull();
  });
});

describe('clampZoom', () => {
  it('mantém zoom dentro da faixa', () => {
    expect(clampZoom(17)).toEqual({ zoom: 17, clamped: false });
  });
  it('corrige zoom abaixo do mínimo para o piso operacional', () => {
    expect(clampZoom(3)).toEqual({ zoom: DEFAULT_GUARD.minZoom, clamped: true });
  });
  it('corrige zoom absurdamente alto para o teto', () => {
    expect(clampZoom(99)).toEqual({ zoom: DEFAULT_GUARD.maxZoom, clamped: true });
  });
  it('zoom ausente/inválido → undefined sem clamp', () => {
    expect(clampZoom(undefined)).toEqual({ zoom: undefined, clamped: false });
    expect(clampZoom(NaN)).toEqual({ zoom: undefined, clamped: false });
  });
});

describe('clampAltitude', () => {
  it('mantém altitude dentro da faixa operacional', () => {
    expect(clampAltitude(350)).toEqual({ altitude: 350, clamped: false });
  });
  it('corrige altitude alta demais para o teto anti-continente', () => {
    // É este o caso do bug do iPhone: a altitude realimentada cresce a cada fix.
    expect(clampAltitude(120_000)).toEqual({
      altitude: DEFAULT_GUARD.maxAltitude,
      clamped: true,
    });
  });
  it('corrige altitude baixa demais para o piso', () => {
    expect(clampAltitude(1)).toEqual({ altitude: DEFAULT_GUARD.minAltitude, clamped: true });
  });
  it('altitude ausente/inválida → undefined sem clamp', () => {
    expect(clampAltitude(undefined)).toEqual({ altitude: undefined, clamped: false });
    expect(clampAltitude(NaN)).toEqual({ altitude: undefined, clamped: false });
  });
});

describe('clampRegionDelta', () => {
  it('mantém deltas pequenos intactos', () => {
    expect(clampRegionDelta(0.02, 0.02)).toEqual({
      latitudeDelta: 0.02,
      longitudeDelta: 0.02,
      clamped: false,
    });
  });
  it('corta deltas grandes ao teto anti-continente', () => {
    const r = clampRegionDelta(50, 80);
    expect(r.latitudeDelta).toBe(DEFAULT_GUARD.maxRegionDelta);
    expect(r.longitudeDelta).toBe(DEFAULT_GUARD.maxRegionDelta);
    expect(r.clamped).toBe(true);
  });
});

describe('sanitizeCoords', () => {
  it('remove lixo, (0,0) e mantém as reais', () => {
    const input = [
      { lat: 28.53, lng: -81.37 },
      { lat: 0, lng: 0 },
      { lat: NaN, lng: 10 },
      { lat: 28.54, lng: -81.38 },
    ];
    expect(sanitizeCoords(input)).toEqual([
      { lat: 28.53, lng: -81.37 },
      { lat: 28.54, lng: -81.38 },
    ]);
  });
  it('lista nula/vazia → []', () => {
    expect(sanitizeCoords(null)).toEqual([]);
    expect(sanitizeCoords([])).toEqual([]);
  });
});
