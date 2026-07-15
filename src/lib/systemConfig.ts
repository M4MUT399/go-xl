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
  // P3: horas de direção acumuladas que exigem descanso obrigatório.
  driving_limit_hours: 12,
  // P3: horas de descanso contínuo que zeram o acúmulo de direção.
  rest_required_hours: 6,
  // P3: antecedência (min) do limite em que o motorista começa a ser avisado.
  driving_warn_minutes: 30,
  // Item 1: tolerância (min) de veículo PARADO antes de a contagem de direção
  // pausar. Paradas até este limite contam normalmente; o excedente de cada
  // parada longa não conta e volta a contar assim que o veículo se move.
  duty_idle_pause_minutes: 10,
  // P5: liga/desliga a cobrança de pedágio no preço. Desligado por padrão →
  // preserva o comportamento atual (pedágio = 0) até o admin habilitar.
  tolls_enabled: false,
  // P5: qual provider de pedágio usar ('mock' | 'google'). O mock calcula um
  // valor determinístico a partir dos parâmetros abaixo; 'google' fica como
  // stub até integrarmos a Routes API com toll info.
  toll_provider: 'mock',
  // P5: taxa fixa (USD) somada quando o pedágio está habilitado (provider mock).
  mock_toll_flat: 0,
  // P5: taxa por km (USD) somada quando o pedágio está habilitado (provider mock).
  mock_toll_per_km: 0,
  // P7: exige background check aprovado para o motorista ficar online. Desligado
  // por padrão → não muda o gate de disponibilidade atual.
  background_check_required: false,
  // P7: qual provider de background check usar ('mock' | 'stripe_identity').
  background_check_provider: 'mock',
  // P7: validade (dias) de um background check aprovado antes de exigir renovação.
  background_check_valid_days: 365,
  // ── Feature flags de rollout gradual (câmera / navegação / jornada) ──────────
  // Bloco 1: roteia TODA atualização de câmera pelo CameraController (validação
  // de coordenada + clamp de zoom + fallback). Ligado por padrão — é correção do
  // bug crítico de zoom-out no iOS; desligar volta ao comportamento legado.
  camera_controller_enabled: true,
  // Bloco 3: modo course-up (mapa gira conforme o deslocamento) na navegação do
  // motorista. Ligado por padrão (já é o comportamento atual da tela de navegação).
  nav_course_up_enabled: true,
  // Bloco 2: contagem de jornada pela máquina de estados baseada em MOVIMENTO
  // (persistida por timestamps, sobrevive a kill/reboot). DESLIGADO por padrão:
  // muda regra de compliance (limiar 8 km/h + histerese) — habilitar por
  // jurisdição só após validação. Off → mantém o tracker de ociosidade atual.
  duty_movement_v2_enabled: false,
  // Dispatch PR-a: fila FIFO de ofertas no app do motorista. Corrige o bug em que
  // uma 2ª solicitação (P2) SOBRESCREVIA/lapidava a 1ª (P1) no slot único —
  // matando as duas corridas. Com a flag LIGADA o motorista mantém várias ofertas
  // válidas ao mesmo tempo e atende uma por vez (FIFO). DESLIGADO por padrão →
  // mantém o comportamento de slot único legado até o rollout gradual.
  dispatch_multi_offer_fix: false,
  // Dispatch PR-b: motor estilo Uber no SERVIDOR (Edge Function `dispatch-engine`
  // + tabelas trip_requests/ride_offers como fonte da verdade). Máquina de estados
  // por pedido, oferta sequencial por ETA, aceite atômico, re-dispatch e expansão
  // de raio. DESLIGADO por padrão → o fluxo legado (leque via send-ride-push)
  // segue intacto; ligar por jurisdição só após validação.
  dispatch_engine_v2: false,
  // PR-b: timer (s) de cada oferta antes de expirar e passar ao próximo motorista.
  dispatch_offer_ttl_seconds: 15,
  // PR-b: 'sequential' (uma oferta por vez, padrão) ou 'broadcast' (leque a todos).
  dispatch_mode: 'sequential',
  // PR-b: raio inicial de busca de motoristas (km).
  dispatch_radius_initial_km: 3,
  // PR-b: incremento de raio a cada expansão quando ninguém aceita (km).
  dispatch_radius_step_km: 2,
  // PR-b: raio máximo (km) antes de desistir → NO_DRIVERS.
  dispatch_radius_max_km: 15,
  // PR-b: tempo global (s) do pedido antes de desistir → NO_DRIVERS.
  dispatch_global_timeout_seconds: 300,
  // Bloco 1 (compliance TNC F.S. 627.748): liga a máquina de estados P0-P3
  // (src/lib/driverPeriodMachine.ts) + acumulador de milhagem por período
  // (src/lib/driverPeriodMileage.ts) via a camada de wiring impura. DESLIGADO
  // por padrão — enquanto off, nada é escrito em driver_period_transitions/
  // driver_period_daily_mileage; habilitar por jurisdição só após validação.
  period_tracking_v1_enabled: false,
  // Bloco 2 (compliance TNC F.S. 627.748): anos de retenção de
  // driver_period_transitions antes de a partição mensal correspondente ser
  // purgada (DROP TABLE da partição — ver migration 0057). Piso técnico de 1
  // ano é sempre aplicado na própria função de purge, mesmo que este valor
  // seja configurado abaixo disso por engano.
  period_retention_years: 5,
  // Bloco 2 (compliance TNC F.S. 627.748): liga as Edge Functions
  // administrativas admin-telematics-claims (claims lookup para a
  // seguradora) e admin-telematics-export (export mensal de milhagem por
  // período). DESLIGADO por padrão — habilitar por jurisdição só após
  // validação. NÃO afeta a manutenção de partição/retenção em si, que roda
  // sempre independente desta flag (é infraestrutura invisível ao usuário).
  period_audit_v1_enabled: false,
  // Bloco 3 (compliance TNC F.S. 627.748): liga os gates de onboarding no
  // SERVIDOR (função driver_can_go_online() + trigger em driver_locations —
  // ver migration 0059): desqualificação, recheck trienal e disclosure legal.
  // DESLIGADO por padrão — enquanto off, driver_can_go_online() sempre
  // devolve true e o gate de disponibilidade fica como estava antes do
  // Bloco 3 (só verification_status + Stripe Connect, migration 0038).
  onboarding_gates_v1_enabled: false,
  // Bloco 3: TETO de anos entre reapurações de background check, independente
  // da validade operacional (`background_check_valid_days`, P7). Ver
  // ambiguidade documentada em src/lib/driverOnboardingGate.ts — as duas
  // regras são independentes; a mais restritiva prevalece.
  background_check_recheck_years: 3,
  // Bloco 3: exige aceite do disclosure legal (driver_disclosure_acceptances)
  // para o motorista ficar online. DESLIGADO por padrão.
  driver_disclosure_required: false,
  // Bloco 3: versão vigente do texto do disclosure legal. Trocar este valor
  // (por jurisdição) faz o motorista precisar aceitar de novo — aceites de
  // versões antigas continuam no histórico (tabela é append-only).
  driver_disclosure_version: '1',
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

