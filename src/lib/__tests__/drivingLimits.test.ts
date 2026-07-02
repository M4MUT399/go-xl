import { computeDutyStatus, formatHm, type DutySession } from '../drivingLimits';

const NOW = new Date('2026-07-01T20:00:00.000Z');
const CFG = { limitHours: 12, restHours: 6 };
// ISO a partir de um offset em minutos relativo a NOW (negativo = passado).
const at = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();
const H = 60;

describe('computeDutyStatus', () => {
  it('sem sessões: zerado, sem descanso, offline', () => {
    const s = computeDutyStatus([], CFG, NOW);
    expect(s.online).toBe(false);
    expect(s.accumulatedMinutes).toBe(0);
    expect(s.remainingMinutes).toBe(12 * H);
    expect(s.mustRest).toBe(false);
    expect(s.restUntil).toBeNull();
  });

  it('sessão aberta há 2h: online, acumula ~2h', () => {
    const sessions: DutySession[] = [{ started_at: at(-2 * H), ended_at: null }];
    const s = computeDutyStatus(sessions, CFG, NOW);
    expect(s.online).toBe(true);
    expect(s.accumulatedMinutes).toBeCloseTo(2 * H);
    expect(s.remainingMinutes).toBeCloseTo(10 * H);
    expect(s.mustRest).toBe(false);
  });

  it('12h dirigidas sem descanso qualificado: exige descanso', () => {
    const sessions: DutySession[] = [{ started_at: at(-12 * H), ended_at: at(0) }];
    const s = computeDutyStatus(sessions, CFG, NOW);
    expect(s.mustRest).toBe(true);
    expect(s.remainingMinutes).toBe(0);
    // restUntil = fim da atividade (agora) + 6h
    expect(s.restUntil?.getTime()).toBe(NOW.getTime() + 6 * H * 60_000);
  });

  it('intervalo curto (<6h) NÃO zera o acúmulo', () => {
    // 6h dirigindo, 1h de pausa, mais 6h dirigindo = 12h → estoura.
    const sessions: DutySession[] = [
      { started_at: at(-13 * H), ended_at: at(-7 * H) }, // 6h
      { started_at: at(-6 * H), ended_at: at(0) },       // 6h (pausa de 1h antes)
    ];
    const s = computeDutyStatus(sessions, CFG, NOW);
    expect(s.accumulatedMinutes).toBeCloseTo(12 * H);
    expect(s.mustRest).toBe(true);
  });

  it('descanso qualificado (>=6h) zera e recomeça o turno', () => {
    // Dirigiu 12h, descansou 6h, dirigiu 1h → acúmulo = 1h.
    const sessions: DutySession[] = [
      { started_at: at(-24 * H), ended_at: at(-12 * H) }, // 12h
      { started_at: at(-1 * H), ended_at: at(0) },        // 1h (gap de 11h antes)
    ];
    const s = computeDutyStatus(sessions, CFG, NOW);
    expect(s.accumulatedMinutes).toBeCloseTo(1 * H);
    expect(s.mustRest).toBe(false);
  });

  it('após estourar, descanso offline suficiente libera de novo', () => {
    // Dirigiu 12h e terminou há 6h (offline descansando) → liberado.
    const sessions: DutySession[] = [{ started_at: at(-18 * H), ended_at: at(-6 * H) }];
    const s = computeDutyStatus(sessions, CFG, NOW);
    expect(s.accumulatedMinutes).toBe(0);
    expect(s.mustRest).toBe(false);
  });

  it('ignora sessões com datas inválidas', () => {
    const sessions: DutySession[] = [{ started_at: 'lixo', ended_at: null }];
    const s = computeDutyStatus(sessions, CFG, NOW);
    expect(s.accumulatedMinutes).toBe(0);
  });
});

describe('formatHm', () => {
  it('formata horas e minutos', () => {
    expect(formatHm(0)).toBe('0min');
    expect(formatHm(45)).toBe('45min');
    expect(formatHm(60)).toBe('1h');
    expect(formatHm(125)).toBe('2h 05min');
    expect(formatHm(-10)).toBe('0min');
  });
});
