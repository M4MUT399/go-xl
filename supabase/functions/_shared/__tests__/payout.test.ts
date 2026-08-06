import {
  classifyPayoutRequest,
  reconcileSettlement,
  friendlyProviderError,
  isLiveStripeKey,
  checkTestEnvironment,
  assertTestEnvironment,
  httpStatusForCode,
  MIN_PAYOUT_CENTS,
  type RideTransferResult,
} from '../payout';

const base = {
  hasAccount: true,
  payoutsEnabled: true,
  hasInFlightPayout: false,
  eligibleCents: 5000, // US$ 50,00
};

describe('payout — classificação da solicitação (códigos claros)', () => {
  test('(a) caminho feliz → OK com o valor em centavos', () => {
    const r = classifyPayoutRequest(base);
    expect(r).toEqual({ ok: true, code: 'OK', amountCents: 5000 });
  });

  test('sem conta → NO_ACCOUNT (antes de qualquer outra checagem)', () => {
    const r = classifyPayoutRequest({ ...base, hasAccount: false, payoutsEnabled: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NO_ACCOUNT');
  });

  test('(d) conta sem payouts habilitados → KYC_PENDING', () => {
    const r = classifyPayoutRequest({ ...base, payoutsEnabled: false });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('KYC_PENDING');
      expect(r.message).toMatch(/enabled|setup|finish/i);
    }
  });

  test('(c) repasse em andamento → PAYOUT_IN_PROGRESS (o 2º solicitante bate aqui)', () => {
    const r = classifyPayoutRequest({ ...base, hasInFlightPayout: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('PAYOUT_IN_PROGRESS');
  });

  test('saldo abaixo do mínimo → BALANCE_BELOW_MINIMUM', () => {
    const r = classifyPayoutRequest({ ...base, eligibleCents: MIN_PAYOUT_CENTS - 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('BALANCE_BELOW_MINIMUM');
  });

  test('exatamente no mínimo é aceito', () => {
    const r = classifyPayoutRequest({ ...base, eligibleCents: MIN_PAYOUT_CENTS });
    expect(r.ok).toBe(true);
  });

  test('mínimo customizado é respeitado', () => {
    const r = classifyPayoutRequest({ ...base, eligibleCents: 200, minCents: 500 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('BALANCE_BELOW_MINIMUM');
  });

  test('precedência: sem conta ganha de saldo baixo e de payouts off', () => {
    const r = classifyPayoutRequest({
      hasAccount: false,
      payoutsEnabled: false,
      hasInFlightPayout: true,
      eligibleCents: 0,
    });
    if (!r.ok) expect(r.code).toBe('NO_ACCOUNT');
  });
});

describe('payout — HTTP status por código', () => {
  test('in-progress = 409, provider = 502, resto = 400', () => {
    expect(httpStatusForCode('PAYOUT_IN_PROGRESS')).toBe(409);
    expect(httpStatusForCode('PROVIDER_ERROR')).toBe(502);
    expect(httpStatusForCode('NO_ACCOUNT')).toBe(400);
    expect(httpStatusForCode('KYC_PENDING')).toBe(400);
    expect(httpStatusForCode('BALANCE_BELOW_MINIMUM')).toBe(400);
  });
});

describe('payout — conciliação da liquidação (settle)', () => {
  test('todas transferem → completed, soma os centavos, guarda o 1º transfer', () => {
    const results: RideTransferResult[] = [
      { rideId: 'a', ok: true, amountCents: 1200, transferId: 'tr_1' },
      { rideId: 'b', ok: true, amountCents: 800, transferId: 'tr_2' },
    ];
    const s = reconcileSettlement(results);
    expect(s.status).toBe('completed');
    expect(s.transferredCount).toBe(2);
    expect(s.transferredCents).toBe(2000);
    expect(s.failedRideIds).toEqual([]);
    expect(s.firstTransferId).toBe('tr_1');
  });

  test('(b) falha do provedor → failed e lista as corridas a desvincular (reverte o débito)', () => {
    const results: RideTransferResult[] = [
      { rideId: 'a', ok: false, amountCents: 0, reason: 'Insufficient funds' },
      { rideId: 'b', ok: false, amountCents: 0, reason: 'No such charge' },
    ];
    const s = reconcileSettlement(results);
    expect(s.status).toBe('failed');
    expect(s.transferredCount).toBe(0);
    expect(s.transferredCents).toBe(0);
    expect(s.failedRideIds).toEqual(['a', 'b']);
    expect(s.lastReason).toBe('No such charge');
  });

  test('sucesso parcial → completed só com o que saiu; corrida falha desvinculada', () => {
    const results: RideTransferResult[] = [
      { rideId: 'a', ok: true, amountCents: 1500, transferId: 'tr_1' },
      { rideId: 'b', ok: false, amountCents: 0, reason: 'card_declined' },
    ];
    const s = reconcileSettlement(results);
    expect(s.status).toBe('completed');
    expect(s.transferredCount).toBe(1);
    expect(s.transferredCents).toBe(1500);
    expect(s.failedRideIds).toEqual(['b']);
    expect(s.firstTransferId).toBe('tr_1');
  });
});

describe('payout — mensagem amigável do provedor', () => {
  test('saldo insuficiente vira mensagem de plataforma', () => {
    expect(friendlyProviderError('Error: Insufficient funds in account')).toMatch(/platform balance/i);
  });
  test('cobrança inexistente vira mensagem de dado de teste', () => {
    expect(friendlyProviderError('No such charge: ch_x')).toMatch(/test data|test card/i);
  });
  test('erro desconhecido vira mensagem genérica de retry', () => {
    expect(friendlyProviderError('timeout')).toMatch(/try again/i);
    expect(friendlyProviderError(undefined)).toMatch(/try again/i);
  });
});

describe('payout — TRAVA DE SEGURANÇA de ambiente (anti-live)', () => {
  test('detecta chaves live do Stripe', () => {
    expect(isLiveStripeKey('sk_live_abc123')).toBe(true);
    expect(isLiveStripeKey('rk_live_abc123')).toBe(true);
    expect(isLiveStripeKey('  sk_live_padded  ')).toBe(true);
    expect(isLiveStripeKey('sk_test_abc123')).toBe(false);
    expect(isLiveStripeKey('')).toBe(false);
    expect(isLiveStripeKey(null)).toBe(false);
    expect(isLiveStripeKey(undefined)).toBe(false);
  });

  test('(e) checkTestEnvironment bloqueia chave live', () => {
    const r = checkTestEnvironment({ stripeKey: 'sk_live_zzz' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/live key/i);
  });

  test('(e) bloqueia APP_ENV de produção mesmo com chave de teste', () => {
    for (const env of ['production', 'prod', 'live', 'PRODUCTION']) {
      const r = checkTestEnvironment({ stripeKey: 'sk_test_ok', appEnv: env });
      expect(r.ok).toBe(false);
    }
  });

  test('libera ambiente de teste', () => {
    expect(checkTestEnvironment({ stripeKey: 'sk_test_ok', appEnv: 'test' }).ok).toBe(true);
    expect(checkTestEnvironment({ stripeKey: 'sk_test_ok' }).ok).toBe(true);
    expect(checkTestEnvironment({}).ok).toBe(true);
  });

  test('(e) assertTestEnvironment ABORTA em live e passa em teste', () => {
    expect(() => assertTestEnvironment({ stripeKey: 'sk_live_zzz' })).toThrow(/SAFETY LOCK/);
    expect(() => assertTestEnvironment({ stripeKey: 'sk_test_ok', appEnv: 'production' })).toThrow(
      /SAFETY LOCK/,
    );
    expect(() => assertTestEnvironment({ stripeKey: 'sk_test_ok', appEnv: 'staging' })).not.toThrow();
  });
});
