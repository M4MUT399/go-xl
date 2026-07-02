import {
  minutesUntil,
  shouldShowBanner,
  isImminent,
  formatCountdown,
  pickSoonest,
} from '../scheduledRides';

const NOW = new Date('2026-07-01T12:00:00.000Z');
const iso = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();

describe('minutesUntil', () => {
  it('positivo para o futuro, negativo para o passado', () => {
    expect(minutesUntil(iso(30), NOW)).toBeCloseTo(30);
    expect(minutesUntil(iso(-10), NOW)).toBeCloseTo(-10);
  });
  it('Infinity para vazio ou inválido', () => {
    expect(minutesUntil(null, NOW)).toBe(Infinity);
    expect(minutesUntil(undefined, NOW)).toBe(Infinity);
    expect(minutesUntil('não-é-data', NOW)).toBe(Infinity);
  });
});

describe('shouldShowBanner', () => {
  it('mostra dentro da janela e some depois', () => {
    expect(shouldShowBanner(60, 120)).toBe(true);
    expect(shouldShowBanner(120, 120)).toBe(true);
    expect(shouldShowBanner(121, 120)).toBe(false);
  });
  it('mantém uma folga de 5 min após o horário', () => {
    expect(shouldShowBanner(-3, 120)).toBe(true);
    expect(shouldShowBanner(-10, 120)).toBe(false);
  });
});

describe('isImminent', () => {
  it('verdadeiro só dentro do lembrete', () => {
    expect(isImminent(10, 15)).toBe(true);
    expect(isImminent(15, 15)).toBe(true);
    expect(isImminent(16, 15)).toBe(false);
    expect(isImminent(-3, 15)).toBe(true);
    expect(isImminent(-10, 15)).toBe(false);
  });
});

describe('formatCountdown', () => {
  it('formata minutos, horas e "agora"', () => {
    expect(formatCountdown(0.5)).toBe('agora');
    expect(formatCountdown(1)).toBe('agora');
    expect(formatCountdown(-2)).toBe('agora');
    expect(formatCountdown(42)).toBe('42 min');
    expect(formatCountdown(90.4)).toBe('1h 30min');
    expect(formatCountdown(120)).toBe('2h');
    expect(formatCountdown(Infinity)).toBe('');
  });
});

describe('pickSoonest', () => {
  it('escolhe a mais próxima no futuro, ignora as bem passadas', () => {
    const rides = [
      { scheduled_for: iso(90) },
      { scheduled_for: iso(20) },
      { scheduled_for: iso(-30) },
    ];
    expect(pickSoonest(rides, NOW)).toBe(rides[1]);
  });
  it('null quando nada qualifica', () => {
    expect(pickSoonest([], NOW)).toBeNull();
    expect(pickSoonest([{ scheduled_for: iso(-60) }], NOW)).toBeNull();
  });
});
