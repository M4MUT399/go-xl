import { supabase } from './supabase';

export interface SurgeInfo {
  multiplier: number;
  label: string | null;
}

/** Horários de pico — retorna multiplicador por hora do dia (ET). */
function timeSurge(hourLocal: number): number {
  if (hourLocal >= 7 && hourLocal < 9) return 1.3;   // manhã
  if (hourLocal >= 17 && hourLocal < 20) return 1.3;  // tarde/noite
  if (hourLocal >= 0 && hourLocal < 5) return 1.2;    // madrugada
  return 1.0;
}

/** Multiplicador por escassez de motoristas online. */
function demandSurge(onlineCount: number): number {
  if (onlineCount === 0) return 1.6;
  if (onlineCount < 3) return 1.4;
  if (onlineCount < 6) return 1.2;
  return 1.0;
}

function surgeLabel(multiplier: number): string | null {
  if (multiplier >= 1.5) return `⚡ ${multiplier.toFixed(1)}x — Muito alta demanda`;
  if (multiplier >= 1.3) return `⚡ ${multiplier.toFixed(1)}x — Alta demanda`;
  if (multiplier > 1.0) return `⚡ ${multiplier.toFixed(1)}x — Demanda elevada`;
  return null;
}

export async function getSurgeInfo(): Promise<SurgeInfo> {
  const { count } = await supabase
    .from('driver_locations')
    .select('driver_id', { count: 'exact', head: true })
    .eq('is_online', true);

  const onlineCount = count ?? 0;
  const hour = new Date().getHours();

  const multiplier = Math.max(timeSurge(hour), demandSurge(onlineCount));
  const rounded = Math.round(multiplier * 10) / 10;

  return { multiplier: rounded, label: surgeLabel(rounded) };
}

export function applyMultiplier(basePrice: number, multiplier: number): number {
  return Math.round(basePrice * multiplier * 100) / 100;
}
