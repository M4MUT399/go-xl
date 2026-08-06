import {
  analyzeStep,
  overallScore,
  scoreCategory,
  tripScoreFromCounts,
  haversineKm,
  DEFAULT_TELEMATICS_CONFIG,
  type TelematicsSample,
} from '../../lib/telematics/scorer';
import { TripTelematics } from '../../lib/telematics/session';
import { computeChallenges, type ChallengeSession } from '../../lib/telematics/challenges';

const CFG = DEFAULT_TELEMATICS_CONFIG;

/** Fix helper — 1s de passo por padrão; posição fixa salvo override. */
function fix(atMs: number, speedMps: number, opts: Partial<TelematicsSample> = {}): TelematicsSample {
  return { atMs, speedMps, lat: 28.5383, lng: -81.3792, headingDeg: 0, accuracyM: 5, ...opts };
}

describe('scorer — detecção de eventos', () => {
  it('freada brusca: queda de 15→5 m/s em 1s (~-10 m/s²) marca hard_brake severe', () => {
    const r = analyzeStep(fix(0, 15), fix(1000, 5), CFG);
    const brake = r.events.find((e) => e.type === 'hard_brake');
    expect(brake).toBeTruthy();
    expect(brake?.severity).toBe('severe');
  });

  it('aceleração suave: 10→11 m/s em 1s (1 m/s²) NÃO marca nada', () => {
    const r = analyzeStep(fix(0, 10), fix(1000, 11), CFG);
    expect(r.events.length).toBe(0);
  });

  it('arrancada brusca: 5→9 m/s em 1s (4 m/s²) marca hard_accel', () => {
    const r = analyzeStep(fix(0, 5), fix(1000, 9), CFG);
    expect(r.events.some((e) => e.type === 'hard_accel')).toBe(true);
  });

  it('salto de GPS (0→30 m/s em 1s, 30 m/s²) é ruído e é ignorado', () => {
    const r = analyzeStep(fix(0, 0), fix(1000, 30), CFG);
    expect(r.events.some((e) => e.type === 'hard_brake' || e.type === 'hard_accel')).toBe(false);
  });

  it('excesso de velocidade acima do teto absoluto marca speeding', () => {
    const r = analyzeStep(fix(0, 40), fix(1000, 40), CFG); // 144 km/h > 120
    expect(r.events.some((e) => e.type === 'speeding')).toBe(true);
  });

  it('respeita o limite da via quando informado', () => {
    const slow = fix(1000, 20, { speedLimitKmh: 50 }); // 72 km/h > 50+8
    const r = analyzeStep(fix(0, 20, { speedLimitKmh: 50 }), slow, CFG);
    expect(r.events.some((e) => e.type === 'speeding')).toBe(true);
  });

  it('curva brusca: 25° em 1s a 15 m/s (~6.5 m/s² lateral) marca hard_corner', () => {
    const r = analyzeStep(
      fix(0, 15, { headingDeg: 0 }),
      fix(1000, 15, { headingDeg: 25 }),
      CFG,
    );
    expect(r.events.some((e) => e.type === 'hard_corner')).toBe(true);
  });

  it('fix impreciso (accuracy > 30m) é descartado', () => {
    const r = analyzeStep(fix(0, 15), fix(1000, 5, { accuracyM: 50 }), CFG);
    expect(r.discarded).toBe(true);
    expect(r.events.length).toBe(0);
  });

  it('gap grande (>6s) conta distância mas não deriva aceleração', () => {
    const r = analyzeStep(
      fix(0, 15, { lat: 28.5, lng: -81.3 }),
      fix(10_000, 0, { lat: 28.51, lng: -81.3 }),
      CFG,
    );
    expect(r.events.some((e) => e.type === 'hard_brake')).toBe(false);
    expect(r.distanceKm).toBeGreaterThan(0);
  });
});

