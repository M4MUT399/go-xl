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
 * janela `bannerMinutes` à frente e ainda não passou de uma folga de 5 min
 * (mantém o banner um pouco após o horário, caso o motorista se atrase).
 */
export function shouldShowBanner(mins: number, bannerMinutes: number): boolean {
  return mins <= bannerMinutes && mins >= -5;
}

/** Já é iminente? (dispara som + destaque de urgência). Só antes do horário. */
export function isImminent(mins: number, reminderMinutes: number): boolean {
  return mins <= reminderMinutes && mins >= -5;
}

/**
 * Rótulo curto de contagem regressiva para o banner.
 * Ex.: 90.4 → "1h 30min"; 42 → "42 min"; 0.5 → "agora"; -2 → "agora".
 */
export function formatCountdown(mins: number): string {
  if (!Number.isFinite(mins)) return '';
  const m = Math.round(mins);
  if (m <= 1) return 'agora';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}min`;
}

/**
 * Escolhe a corrida agendada mais próxima (menor `scheduled_for` no futuro/folga)
 * de uma lista já confirmada por mim. Retorna null se nenhuma qualificar.
 */
export function pickSoonest<T extends { scheduled_for?: string | null }>(
  rides: T[],
  now: Date = new Date()
): T | null {
  let best: T | null = null;
  let bestMins = Infinity;
  for (const r of rides) {
    const mins = minutesUntil(r.scheduled_for, now);
    if (mins >= -5 && mins < bestMins) {
      best = r;
      bestMins = mins;
    }
  }
  return best;
}
