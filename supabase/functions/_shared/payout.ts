// Lógica PURA de decisão do repasse (payout) + trava de segurança de ambiente.
//
// Por que existe (padrão do projeto — ver _shared/tripShare.ts):
//   As Edge Functions `request-payout` / `run-weekly-payouts` fazem I/O (Supabase
//   + Stripe). A DECISÃO — pode repassar? qual o código de rejeição? quanto foi
//   realmente transferido? o ambiente é de teste? — vive aqui, sem I/O e sem
//   globais do Deno, então é 100% coberta pelo Jest do app (o `tsconfig` exclui
//   `supabase/functions`, então isto NÃO passa pelo `tsc`; a garantia vem do teste).
//
// Regras de dinheiro (decisão do usuário: "endurecer o modelo atual"):
//   • valores sempre em CENTAVOS inteiros (ver _shared/money.ts);
//   • saldo derivado das corridas elegíveis (nunca de um campo acumulado);
//   • toda rejeição devolve um CÓDIGO claro ao app — nunca erro genérico.

// ─────────────────────────────────────────────────────────────────────────────
// Códigos de resultado (contrato com o app). O app mapeia cada código para uma
// mensagem localizada; a `message` aqui é o fallback em inglês (idioma oficial).
// ─────────────────────────────────────────────────────────────────────────────
export type PayoutRejectionCode =
  | 'NO_ACCOUNT' // motorista não configurou conta de recebimento (Stripe Connect)
  | 'KYC_PENDING' // conta existe mas payouts_enabled=false (cadastro/KYC pendente)
  | 'PAYOUT_IN_PROGRESS' // já existe um repasse pendente/processando para este motorista
  | 'BALANCE_BELOW_MINIMUM' // saldo elegível abaixo do mínimo repassável
  | 'PROVIDER_ERROR'; // o provedor (Stripe) recusou a transferência

export type PayoutCode = 'OK' | PayoutRejectionCode;

/** Mínimo repassável: US$ 1,00 em centavos. Abaixo disso, BALANCE_BELOW_MINIMUM. */
export const MIN_PAYOUT_CENTS = 100;

export interface ClassifyPayoutInput {
  /** Motorista tem `stripe_account_id` configurado? */
  hasAccount: boolean;
  /** O Stripe reporta `payouts_enabled` para a conta AGORA? */
  payoutsEnabled: boolean;
  /** Já existe um payout pendente/processando (após auto-destravar os presos)? */
  hasInFlightPayout: boolean;
  /** Soma das corridas elegíveis, em CENTAVOS inteiros. */
  eligibleCents: number;
  /** Mínimo repassável (default MIN_PAYOUT_CENTS) — injetável para teste. */
  minCents?: number;
}

export type ClassifyPayoutResult =
  | { ok: true; code: 'OK'; amountCents: number }
  | { ok: false; code: PayoutRejectionCode; message: string };

/**
 * Decide se o repasse pode prosseguir e, se não, com qual CÓDIGO.
 *
 * A ordem importa e é a mesma da Edge Function:
 *   1. sem conta            → NO_ACCOUNT        (configure recebimento)
 *   2. conta sem payouts    → KYC_PENDING       (conclua o cadastro)
 *   3. repasse em andamento → PAYOUT_IN_PROGRESS (aguarde o atual)
 *   4. saldo < mínimo       → BALANCE_BELOW_MINIMUM
 *   5. caso contrário       → OK + amountCents
 *
 * (PROVIDER_ERROR não sai daqui: só é conhecido DEPOIS de chamar o Stripe.)
 */
export function classifyPayoutRequest(input: ClassifyPayoutInput): ClassifyPayoutResult {
  const minCents = input.minCents ?? MIN_PAYOUT_CENTS;

  if (!input.hasAccount) {
    return {
      ok: false,
      code: 'NO_ACCOUNT',
      message: 'Set up your payout account before requesting a payout.',
    };
  }
  if (!input.payoutsEnabled) {
    return {
      ok: false,
      code: 'KYC_PENDING',
      message: 'Your payout account is not enabled yet. Finish the setup to get paid.',
    };
  }
  if (input.hasInFlightPayout) {
    return {
      ok: false,
      code: 'PAYOUT_IN_PROGRESS',
      message: 'You already have a payout in progress. Please wait for it to finish.',
    };
  }
  if (input.eligibleCents < minCents) {
    return {
      ok: false,
      code: 'BALANCE_BELOW_MINIMUM',
      message: 'Your available balance is below the minimum payout amount.',
    };
  }
  return { ok: true, code: 'OK', amountCents: input.eligibleCents };
}

