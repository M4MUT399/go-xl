// scheduledRides — helpers puros de tempo para corridas agendadas (P2).
//
// Isolados de React/RN de propósito: toda a matemática de "quanto falta",
// "já deve mostrar o banner?" e "já é iminente?" vive aqui, testável sem
// montar componente nem mockar timer nativo.

/**
 * Minutos (fracionários) do agora até o horário agendado.
 * Negativo se o horário já passou. `now` injetável para testes determinísticos.
 */
export function minutesUntil(scheduledForISO: string | null | undefined, now: Date = new Date()): number {
  if (!scheduledForISO) return Infinity;
  const target = new Date(scheduledForISO).getTime();
  if (Number.isNaN(target)) return Infinity;
  return (target - now.getTime()) / 60_000;
}

/**
 * O banner fixo deve aparecer? Verdadeiro quando o horário está dentro da
 * janela `bannerMinutes` à frente. Uma vez dentro da janela, o banner
 * permanece indefinidamente — mesmo com a corrida já atrasada — até o
 * motorista tocar para iniciar a rota (o que muda o status da corrida e a
 * remove da consulta em `useUpcomingScheduledRide`). Não há mais corte por
 * tempo decorrido: a elegibilidade é 100% governada pelo `status='scheduled'`.
 */
export function shouldShowBanner(mins: number, bannerMinutes: number): boolean {
  return mins <= bannerMinutes;
}

/** Já é iminente? (dispara som + destaque de urgência). Permanece iminente mesmo atrasada, até o motorista agir. */
export function isImminent(mins: number, reminderMinutes: number): boolean {
  return mins <= reminderMinutes;
}

/**
 * Contagem regressiva do banner, em forma de DADO e não de texto — quem
 * renderiza é que resolve o idioma com t(). Antes esta função devolvia string
 * pronta, e o "agora" em português vazava para a interface em inglês.
 *
 * Passado o horário, a corrida NÃO vira um "agora" eterno: contamos o atraso,
 * porque um agendamento vencido há 40 min é uma informação diferente de um que
 * vence neste instante — e é a que o motorista precisa ver.
 *   Ex.: 90.4 → hm(1,30) · 42 → min(42) · 0.5 → now · -40 → late(40).
 */
export type Countdown =
  | { kind: 'none' }
  | { kind: 'now' }
  | { kind: 'late'; min: number }
  | { kind: 'min'; min: number }
  | { kind: 'hm'; h: number; m: number };

export function countdownFor(mins: number): Countdown {
  if (!Number.isFinite(mins)) return { kind: 'none' };
  const m = Math.round(mins);
  if (m <= -2) return { kind: 'late', min: -m };
  if (m <= 1) return { kind: 'now' };
  if (m < 60) return { kind: 'min', min: m };
  return { kind: 'hm', h: Math.floor(m / 60), m: m % 60 };
}

/**
 * Escolhe a corrida agendada mais "urgente" (mais próxima do agora, para
 * frente ou para trás no tempo) de uma lista já confirmada por mim. Retorna
 * null se a lista estiver vazia.
 *
 * Corridas atrasadas continuam qualificando (sem corte por tempo decorrido)
 * — a lista de entrada já vem filtrada por `status='scheduled'` na consulta,
 * então uma corrida só some daqui quando o motorista de fato iniciar a rota
 * (muda o status). Comparamos por distância absoluta ao agora: entre uma
 * corrida já atrasada e outra ainda no futuro, vence a que estiver mais perto
 * do momento atual — é a que precisa da atenção do motorista primeiro.
 */
export function pickSoonest<T extends { scheduled_for?: string | null }>(
  rides: T[],
  now: Date = new Date()
): T | null {
  let best: T | null = null;
  let bestAbsMins = Infinity;
  for (const r of rides) {
    const mins = minutesUntil(r.scheduled_for, now);
    const absMins = Math.abs(mins);
    if (absMins < bestAbsMins) {
      best = r;
      bestAbsMins = absMins;
    }
  }
  return best;
}
