import { bucketScheduledRides, calendarDayDiff } from '../scheduleBuckets';
import type { RideRecord } from '../../types';

// Base fixa: quarta-feira 2026-07-01, 12:00 local.
const NOW = new Date(2026, 6, 1, 12, 0, 0);

// Cria um RideRecord mínimo com um scheduled_for a `days`/`hours` de distância.
let seq = 0;
function ride(offset: { days?: number; hours?: number } | null): RideRecord {
  seq += 1;
  let scheduled_for: string | undefined;
  if (offset === null) {
    scheduled_for = undefined;
  } else {
    const d = new Date(NOW);
    if (offset.days) d.setDate(d.getDate() + offset.days);
    if (offset.hours) d.setHours(d.getHours() + offset.hours);
    scheduled_for = d.toISOString();
  }
  return { id: `r${seq}`, scheduled_for } as unknown as RideRecord;
}

describe('calendarDayDiff', () => {
  it('conta dias de calendário ignorando a hora', () => {
    const base = new Date(2026, 6, 1, 23, 0, 0);
    const sameDayEarly = new Date(2026, 6, 1, 1, 0, 0);
    const nextDayEarly = new Date(2026, 6, 2, 1, 0, 0);
    expect(calendarDayDiff(sameDayEarly, base)).toBe(0);
    expect(calendarDayDiff(nextDayEarly, base)).toBe(1);
  });
});

describe('bucketScheduledRides', () => {
  it('separa hoje / amanhã / esta semana / próximas semanas', () => {
    const hojeMaisTarde = ride({ hours: 3 });   // ainda hoje
    const amanha = ride({ days: 1 });
    const em3dias = ride({ days: 3 });           // esta semana
    const em6dias = ride({ days: 6 });           // esta semana (limite)
    const em7dias = ride({ days: 7 });           // próximas semanas
    const em20dias = ride({ days: 20 });         // próximas semanas

    const b = bucketScheduledRides(
      [hojeMaisTarde, amanha, em3dias, em6dias, em7dias, em20dias],
      NOW
    );

    expect(b.today.map((r) => r.id)).toEqual([hojeMaisTarde.id]);
    expect(b.tomorrow.map((r) => r.id)).toEqual([amanha.id]);
    expect(b.thisWeek.map((r) => r.id)).toEqual([em3dias.id, em6dias.id]);
    expect(b.nextWeeks.map((r) => r.id)).toEqual([em7dias.id, em20dias.id]);
  });

  it('corrida já vencida no mesmo dia cai em "hoje"', () => {
    const b = bucketScheduledRides([ride({ hours: -2 })], NOW);
    expect(b.today).toHaveLength(1);
  });

  it('sem horário ou data inválida cai em "próximas semanas"', () => {
    const semData = ride(null);
    const invalido = { id: 'x', scheduled_for: 'lixo' } as unknown as RideRecord;
    const b = bucketScheduledRides([semData, invalido], NOW);
    expect(b.nextWeeks.map((r) => r.id)).toEqual([semData.id, 'x']);
  });
});
