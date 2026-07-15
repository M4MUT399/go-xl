import { resolveExportMonth, buildDailyMileageCsv, findActivePeriodAtTimestamp, type PeriodTransitionRow } from '../telematicsExport';

describe('resolveExportMonth', () => {
  it('sem requestedMonth: usa o mês anterior completo (caso comum)', () => {
    const r = resolveExportMonth(new Date('2026-07-15T10:00:00Z'));
    expect(r).toEqual({ start: '2026-06-01', end: '2026-07-01', label: '2026-06' });
  });

  it('sem requestedMonth: janeiro volta pro dezembro do ano anterior', () => {
    const r = resolveExportMonth(new Date('2026-01-03T00:00:00Z'));
    expect(r).toEqual({ start: '2025-12-01', end: '2026-01-01', label: '2025-12' });
  });

  it('com requestedMonth explícito: usa exatamente esse mês', () => {
    const r = resolveExportMonth(new Date('2026-07-15T10:00:00Z'), '2026-02');
    expect(r).toEqual({ start: '2026-02-01', end: '2026-03-01', label: '2026-02' });
  });

  it('requestedMonth em dezembro: end vira janeiro do ano seguinte', () => {
    const r = resolveExportMonth(new Date('2026-07-15T10:00:00Z'), '2025-12');
    expect(r).toEqual({ start: '2025-12-01', end: '2026-01-01', label: '2025-12' });
  });

  it('rejeita formato inválido', () => {
    expect(() => resolveExportMonth(new Date(), '2026/02')).toThrow(/mês inválido/);
    expect(() => resolveExportMonth(new Date(), 'abc')).toThrow(/mês inválido/);
  });

  it('rejeita mês fora de 01-12', () => {
    expect(() => resolveExportMonth(new Date(), '2026-13')).toThrow(/mês inválido/);
    expect(() => resolveExportMonth(new Date(), '2026-00')).toThrow(/mês inválido/);
  });
});

describe('buildDailyMileageCsv', () => {
  it('sem linhas: só o cabeçalho', () => {
    expect(buildDailyMileageCsv([])).toBe(
      'driver_id,day,p1_miles,p2_miles,p3_miles,estimated_miles,total_miles\n'
    );
  });

  it('soma o total e arredonda para 2 casas', () => {
    const csv = buildDailyMileageCsv([
      { driver_id: 'd1', day: '2026-06-01', p1_miles: 1.005, p2_miles: 2.111, p3_miles: 3.334, estimated_miles: 0.5 },
    ]);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(2);
    // 1.005 -> 1 ou 1.01 dependendo de arredondamento float; conferimos só o total.
    const [driverId, day, , , , , total] = lines[1].split(',');
    expect(driverId).toBe('d1');
    expect(day).toBe('2026-06-01');
    expect(Number(total)).toBeCloseTo(6.45, 2);
  });

  it('múltiplas linhas mantêm a ordem recebida', () => {
    const csv = buildDailyMileageCsv([
      { driver_id: 'd1', day: '2026-06-01', p1_miles: 1, p2_miles: 0, p3_miles: 0, estimated_miles: 0 },
      { driver_id: 'd2', day: '2026-06-01', p1_miles: 2, p2_miles: 0, p3_miles: 0, estimated_miles: 0 },
    ]);
    const lines = csv.trim().split('\n');
    expect(lines[1].startsWith('d1,')).toBe(true);
    expect(lines[2].startsWith('d2,')).toBe(true);
  });
});

describe('findActivePeriodAtTimestamp', () => {
  const mk = (at_ms: number, to_period: string): PeriodTransitionRow => ({
    id: `t-${at_ms}`,
    driver_id: 'd1',
    trip_id: null,
    from_period: 'P0_OFFLINE',
    to_period,
    reason: 'test',
    at_ms,
    lat: null,
    lng: null,
    cumulative_miles_at_transition: null,
    mileage_estimated: false,
  });

  it('lista vazia: null', () => {
    expect(findActivePeriodAtTimestamp([], 1000)).toBeNull();
  });

  it('instante antes de qualquer transição: null (não presume P0)', () => {
    const rows = [mk(2000, 'P1_AVAILABLE')];
    expect(findActivePeriodAtTimestamp(rows, 1000)).toBeNull();
  });

  it('escolhe a transição mais recente <= atMs, mesmo fora de ordem', () => {
    const rows = [mk(3000, 'P3_ONTRIP'), mk(1000, 'P1_AVAILABLE'), mk(2000, 'P2_ENROUTE')];
    const r = findActivePeriodAtTimestamp(rows, 2500);
    expect(r?.to_period).toBe('P2_ENROUTE');
  });

  it('limite inclusivo: at_ms === atMs conta como vigente', () => {
    const rows = [mk(1000, 'P1_AVAILABLE'), mk(2000, 'P2_ENROUTE')];
    const r = findActivePeriodAtTimestamp(rows, 2000);
    expect(r?.to_period).toBe('P2_ENROUTE');
  });

  it('instante depois de todas: pega a última', () => {
    const rows = [mk(1000, 'P1_AVAILABLE'), mk(2000, 'P3_ONTRIP')];
    const r = findActivePeriodAtTimestamp(rows, 999999);
    expect(r?.to_period).toBe('P3_ONTRIP');
  });
});
