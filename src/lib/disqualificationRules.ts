// disqualificationRules — avalia achados ESTRUTURADOS/CATEGORIZADOS de um
// background check contra as regras de desqualificação do motorista (Bloco 3,
// compliance TNC F.S. 627.748).
//
// PRINCÍPIO DE PRIVACIDADE (mesma regra dura de backgroundCheck.ts):
//   Esta função NUNCA recebe o relatório bruto do provider (nem PII). Recebe
//   só booleans/contagens/datas já categorizadas — o mesmo espírito do campo
//   `driver_background_checks.result jsonb`, que hoje guarda só um resumo não
//   sensível (ex.: `{"checks":["mvr","criminal"]}`). Quem monta o
//   `DisqualificationFindings` (Edge Function/webhook do provider) é
//   responsável por nunca colocar texto livre do laudo aqui dentro.
//
// AMBIGUIDADE DOCUMENTADA (regra do COMANDO: "documente e pergunte antes de
// mudar regra de negócio" — aqui não há regra anterior para mudar, mas a
// F.S. 627.748 é focada em SEGURO, não define uma lista de ofensas
// desqualificantes). As categorias e limiares abaixo são uma INTERPRETAÇÃO
// RAZOÁVEL modelada nos padrões usuais do setor de TNC (Uber/Lyft-style:
// bane vitalício para crime violento/sexual/tráfico humano/predador sexual
// registrado/CNH suspensa-cassada; limiar de contagem para as demais
// categorias). NÃO é uma citação de uma subseção específica do estatuto —
// precisa de revisão jurídica antes de habilitar em produção
// (`onboarding_gates_v1_enabled`, default OFF). Os limiares são configuráveis
// por jurisdição via system_config (ver migration 0059), então essa
// interpretação pode ser ajustada sem redeploy.

/**
 * Achados categorizados (não sensíveis) usados para decidir desqualificação.
 * As categorias "*ConvictionDates"/"*ViolationDates" trazem uma data ISO por
 * ocorrência — a contagem dentro da janela configurável é feita aqui, não por
 * quem monta o objeto, para manter a regra de "quantos nos últimos N anos"
 * centralizada e testável num só lugar.
 */
export type DisqualificationFindings = {
  // ── Categorias de bane vitalício — desqualificam SEMPRE, sem janela/limiar. ──
  violentCrimeConviction: boolean;
  sexOffenseConviction: boolean;
  traffickingOrExploitationConviction: boolean;
  registeredSexOffender: boolean;
  licenseSuspendedOrRevoked: boolean;
  // ── Categorias de limiar configurável — uma data ISO por ocorrência. ──
  felonyConvictionDates: string[];
  duiConvictionDates: string[];
  majorMovingViolationDates: string[];
};

/** Findings "limpos" — nenhuma ocorrência em nenhuma categoria. Útil em testes/UI. */
export const EMPTY_DISQUALIFICATION_FINDINGS: DisqualificationFindings = {
  violentCrimeConviction: false,
  sexOffenseConviction: false,
  traffickingOrExploitationConviction: false,
  registeredSexOffender: false,
  licenseSuspendedOrRevoked: false,
  felonyConvictionDates: [],
  duiConvictionDates: [],
  majorMovingViolationDates: [],
};

/** Limiares configuráveis (jurisdição → system_config, ver migration 0059). */
export type DisqualificationThresholds = {
  /** Janela (anos) em que uma condenação por crime grave (felony) conta. */
  felonyLookbackYears: number;
  /** Quantas condenações por felony na janela são TOLERADAS antes de desqualificar (>). */
  felonyMaxCount: number;
  duiLookbackYears: number;
  duiMaxCount: number;
  movingViolationLookbackYears: number;
  movingViolationMaxCount: number;
};

/**
 * Defaults — interpretação razoável (ver comentário de topo): ANY condenação
 * por felony ou DUI na janela já desqualifica (max=0, ou seja >0 bloqueia);
 * violações graves de trânsito toleram até 2 na janela (3+ desqualifica).
 */
export const DEFAULT_DISQUALIFICATION_THRESHOLDS: DisqualificationThresholds = {
  felonyLookbackYears: 7,
  felonyMaxCount: 0,
  duiLookbackYears: 7,
  duiMaxCount: 0,
  movingViolationLookbackYears: 3,
  movingViolationMaxCount: 2,
};

export type DisqualificationReason =
  | 'violent_crime_conviction'
  | 'sex_offense_conviction'
  | 'trafficking_or_exploitation_conviction'
  | 'registered_sex_offender'
  | 'license_suspended_or_revoked'
  | 'felony_convictions_threshold'
  | 'dui_convictions_threshold'
  | 'major_moving_violations_threshold';

export type DisqualificationResult = {
  disqualified: boolean;
  /** TODOS os motivos encontrados (não só o primeiro) — para audit trail/admin. */
  reasons: DisqualificationReason[];
};

/** Quantas datas (ISO) caem dentro dos últimos `years` anos a partir de `now`. Datas inválidas são ignoradas. */
function countWithinYears(dates: readonly string[], years: number, now: Date): number {
  const cutoff = new Date(now);
  cutoff.setFullYear(cutoff.getFullYear() - years);
  const cutoffMs = cutoff.getTime();
  return dates.reduce((count, d) => {
    const t = new Date(d).getTime();
    return !Number.isNaN(t) && t >= cutoffMs ? count + 1 : count;
  }, 0);
}

/**
 * evaluateDisqualification — decide se os achados desqualificam o motorista.
 * Pura e determinística: mesma entrada + mesmo `now` → mesma saída. Devolve
 * TODOS os motivos aplicáveis (não para no primeiro), para dar contexto
 * completo a quem revisa (admin/legal), não só um booleano de bloqueio.
 */
export function evaluateDisqualification(
  findings: DisqualificationFindings,
  thresholds: DisqualificationThresholds = DEFAULT_DISQUALIFICATION_THRESHOLDS,
  now: Date = new Date()
): DisqualificationResult {
  const reasons: DisqualificationReason[] = [];

  if (findings.violentCrimeConviction) reasons.push('violent_crime_conviction');
  if (findings.sexOffenseConviction) reasons.push('sex_offense_conviction');
  if (findings.traffickingOrExploitationConviction) reasons.push('trafficking_or_exploitation_conviction');
  if (findings.registeredSexOffender) reasons.push('registered_sex_offender');
  if (findings.licenseSuspendedOrRevoked) reasons.push('license_suspended_or_revoked');

  if (countWithinYears(findings.felonyConvictionDates, thresholds.felonyLookbackYears, now) > thresholds.felonyMaxCount) {
    reasons.push('felony_convictions_threshold');
  }
  if (countWithinYears(findings.duiConvictionDates, thresholds.duiLookbackYears, now) > thresholds.duiMaxCount) {
    reasons.push('dui_convictions_threshold');
  }
  if (countWithinYears(findings.majorMovingViolationDates, thresholds.movingViolationLookbackYears, now) > thresholds.movingViolationMaxCount) {
    reasons.push('major_moving_violations_threshold');
  }

  return { disqualified: reasons.length > 0, reasons };
}
