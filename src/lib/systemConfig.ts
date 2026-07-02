// systemConfig — leitura de configuração dinâmica do backend (tabela
// public.system_config), com resolução por jurisdição, cache curto e fallback
// local seguro.
//
// Por que o fallback importa:
//   As migrations 0022/0023 podem ainda não ter sido aplicadas em produção
//   quando este código chegar via build. Se a tabela não existir ou a query
//   falhar, NUNCA deixamos o app sem valor — caímos nos DEFAULTS abaixo. Assim
//   a feature funciona com o padrão seguro mesmo antes de o admin configurar.
import { supabase } from './supabase';

// Padrões locais — espelham os seeds da migration 0022. São a última linha de
// defesa: usados quando a tabela não existe ainda ou a leitura falha.
export const CONFIG_DEFAULTS = {
  // P1: por quantos segundos a tela de chamada de corrida toca antes de expirar.
  ride_offer_timeout_seconds: 30,
  // P2: antecedência (min) com que uma corrida agendada SEM motorista aparece
  // na lista de disponíveis para os motoristas. "Antecedência dinâmica".
  scheduled_ride_lead_minutes: 60,
  // P2: antecedência (min) com que o banner fixo da corrida agendada JÁ
  // confirmada por mim começa a aparecer no mapa do motorista.
  scheduled_ride_banner_minutes: 120,
  // P2: antecedência (min) em que a agendada confirmada vira "iminente" —
  // dispara o alerta sonoro e o destaque de urgência no banner.
  scheduled_ride_reminder_minutes: 15,
} as const;

export type ConfigKey = keyof typeof CONFIG_DEFAULTS;

const TTL_MS = 60_000;
const cache = new Map<string, { value: unknown; at: number }>();

/** Valor padrão local (síncrono) — útil como estado inicial antes de a query voltar. */
export function getConfigDefault<K extends ConfigKey>(key: K): (typeof CONFIG_DEFAULTS)[K] {
  return CONFIG_DEFAULTS[key];
}

/**
 * Lê uma chave de configuração resolvendo "jurisdição específica → global".
 * Retorna sempre um valor: o configurado, ou o DEFAULT local em caso de falha.
 */
export async function getConfig<K extends ConfigKey>(
  key: K,
  jurisdiction: string = 'global'
): Promise<(typeof CONFIG_DEFAULTS)[K]> {
  const cacheKey = `${jurisdiction}:${key}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return hit.value as (typeof CONFIG_DEFAULTS)[K];
  }

  const fallback = CONFIG_DEFAULTS[key];

  try {
    const jurisdictions = jurisdiction === 'global' ? ['global'] : [jurisdiction, 'global'];
    const { data, error } = await supabase
      .from('system_config')
      .select('jurisdiction, value')
      .eq('key', key)
      .in('jurisdiction', jurisdictions);

    if (error || !data || data.length === 0) return fallback;

    // Jurisdição específica sobrescreve a global.
    const specific = data.find((r) => r.jurisdiction === jurisdiction);
    const global = data.find((r) => r.jurisdiction === 'global');
    const row = specific ?? global;
    const value = (row?.value ?? fallback) as (typeof CONFIG_DEFAULTS)[K];

    cache.set(cacheKey, { value, at: Date.now() });
    return value;
  } catch {
    return fallback;
  }
}

/** Limpa o cache de config (ex.: após o admin salvar uma alteração). */
export function clearConfigCache() {
  cache.clear();
}
