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
  it('mostra dentro da janela e não mostra antes dela', () => {
    expect(shouldShowBanner(60, 120)).toBe(true);
    expect(shouldShowBanner(120, 120)).toBe(true);
    expect(shouldShowBanner(121, 120)).toBe(false);
  });
  it('permanece indefinidamente após o horário — só some quando o status da corrida muda', () => {
    expect(shouldShowBanner(-3, 120)).toBe(true);
    expect(shouldShowBanner(-10, 120)).toBe(true);
    expect(shouldShowBanner(-500, 120)).toBe(true);
  });
});

describe('isImminent', () => {
  it('verdadeiro dentro do lembrete e permanece iminente mesmo atrasada', () => {
    expect(isImminent(10, 15)).toBe(true);
    expect(isImminent(15, 15)).toBe(true);
    expect(isImminent(16, 15)).toBe(false);
    expect(isImminent(-3, 15)).toBe(true);
    expect(isImminent(-10, 15)).toBe(true);
    expect(isImminent(-500, 15)).toBe(true);
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
  it('escolhe a mais próxima no futuro', () => {
    const rides = [
      { scheduled_for: iso(90) },
      { scheduled_for: iso(20) },
      { scheduled_for: iso(-30) },
    ];
    expect(pickSoonest(rides, NOW)).toBe(rides[1]);
  });
  it('mesmo bem atrasada, continua qualificando (some só quando o status muda, fora daqui)', () => {
    expect(pickSoonest([{ scheduled_for: iso(-60) }], NOW)).toEqual({ scheduled_for: iso(-60) });
  });
  it('null quando a lista está vazia', () => {
    expect(pickSoonest([], NOW)).toBeNull();
  });
});
