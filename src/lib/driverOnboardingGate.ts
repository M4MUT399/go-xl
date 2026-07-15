// driverOnboardingGate — unifica em UMA função pura todos os gates de
// elegibilidade "pode ficar online" do motorista (Bloco 3, compliance TNC
// F.S. 627.748): verificação de identidade → background check (válido + não
// desqualificado + recheck em dia) → Stripe Connect (repasse) → aceite do
// disclosure legal.
//
// Por que centralizar: antes desta função cada gate era checado num `if`
// separado dentro de DriverHomeScreen.handleOnlineChange (bom pra UX — dá o
// aviso certo — ruim como fonte única de verdade da REGRA). Esta função pura
// é a MESMA regra usada em dois lugares:
//   1) pelo hook/tela do motorista, pra decidir qual aviso mostrar;
//   2) como especificação de referência pra função SQL driver_can_go_online()
//      (migration 0059) que o Postgres aplica de verdade no servidor via
//      trigger em driver_locations — o client nunca é a autoridade final.
// As duas implementações (TS aqui, SQL lá) precisam concordar na MESMA
// ordem/regra; qualquer mudança de regra aqui deve ser espelhada na migration
// (documentado também no cabeçalho da 0059).
//
// AMBIGUIDADE DOCUMENTADA — recheck trienal × validade operacional (P7):
//   `background_check_valid_days` (default 365, já existente desde o P7) é a
//   validade OPERACIONAL do check: quando vence, `status='clear'` deixa de
//   contar como válido (via `isCheckValid`/`canDriverGoOnline`) e o motorista
//   já cai fora até renovar. `backgroundCheckRecheckYears` (Bloco 3, novo,
//   default 3) é um TETO INDEPENDENTE e mais longo, exigido pelo COMANDO
//   ("recheck trienal"): mesmo que o provider/jurisdição configure uma
//   validade operacional mais longa que 3 anos (ou nenhuma expiração), o
//   motorista ainda precisa refazer o check pelo menos a cada N anos. As duas
//   regras são independentes e computadas ao vivo (sem estado sincronizado
//   por cron) — a mais restritiva prevalece porque `evaluateOnboardingGate`
//   acumula todos os motivos aplicáveis.

import { canDriverGoOnline, type BackgroundCheckRecord } from './backgroundCheck';
import {
  evaluateDisqualification,
  DEFAULT_DISQUALIFICATION_THRESHOLDS,
  type DisqualificationFindings,
  type DisqualificationThresholds,
} from './disqualificationRules';

export type OnboardingGateReason =
  | 'verification_pending'
  | 'background_check_required'
  | 'background_check_disqualified'
  | 'background_check_recheck_due'
  | 'payout_setup_incomplete'
  | 'disclosure_not_accepted';

export type OnboardingGateInput = {
  /** `profiles.verification_status` — precisa ser 'approved'. */
  verificationStatus: string | null | undefined;
  /** Config `background_check_required` resolvida pra jurisdição. */
  backgroundCheckRequired: boolean;
  backgroundCheckRecord: BackgroundCheckRecord | null | undefined;
  /**
   * Achados categorizados (não sensíveis) — usado por QUEM COMPUTA o veredito
   * (ex.: um futuro fluxo de revisão admin) para decidir e então PERSISTIR
   * `driver_background_checks.disqualified`/`disqualification_reasons` (ver
   * "DECISÃO DE DESIGN" na migration 0059). null/undefined = nenhum achado
   * ainda apurado. Ignorado quando `backgroundCheckDisqualified` é informado.
   */
  disqualificationFindings: DisqualificationFindings | null | undefined;
  disqualificationThresholds?: DisqualificationThresholds;
  /**
   * Veredito JÁ PERSISTIDO (`driver_background_checks.disqualified`) — usado
   * pelo APP DO MOTORISTA (e por `driver_can_go_online()` no SQL), que só LÊ o
   * veredito em vez de reavaliar achados no cliente. Quando informado (valor
   * boolean, não undefined), tem prioridade sobre `disqualificationFindings` e
   * evita a reavaliação — mesmo princípio da migration 0059: uma única fonte
   * de verdade computada uma vez, lida em todo lugar.
   */
  backgroundCheckDisqualified?: boolean;
  /** Config `background_check_recheck_years` resolvida pra jurisdição (Bloco 3). */
  backgroundCheckRecheckYears: number;
  stripeChargesEnabled: boolean;
  stripePayoutsEnabled: boolean;
  /** Config `driver_disclosure_required` resolvida pra jurisdição (Bloco 3). */
  disclosureRequired: boolean;
  /** O motorista já tem uma linha de aceite pra versão vigente do disclosure. */
  disclosureAccepted: boolean;
  now?: Date;
};

export type OnboardingGateResult = {
  canGoOnline: boolean;
  /** TODOS os motivos de bloqueio encontrados (não só o primeiro) — audit/admin. */
  reasons: OnboardingGateReason[];
};

/**
 * isBackgroundCheckRecheckDue — o motorista precisa refazer o check porque já
 * se passaram `recheckYears` desde a última apuração (`checkedAt`)? Pura,
 * independente de `isCheckValid`/`expiresAt` (ver ambiguidade documentada
 * acima). Sem `checkedAt` ainda não é "recheck atrasado" — é "nunca feito",
 * já coberto por `background_check_required` via `canDriverGoOnline`.
 */
export function isBackgroundCheckRecheckDue(
  record: BackgroundCheckRecord | null | undefined,
  recheckYears: number,
  now: Date = new Date()
): boolean {
  if (!record?.checkedAt) return false;
  const checkedMs = new Date(record.checkedAt).getTime();
  if (Number.isNaN(checkedMs)) return false;
  const cutoff = new Date(now);
  cutoff.setFullYear(cutoff.getFullYear() - recheckYears);
  return checkedMs < cutoff.getTime();
}

/**
 * evaluateOnboardingGate — decide se o motorista pode ficar online, juntando
 * todos os gates legais/operacionais numa só chamada. Pura e determinística:
 * mesma entrada + mesmo `now` → mesma saída. Acumula TODOS os motivos
 * aplicáveis (não para no primeiro) pra dar contexto completo.
 */
export function evaluateOnboardingGate(input: OnboardingGateInput): OnboardingGateResult {
  const now = input.now ?? new Date();
  const reasons: OnboardingGateReason[] = [];

  if (input.verificationStatus !== 'approved') {
    reasons.push('verification_pending');
  }

  if (input.backgroundCheckRequired) {
    if (!canDriverGoOnline(true, input.backgroundCheckRecord, now)) {
      reasons.push('background_check_required');
    } else if (isBackgroundCheckRecheckDue(input.backgroundCheckRecord, input.backgroundCheckRecheckYears, now)) {
      reasons.push('background_check_recheck_due');
    }

    if (typeof input.backgroundCheckDisqualified === 'boolean') {
      if (input.backgroundCheckDisqualified) reasons.push('background_check_disqualified');
    } else if (input.disqualificationFindings) {
      const dq = evaluateDisqualification(
        input.disqualificationFindings,
        input.disqualificationThresholds ?? DEFAULT_DISQUALIFICATION_THRESHOLDS,
        now
      );
      if (dq.disqualified) reasons.push('background_check_disqualified');
    }
  }

  if (!(input.stripeChargesEnabled && input.stripePayoutsEnabled)) {
    reasons.push('payout_setup_incomplete');
  }

  if (input.disclosureRequired && !input.disclosureAccepted) {
    reasons.push('disclosure_not_accepted');
  }

  return { canGoOnline: reasons.length === 0, reasons };
}
