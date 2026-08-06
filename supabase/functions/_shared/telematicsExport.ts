// Bloco 2 (compliance F.S. 627.748) — lógica PURA de apoio ao log auditável e
// aos relatórios de compliance: resolução do mês-alvo do export mensal para a
// seguradora (underwriter), montagem do CSV a partir dos rollups diários, e a
// busca de "qual período estava vigente num instante" usada pelo endpoint de
// claims lookup administrativo.
//
// Deliberadamente sem NENHUM import do Deno nem do supabase-js: só
// string/array/date puros, para poder rodar tanto dentro da Edge Function
// (Deno, supabase/functions/admin-telematics-*) quanto sob o harness de teste
// Node/jest deste repo (ver supabase/functions/_shared/__tests__/) — UMA
// fonte de verdade só, testada uma vez, sem duplicar a lógica entre runtimes.
// Mesmo espírito de src/lib/driverPeriodMachine.ts no Bloco 1: núcleo puro
// primeiro, wiring impuro (Edge Function, chamadas de rede) depois.

export interface DailyMileageRow {
  driver_id: string;
  day: string; // 'YYYY-MM-DD'
  p1_miles: number;
  p2_miles: number;
  p3_miles: number;
  estimated_miles: number;
}

export interface ExportMonthRange {
  /** Primeiro dia do mês exportado, 'YYYY-MM-DD' (inclusive). */
  start: string;
  /** Primeiro dia do mês SEGUINTE, 'YYYY-MM-DD' (exclusivo — usar como `< end`). */
  end: string;
  /** Rótulo do mês exportado, 'YYYY-MM'. */
  label: string;
}

export interface PeriodTransitionRow {
  id: string;
  driver_id: string;
  trip_id: string | null;
  from_period: string;
  to_period: string;
  reason: string;
  at_ms: number;
  lat: number | null;
  lng: number | null;
  cumulative_miles_at_transition: number | null;
  mileage_estimated: boolean;
}

/**
 * Resolve o mês-alvo do export mensal para a underwriter.
 *
 * - Sem `requestedMonth`: assume o MÊS ANTERIOR completo em relação a `now`
 *   (comportamento do cron mensal — no dia 1, o mês anterior já fechou por
 *   completo; é o único mês "definitivo" disponível pra exportar).
 * - Com `requestedMonth` ('YYYY-MM'): usa exatamente esse mês (export sob
 *   demanda pelo admin — ex.: reexportar um mês específico para auditoria).
 *
 * Retorna limites [start, end) em UTC — `end` é o primeiro dia do mês
 * SEGUINTE, propositalmente exclusivo, para casar com
 * `day >= start and day < end` na query em driver_period_daily_mileage
 * (evita o erro clássico de fronteira de mês com `<=` e datas parciais).
 */
export function resolveExportMonth(now: Date, requestedMonth?: string | null): ExportMonthRange {
  let year: number;
  let month: number; // 1-12

  if (requestedMonth) {
    const m = /^(\d{4})-(\d{2})$/.exec(requestedMonth.trim());
    if (!m) throw new Error(`mês inválido: "${requestedMonth}" (esperado YYYY-MM)`);
    year = Number(m[1]);
    month = Number(m[2]);
    if (month < 1 || month > 12) throw new Error(`mês inválido: "${requestedMonth}" (mês fora de 01-12)`);
  } else {
    year = now.getUTCFullYear();
    month = now.getUTCMonth() + 1; // 1-12, mês ATUAL de `now`
    month -= 1; // mês ANTERIOR
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }

  const pad = (n: number) => String(n).padStart(2, '0');
  const start = `${year}-${pad(month)}-01`;

  let endYear = year;
  let endMonth = month + 1;
  if (endMonth === 13) {
    endMonth = 1;
    endYear += 1;
  }
  const end = `${endYear}-${pad(endMonth)}-01`;
  const label = `${year}-${pad(month)}`;

  return { start, end, label };
}

const CSV_HEADER = 'driver_id,day,p1_miles,p2_miles,p3_miles,estimated_miles,total_miles';

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Monta o CSV mensal para a seguradora a partir dos rollups diários
 * (driver_period_daily_mileage) — NUNCA soma a trilha de transições inteira
 * (ver comentário na migration 0056: os rollups já são a fonte pensada para
 * este tipo de relatório).
 *
 * Decisão de privacidade documentada para review: a exportação NÃO inclui
 * nome/telefone/e-mail do motorista, só `driver_id` (uuid pseudonimizado) —
 * a seguradora consegue cruzar isso com o driver_id de uma reivindicação
 * específica sem que o arquivo em si carregue PII direta. Ver
 * docs/telematics-spec.md.
 */
export function buildDailyMileageCsv(rows: DailyMileageRow[]): string {
  const lines = [CSV_HEADER];
  for (const r of rows) {
    const total = round2(r.p1_miles + r.p2_miles + r.p3_miles);
    lines.push(
      [r.driver_id, r.day, round2(r.p1_miles), round2(r.p2_miles), round2(r.p3_miles), round2(r.estimated_miles), total].join(',')
    );
  }
  return lines.join('\n') + '\n';
}

/**
 * Dado o histórico de transições de UM motorista (qualquer ordem) e um
 * instante `atMs` (epoch ms — o momento do incidente/reivindicação), retorna
 * a transição cujo `to_period` estava VIGENTE naquele instante: a pergunta
 * central de um claims lookup ("que cobertura valia no momento do
 * acidente?").
 *
 * Regra: a transição vigente é a de MAIOR `at_ms` que ainda seja <= atMs (a
 * última mudança de período antes de, ou exatamente n, o instante do
 * incidente — limite inclusivo). Se não houver nenhuma transição <= atMs,
 * não há registro suficiente para responder — retorna null (o chamador
 * decide o fallback; a Edge Function trata null como "sem dado", nunca
 * presume P0 silenciosamente).
 */
export function findActivePeriodAtTimestamp(
  transitions: PeriodTransitionRow[],
  atMs: number
): PeriodTransitionRow | null {
  let best: PeriodTransitionRow | null = null;
  for (const t of transitions) {
    if (t.at_ms <= atMs && (best === null || t.at_ms > best.at_ms)) {
      best = t;
    }
  }
  return best;
}
