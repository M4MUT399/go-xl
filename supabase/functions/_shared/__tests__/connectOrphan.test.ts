import { canOpenDashboard, canPromote, isOrphanAccountError, keyCanJudgeOrphans } from '../connectOrphan';

describe('isOrphanAccountError', () => {
  it.each([
    'You requested an account link for an account that is not connected to your platform or does not exist.',
    "The provided key 'sk_live_***' does not have access to account 'acct_1' (or that account does not exist).",
    "No such account: 'acct_1'",
  ])('reconhece: %s', (message) => {
    expect(isOrphanAccountError({ message })).toBe(true);
    expect(isOrphanAccountError({ raw: { message } })).toBe(true);
  });

  it.each(['Network error', 'An error occurred with our connection to Stripe', 'Rate limit', ''])(
    'erro comum NÃO vira conta órfã: "%s"',
    (message) => expect(isOrphanAccountError({ message })).toBe(false),
  );

  it('aguenta entrada vazia', () => {
    expect(isOrphanAccountError(null)).toBe(false);
    expect(isOrphanAccountError(undefined)).toBe(false);
  });
});

describe('keyCanJudgeOrphans', () => {
  const lista = () => Promise.resolve({});
  it('chave de produção que lista contas pode julgar', async () => {
    await expect(keyCanJudgeOrphans('sk_live_x', lista)).resolves.toBe(true);
    await expect(keyCanJudgeOrphans('rk_live_x', lista)).resolves.toBe(true);
  });
  it('chave de teste nunca julga, nem chega a consultar', async () => {
    const espiao = jest.fn(lista);
    await expect(keyCanJudgeOrphans('sk_test_x', espiao)).resolves.toBe(false);
    expect(espiao).not.toHaveBeenCalled();
  });
  it('chave que não lista contas não julga', async () => {
    await expect(keyCanJudgeOrphans('rk_live_x', () => Promise.reject(new Error('permission')))).resolves.toBe(false);
  });
});

describe('canPromote', () => {
  it('só com cobranças E repasses aprovados', () => {
    expect(canPromote({ charges_enabled: true, payouts_enabled: true })).toBe(true);
    expect(canPromote({ charges_enabled: true, payouts_enabled: false })).toBe(false);
    expect(canPromote({ charges_enabled: false, payouts_enabled: true })).toBe(false);
    expect(canPromote({})).toBe(false);
  });
});

describe('canOpenDashboard', () => {
  it('só depois de concluir o cadastro', () => {
    expect(canOpenDashboard({ details_submitted: true })).toBe(true);
    expect(canOpenDashboard({ details_submitted: false })).toBe(false);
    expect(canOpenDashboard({})).toBe(false);
  });
});