/** HTTP status por código — todas as rejeições são "do cliente" (4xx). */
export function httpStatusForCode(code: PayoutRejectionCode): number {
  switch (code) {
    case 'PAYOUT_IN_PROGRESS':
      return 409; // conflito: já existe um repasse ativo
    case 'PROVIDER_ERROR':
      return 502; // falha na dependência externa (Stripe)
    default:
      return 400; // NO_ACCOUNT / KYC_PENDING / BALANCE_BELOW_MINIMUM
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Conciliação da liquidação (settle): dado o resultado de cada transfer por
// corrida, resume o que foi realmente transferido e quais corridas devolver ao
// saldo (payout_id = null). PURO — o efeito colateral (Stripe/DB) fica na função.
// ─────────────────────────────────────────────────────────────────────────────
export interface RideTransferResult {
  rideId: string;
  ok: boolean;
  /** Centavos transferidos nesta corrida (só relevante quando ok=true). */
  amountCents: number;
  transferId?: string;
  reason?: string;
}

export interface SettlementSummary {
  status: 'completed' | 'failed';
  transferredCount: number;
  transferredCents: number;
  /** Corridas cujo transfer falhou → devem ser desvinculadas para nova tentativa. */
  failedRideIds: string[];
  firstTransferId?: string;
  lastReason?: string;
}

/**
 * Concilia os resultados por corrida. `failed` quando NENHUMA transferiu (aí a
 * função reverte tudo: payout 'failed' + desvincula todas as corridas); caso
 * contrário `completed`, refletindo apenas o que de fato saiu, e desvinculando
 * as corridas que falharam para um repasse futuro.
 */
export function reconcileSettlement(results: RideTransferResult[]): SettlementSummary {
  let transferredCount = 0;
  let transferredCents = 0;
  const failedRideIds: string[] = [];
  let firstTransferId: string | undefined;
  let lastReason: string | undefined;

  for (const r of results) {
    if (r.ok) {
      transferredCount += 1;
      transferredCents += Math.max(0, Math.round(r.amountCents));
      if (!firstTransferId) firstTransferId = r.transferId;
    } else {
      failedRideIds.push(r.rideId);
      if (r.reason) lastReason = r.reason;
    }
  }

  return {
    status: transferredCount === 0 ? 'failed' : 'completed',
    transferredCount,
    transferredCents,
    failedRideIds,
    firstTransferId,
    lastReason,
  };
}

/**
 * Traduz o erro cru do Stripe numa mensagem amigável (fallback em inglês; o app
 * mostra a localizada por código PROVIDER_ERROR). Distingue os dois casos comuns
 * do modo teste: sem saldo na plataforma e corrida sem cobrança real.
 */
export function friendlyProviderError(reason: string | undefined): string {
  const r = reason ?? '';
  if (/insufficient/i.test(r)) {
    return 'The platform balance is insufficient for this payout right now. Try again after new charges settle.';
  }
  if (/no such|charge|source_transaction/i.test(r)) {
    return 'These rides have no real charge to transfer (test data). Run a ride charging a test card and try again.';
  }
  return 'We could not complete the payout right now. Please try again shortly.';
}

// ─────────────────────────────────────────────────────────────────────────────
// TRAVA DE SEGURANÇA DE AMBIENTE — usada pelo script `reset_test_balances`.
// Recusa rodar operações destrutivas se detectar PRODUÇÃO: chave live do Stripe
// (sk_live_ / rk_live_) OU APP_ENV de produção. PURO → coberto por teste (item e).
// ─────────────────────────────────────────────────────────────────────────────

/** `true` se a chave é uma LIVE key do Stripe (sk_live_ ou rk_live_). */
export function isLiveStripeKey(key: string | null | undefined): boolean {
  if (!key) return false;
  const k = key.trim();
  return k.startsWith('sk_live_') || k.startsWith('rk_live_');
}

export interface TestEnvGuardInput {
  /** Valor de STRIPE_SECRET_KEY. */
  stripeKey?: string | null;
  /** Valor de APP_ENV / NODE_ENV (production/prod/live bloqueiam). */
  appEnv?: string | null;
}

export type TestEnvCheck = { ok: true } | { ok: false; reason: string };

/**
 * Verifica se é seguro rodar o reset destrutivo (ambiente de TESTE). Retorna o
 * motivo do bloqueio em vez de lançar — fácil de testar. Use `assertTestEnvironment`
 * para a versão que ABORTA.
 */
export function checkTestEnvironment(input: TestEnvGuardInput): TestEnvCheck {
  if (isLiveStripeKey(input.stripeKey)) {
    return {
      ok: false,
      reason:
        'Stripe LIVE key detected (sk_live_/rk_live_). Refusing to run a destructive reset against production money.',
    };
  }
  const env = (input.appEnv ?? '').trim().toLowerCase();
  if (env === 'production' || env === 'prod' || env === 'live') {
    return {
      ok: false,
      reason: `APP_ENV="${input.appEnv}" indicates production. Refusing to run a destructive reset.`,
    };
  }
  return { ok: true };
}

/** Igual a `checkTestEnvironment`, mas ABORTA (throw) se detectar produção. */
export function assertTestEnvironment(input: TestEnvGuardInput): void {
  const r = checkTestEnvironment(input);
  if (!r.ok) throw new Error(`[SAFETY LOCK] ${r.reason}`);
}