describe('session — acumulador de viagem', () => {
  it('viagem limpa mantém nota 100', () => {
    const t = new TripTelematics('driver-1', 'ride-1', 0);
    for (let i = 0; i <= 60; i++) t.ingest(fix(i * 1000, 15));
    const snap = t.snapshot();
    expect(snap.score).toBe(100);
    expect(snap.counts.hard_brake).toBe(0);
  });

  it('cooldown evita contar a mesma freada em fixes consecutivos', () => {
    const t = new TripTelematics('driver-1', 'ride-1', 0);
    t.ingest(fix(0, 15));
    t.ingest(fix(1000, 5)); // freada
    t.ingest(fix(2000, 0)); // ainda dentro do cooldown de 4s → não conta de novo
    expect(t.snapshot().counts.hard_brake).toBe(1);
  });

  it('serialize/deserialize preserva o estado', () => {
    const t = new TripTelematics('driver-1', 'ride-1', 0);
    t.ingest(fix(0, 15));
    t.ingest(fix(1000, 5)); // 1 freada severa
    const raw = t.serialize();
    const back = TripTelematics.deserialize(raw)!;
    expect(back).toBeTruthy();
    // Continua acumulando corretamente após restaurar.
    back.ingest(fix(6000, 15));
    back.ingest(fix(7000, 7)); // outra freada (-8 m/s²), fora do cooldown
    const snap = back.snapshot();
    expect(snap.counts.hard_brake).toBe(2);
    expect(snap.score).toBeLessThan(100);
  });
});

describe('score — nota e categoria', () => {
  it('categorias por faixa (marcas 75/85)', () => {
    expect(scoreCategory(94)).toBe('great');
    expect(scoreCategory(85)).toBe('great');
    expect(scoreCategory(80)).toBe('good');
    expect(scoreCategory(70)).toBe('fair');
    expect(scoreCategory(40)).toBe('poor');
  });

  it('nota por contagens desconta penalidades', () => {
    expect(tripScoreFromCounts({ speeding: 1, hard_brake: 1, hard_accel: 0, hard_corner: 0 })).toBe(91);
  });

  it('nota geral pondera pela distância; null sem viagens', () => {
    expect(overallScore([])).toBeNull();
    const s = overallScore([
      { score: 100, distance_km: 10 },
      { score: 50, distance_km: 1 },
    ]);
    // Viagem longa (100) domina a curta (50).
    expect(s).toBeGreaterThan(90);
  });

  it('haversine ~1.11 km por 0.01° de latitude', () => {
    expect(haversineKm(28.5, -81.3, 28.51, -81.3)).toBeCloseTo(1.11, 1);
  });
});

describe('challenges — desafios rolantes', () => {
  const mk = (over: Partial<ChallengeSession>): ChallengeSession => ({
    score: 100, speeding_count: 0, hard_brake_count: 0, hard_accel_count: 0, hard_corner_count: 0,
    ended_at: '2026-07-20T12:00:00Z', ...over,
  });

  it('10 viagens limpas completam o desafio de limite de velocidade', () => {
    const sessions = Array.from({ length: 10 }, () => mk({}));
    const { challenges } = computeChallenges(sessions, new Date('2026-07-22T00:00:00Z'));
    const speed = challenges.find((c) => c.key === 'speed_limit')!;
    expect(speed.completed).toBe(true);
    expect(speed.remaining).toBe(0);
    expect(speed.slots.every((s) => s === 'ok')).toBe(true);
  });

  it('faltando viagens mostra remaining e slots pending', () => {
    const sessions = Array.from({ length: 8 }, () => mk({}));
    const { challenges } = computeChallenges(sessions, new Date('2026-07-22T00:00:00Z'));
    const brake = challenges.find((c) => c.key === 'smooth_brake')!;
    expect(brake.remaining).toBe(2);
    expect(brake.completed).toBe(false);
    expect(brake.slots.filter((s) => s === 'pending').length).toBe(2);
  });

  it('uma falha quebra a streak', () => {
    const sessions = [
      ...Array.from({ length: 9 }, () => mk({})),
      mk({ hard_accel_count: 2 }),
    ];
    const { challenges } = computeChallenges(sessions, new Date('2026-07-22T00:00:00Z'));
    const accel = challenges.find((c) => c.key === 'smooth_accel')!;
    expect(accel.fails).toBe(1);
    expect(accel.completed).toBe(false);
  });

  it('conta viagens seguras do mês corrente', () => {
    const sessions = [
      mk({ score: 95, ended_at: '2026-07-10T10:00:00Z' }),
      mk({ score: 88, ended_at: '2026-07-11T10:00:00Z' }), // < 90 não conta
      mk({ score: 100, ended_at: '2026-06-30T10:00:00Z' }), // mês anterior
    ];
    const { safeTripsThisMonth } = computeChallenges(sessions, new Date('2026-07-22T00:00:00Z'));
    expect(safeTripsThisMonth).toBe(1);
  });
});
