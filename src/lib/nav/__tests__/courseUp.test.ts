import {
  advanceHeading,
  initialHeadingState,
  shouldUpdateHeading,
  topPaddingForAnchor,
  DEFAULT_COURSE_UP,
} from '../courseUp';

describe('shouldUpdateHeading', () => {
  it('usa o curso quando movendo acima do limiar (4 km/h) e curso válido', () => {
    // 4 km/h = ~1.111 m/s
    expect(shouldUpdateHeading(1.2, 90)).toBe(true);
  });
  it('congela abaixo do limiar de movimento', () => {
    expect(shouldUpdateHeading(0.5, 90)).toBe(false);
  });
  it('congela com curso inválido (negativo/ausente) mesmo movendo', () => {
    expect(shouldUpdateHeading(10, -1)).toBe(false);
    expect(shouldUpdateHeading(10, null)).toBe(false);
  });
});

describe('advanceHeading', () => {
  it('primeiro fix válido crava o curso (sem lerp de um zero artificial)', () => {
    const s = advanceHeading(initialHeadingState, 10, 90);
    expect(s.smoothed).toBe(90);
    expect(s.continuous).toBe(90);
    expect(s.lastRawCourse).toBe(90);
  });

  it('parado NÃO muda o estado (rotação congelada)', () => {
    const s1 = advanceHeading(initialHeadingState, 10, 90);
    const s2 = advanceHeading(s1, 0, 270); // parado → ignora o novo curso
    expect(s2).toEqual(s1);
  });

  it('desenrola pelo caminho mais curto (350°→10° = +20°, não -340°)', () => {
    const s1 = advanceHeading(initialHeadingState, 10, 350);
    const s2 = advanceHeading(s1, 10, 10, { ...DEFAULT_COURSE_UP, smoothingAlpha: 1 });
    // continuous deve subir ~20° (370), nunca cair ~340°
    expect(s2.continuous).toBeCloseTo(370, 5);
    // com alpha=1 o suavizado acompanha o contínuo
    expect(s2.smoothed).toBeCloseTo(370, 5);
  });

  it('passa-baixa amortece o salto (alpha < 1 fica entre o antigo e o novo)', () => {
    const s1 = advanceHeading(initialHeadingState, 10, 0);
    const s2 = advanceHeading(s1, 10, 40, { ...DEFAULT_COURSE_UP, smoothingAlpha: 0.25 });
    // continuous = 40, smoothed = 0 + 0.25*(40-0) = 10
    expect(s2.continuous).toBeCloseTo(40, 5);
    expect(s2.smoothed).toBeCloseTo(10, 5);
  });
});

describe('topPaddingForAnchor', () => {
  it('terço inferior (0.33) → padding-top ~34% da altura', () => {
    // 1 - 2*0.33 = 0.34
    expect(topPaddingForAnchor(1000)).toBe(340);
  });
  it('nunca retorna padding negativo (âncora ≥ 0.5)', () => {
    expect(topPaddingForAnchor(1000, { ...DEFAULT_COURSE_UP, anchorFromBottom: 0.5 })).toBe(0);
    expect(topPaddingForAnchor(1000, { ...DEFAULT_COURSE_UP, anchorFromBottom: 0.7 })).toBe(0);
  });
});
