import {
  evaluateDisqualification,
  DEFAULT_DISQUALIFICATION_THRESHOLDS,
  EMPTY_DISQUALIFICATION_FINDINGS,
  type DisqualificationFindings,
} from '../disqualificationRules';

const NOW = new Date('2026-07-15T12:00:00.000Z');
const yearsAgo = (years: number) => {
  const d = new Date(NOW);
  d.setFullYear(d.getFullYear() - years);
  return d.toISOString();
};

describe('evaluateDisqualification — categorias de bane vitalício', () => {
  it('findings limpos → não desqualifica', () => {
    const r = evaluateDisqualification(EMPTY_DISQUALIFICATION_FINDINGS, DEFAULT_DISQUALIFICATION_THRESHOLDS, NOW);
    expect(r).toEqual({ disqualified: false, reasons: [] });
  });

  it('crime violento → desqualifica sempre, mesmo sem nenhuma outra ocorrência', () => {
    const findings: DisqualificationFindings = { ...EMPTY_DISQUALIFICATION_FINDINGS, violentCrimeConviction: true };
    const r = evaluateDisqualification(findings, DEFAULT_DISQUALIFICATION_THRESHOLDS, NOW);
    expect(r.disqualified).toBe(true);
    expect(r.reasons).toEqual(['violent_crime_conviction']);
  });

  it('cada categoria de bane vitalício produz seu próprio motivo', () => {
    const cases: Array<[keyof DisqualificationFindings, string]> = [
      ['sexOffenseConviction', 'sex_offense_conviction'],
      ['traffickingOrExploitationConviction', 'trafficking_or_exploitation_conviction'],
      ['registeredSexOffender', 'registered_sex_offender'],
      ['licenseSuspendedOrRevoked', 'license_suspended_or_revoked'],
    ];
    for (const [key, reason] of cases) {
      const findings: DisqualificationFindings = { ...EMPTY_DISQUALIFICATION_FINDINGS, [key]: true };
      const r = evaluateDisqualification(findings, DEFAULT_DISQUALIFICATION_THRESHOLDS, NOW);
      expect(r.reasons).toEqual([reason]);
    }
  });

  it('acumula múltiplos motivos simultâneos (não para no primeiro)', () => {
    const findings: DisqualificationFindings = {
      ...EMPTY_DISQUALIFICATION_FINDINGS,
      violentCrimeConviction: true,
      registeredSexOffender: true,
    };
    const r = evaluateDisqualification(findings, DEFAULT_DISQUALIFICATION_THRESHOLDS, NOW);
    expect(r.reasons.sort()).toEqual(['registered_sex_offender', 'violent_crime_conviction'].sort());
  });
});

describe('evaluateDisqualification — limiares configuráveis (janela + contagem)', () => {
  it('felony dentro da janela (default: qualquer uma nos últimos 7 anos) desqualifica', () => {
    const findings: DisqualificationFindings = {
      ...EMPTY_DISQUALIFICATION_FINDINGS,
      felonyConvictionDates: [yearsAgo(2)],
    };
    const r = evaluateDisqualification(findings, DEFAULT_DISQUALIFICATION_THRESHOLDS, NOW);
    expect(r.reasons).toEqual(['felony_convictions_threshold']);
  });

  it('felony FORA da janela (mais de 7 anos) não conta', () => {
    const findings: DisqualificationFindings = {
      ...EMPTY_DISQUALIFICATION_FINDINGS,
      felonyConvictionDates: [yearsAgo(8)],
    };
    const r = evaluateDisqualification(findings, DEFAULT_DISQUALIFICATION_THRESHOLDS, NOW);
    expect(r.disqualified).toBe(false);
  });

  it('DUI: mesma regra (default max=0 → qualquer uma na janela desqualifica)', () => {
    const findings: DisqualificationFindings = {
      ...EMPTY_DISQUALIFICATION_FINDINGS,
      duiConvictionDates: [yearsAgo(6)],
    };
    const r = evaluateDisqualification(findings, DEFAULT_DISQUALIFICATION_THRESHOLDS, NOW);
    expect(r.reasons).toEqual(['dui_convictions_threshold']);
  });

  it('violação grave de trânsito: tolera até 2 na janela (default), 3ª desqualifica', () => {
    const twoViolations: DisqualificationFindings = {
      ...EMPTY_DISQUALIFICATION_FINDINGS,
      majorMovingViolationDates: [yearsAgo(1), yearsAgo(2)],
    };
    expect(evaluateDisqualification(twoViolations, DEFAULT_DISQUALIFICATION_THRESHOLDS, NOW).disqualified).toBe(false);

    const threeViolations: DisqualificationFindings = {
      ...EMPTY_DISQUALIFICATION_FINDINGS,
      majorMovingViolationDates: [yearsAgo(1), yearsAgo(2), yearsAgo(0.5)],
    };
    const r = evaluateDisqualification(threeViolations, DEFAULT_DISQUALIFICATION_THRESHOLDS, NOW);
    expect(r.reasons).toEqual(['major_moving_violations_threshold']);
  });

  it('data inválida é ignorada na contagem (não quebra, não conta)', () => {
    const findings: DisqualificationFindings = {
      ...EMPTY_DISQUALIFICATION_FINDINGS,
      felonyConvictionDates: ['not-a-date'],
    };
    const r = evaluateDisqualification(findings, DEFAULT_DISQUALIFICATION_THRESHOLDS, NOW);
    expect(r.disqualified).toBe(false);
  });

  it('limiares customizados (jurisdição mais permissiva) são respeitados', () => {
    const findings: DisqualificationFindings = {
      ...EMPTY_DISQUALIFICATION_FINDINGS,
      duiConvictionDates: [yearsAgo(1)],
    };
    const permissive = { ...DEFAULT_DISQUALIFICATION_THRESHOLDS, duiMaxCount: 1 };
    const r = evaluateDisqualification(findings, permissive, NOW);
    expect(r.disqualified).toBe(false);
  });
});
