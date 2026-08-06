// scheduleBuckets — agrupa corridas agendadas por PROXIMIDADE de data para a
// aba "Agenda" do motorista (item 5): hoje / amanhã / esta semana / próximas
// semanas. Puro e testável, sem dependência de React.
//
// Janela ROLANTE (não semana de calendário) para ser útil ao motorista e evitar
// bordas confusas (ex.: no sábado "esta semana" ficaria quase vazia):
//   • hoje           → mesmo dia de calendário (ou já vencida no dia)
//   • amanhã         → dia seguinte
//   • esta semana    → de 2 a 6 dias à frente (resto dos próximos 7 dias)
//   • próximas semanas → 7+ dias à frente (ou sem horário/data inválida)

import type { RideRecord } from '../types';

export type ScheduleBucketKey = 'today' | 'tomorrow' | 'thisWeek' | 'nextWeeks';

export type ScheduleBuckets = {
  today: RideRecord[];
  tomorrow: RideRecord[];
  thisWeek: RideRecord[];
  nextWeeks: RideRecord[];
};

/** Diferença em DIAS de calendário entre duas datas (ignora a hora do dia). */
export function calendarDayDiff(target: Date, base: Date): number {
  const a = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  const b = new Date(base.getFullYear(), base.getMonth(), base.getDate());
  return Math.round((a.getTime() - b.getTime()) / 86_400_000);
}

export function bucketScheduledRides(
  rides: RideRecord[],
  now: Date = new Date()
): ScheduleBuckets {
  const buckets: ScheduleBuckets = { today: [], tomorrow: [], thisWeek: [], nextWeeks: [] };

  for (const ride of rides) {
    if (!ride.scheduled_for) {
      buckets.nextWeeks.push(ride);
      continue;
    }
    const d = new Date(ride.scheduled_for);
    if (Number.isNaN(d.getTime())) {
      buckets.nextWeeks.push(ride);
      continue;
    }
    const diff = calendarDayDiff(d, now);
    if (diff <= 0) buckets.today.push(ride);
    else if (diff === 1) buckets.tomorrow.push(ride);
    else if (diff <= 6) buckets.thisWeek.push(ride);
    else buckets.nextWeeks.push(ride);
  }

  return buckets;
}