/**
 * Lê uma chave de configuração ESTRUTURADA (objeto/lista em jsonb) que não faz
 * parte do mapa escalar CONFIG_DEFAULTS. Usa a mesma resolução "jurisdição
 * específica → global" e sempre devolve um valor: o configurado ou o `fallback`.
 *
 * Motivação: features como geofences de taxas (P6) guardam uma LISTA de zonas
 * em system_config. Manter isso fora de CONFIG_DEFAULTS evita poluir a tipagem
 * escalar e permite fallback tipado explícito por chamada.
 */
export async function getConfigValue<T>(
  key: string,
  fallback: T,
  jurisdiction: string = 'global'
): Promise<T> {
  const cacheKey = `${jurisdiction}:${key}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return hit.value as T;
  }

  try {
    const jurisdictions = jurisdiction === 'global' ? ['global'] : [jurisdiction, 'global'];
    const { data, error } = await supabase
      .from('system_config')
      .select('jurisdiction, value')
      .eq('key', key)
      .in('jurisdiction', jurisdictions);

    if (error || !data || data.length === 0) return fallback;

    const specific = data.find((r) => r.jurisdiction === jurisdiction);
    const global = data.find((r) => r.jurisdiction === 'global');
    const row = specific ?? global;
    const value = (row?.value ?? fallback) as T;

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
