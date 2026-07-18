export interface SurgeInfo {
  multiplier: number;
  label: string | null;
}

/**
 * Horário de pico — multiplicador por hora do dia (horário local do dispositivo).
 *
 * O preço do GoXL considera SÓ horário de pico (e local, indiretamente, via
 * taxas de aeroporto/porto — P6). A quantidade de motoristas GoXL online NÃO
 * influencia o cálculo — decisão de produto (evita "punir" o passageiro quando
 * a frota está pequena).
 */
function timeSurge(hourLocal: number): number {
  if (hourLocal >= 7 && hourLocal < 9) return 1.3;   // pico da manhã
  if (hourLocal >= 17 && hourLocal < 20) return 1.3; // pico da tarde/noite
  if (hourLocal >= 0 && hourLocal < 5) return 1.2;   // madrugada
  return 1.0;
}

/** Badge neutro de idioma (ex.: "⚡ 1.3×"). Só aparece quando há pico. */
function surgeLabel(multiplier: number): string | null {
  if (multiplier > 1.0) return `⚡ ${multiplier.toFixed(1)}×`;
  return null;
}

/**
 * Surge atual — baseado apenas em horário de pico. Continua assíncrono por
 * compatibilidade com os chamadores (o preço por local entra via taxas de
 * venue, P6, somadas ao total depois).
 */
export async function getSurgeInfo(): Promise<SurgeInfo> {
  const hour = new Date().getHours();
  const multiplier = Math.round(timeSurge(hour) * 10) / 10;
  return { multiplier, label: surgeLabel(multiplier) };
}

export function applyMultiplier(basePrice: number, multiplier: number): number {
  return Math.round(basePrice * multiplier * 100) / 100;
}
