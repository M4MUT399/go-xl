import {
  SAFETY_INCIDENT_CATEGORIES,
  ZERO_TOLERANCE_CATEGORIES,
  isZeroToleranceCategory,
  buildSuspensionReason,
  hasActiveSuspension,
  canLiftSuspension,
  type SuspensionRecord,
} from '../safetyIncidents';

describe('safetyIncidents — classificação de categoria', () => {
  it('todas as categorias declaradas em SAFETY_INCIDENT_CATEGORIES são reconhecidas', () => {
    expect(SAFETY_INCIDENT_CATEGORIES.length).toBeGreaterThan(0);
    for (const c of SAFETY_INCIDENT_CATEGORIES) {
      expect(typeof isZeroToleranceCategory(c)).toBe('boolean');
    }
  });

  it.each(['driver_intoxication', 'sexual_assault', 'physical_assault', 'weapon_possession'] as const)(
    '%s é tolerância zero',
    (category) => {
      expect(isZeroToleranceCategory(category)).toBe(true);
      expect(ZERO_TOLERANCE_CATEGORIES.has(category)).toBe(true);
    }
  );

  it.each(['discrimination', 'reckless_driving', 'vehicle_mismatch', 'unsafe_vehicle', 'other'] as const)(
    '%s NÃO é tolerância zero (entra na fila normal de revisão)',
    (category) => {
      expect(isZeroToleranceCategory(category)).toBe(false);
    }
  );

  it('buildSuspensionReason prefixa com zero_tolerance_report: e inclui a categoria', () => {
    expect(buildSuspensionReason('sexual_assault')).toBe('zero_tolerance_report:sexual_assault');
    expect(buildSuspensionReason('driver_intoxication')).toBe('zero_tolerance_report:driver_intoxication');
  });
});

describe('safetyIncidents — hasActiveSuspension', () => {
  const base: SuspensionRecord = {
    id: 's1',
    driverId: 'd1',
    reason: 'zero_tolerance_report:weapon_possession',
    suspendedAt: '2026-01-01T00:00:00.000Z',
    liftedAt: null,
  };

  it('lista vazia → não suspenso', () => {
    expect(hasActiveSuspension([])).toEqual({ suspended: false, activeSuspensionIds: [] });
  });

  it('uma suspensão sem liftedAt → suspenso', () => {
    const r = hasActiveSuspension([base]);
    expect(r.suspended).toBe(true);
    expect(r.activeSuspensionIds).toEqual(['s1']);
  });

  it('suspensão com liftedAt preenchido → não conta como ativa', () => {
    const lifted: SuspensionRecord = { ...base, liftedAt: '2026-01-05T00:00:00.000Z' };
    expect(hasActiveSuspension([lifted])).toEqual({ suspended: false, activeSuspensionIds: [] });
  });

  it('mistura de suspensões ativas e levantadas → só reporta as ativas', () => {
    const lifted: SuspensionRecord = { ...base, id: 's2', liftedAt: '2026-01-05T00:00:00.000Z' };
    const active2: SuspensionRecord = { ...base, id: 's3' };
    const r = hasActiveSuspension([base, lifted, active2]);
    expect(r.suspended).toBe(true);
    expect(r.activeSuspensionIds.sort()).toEqual(['s1', 's3']);
  });
});

describe('safetyIncidents — canLiftSuspension', () => {
  it('suspensão ativa (sem liftedAt) pode ser levantada', () => {
    const s: SuspensionRecord = {
      id: 's1', driverId: 'd1', reason: 'zero_tolerance_report:driver_intoxication',
      suspendedAt: '2026-01-01T00:00:00.000Z', liftedAt: null,
    };
    expect(canLiftSuspension(s)).toEqual({ ok: true });
  });

  it('suspensão já levantada → bloqueia (idempotência)', () => {
    const s: SuspensionRecord = {
      id: 's1', driverId: 'd1', reason: 'zero_tolerance_report:driver_intoxication',
      suspendedAt: '2026-01-01T00:00:00.000Z', liftedAt: '2026-01-02T00:00:00.000Z',
    };
    expect(canLiftSuspension(s)).toEqual({ ok: false, error: 'already_lifted' });
  });
});
