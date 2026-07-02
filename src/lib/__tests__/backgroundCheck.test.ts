import {
  MockBackgroundCheckProvider,
  StripeIdentityProvider,
  makeBackgroundCheckProvider,
  isCheckValid,
  canDriverGoOnline,
  daysUntilExpiry,
  startBackgroundCheck,
  type BackgroundCheckRecord,
} from '../backgroundCheck';
import * as systemConfig from '../systemConfig';

// Mocka o Supabase para não carregar módulos nativos ao importar systemConfig.
jest.mock('../supabase', () => ({ supabase: { from: jest.fn() } }));

const NOW = new Date('2026-07-01T12:00:00.000Z');
const iso = (days: number) => new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000).toISOString();

const clearValid: BackgroundCheckRecord = {
  provider: 'mock', providerRef: 'mock_d1', status: 'clear',
  checkedAt: iso(-10), expiresAt: iso(355),
};
const clearExpired: BackgroundCheckRecord = {
  provider: 'mock', providerRef: 'mock_d1', status: 'clear',
  checkedAt: iso(-400), expiresAt: iso(-1),
};

describe('MockBackgroundCheckProvider', () => {
  it('não recebe PII e devolve referência tokenizada + pending', async () => {
    const p = new MockBackgroundCheckProvider();
    const r = await p.initiate('driver-123');
    expect(r).toEqual({ providerRef: 'mock_driver-123', status: 'pending' });
  });
});

describe('StripeIdentityProvider', () => {
  it('stub → lança (não usar em produção sem integração)', async () => {
    await expect(new StripeIdentityProvider().initiate('d1')).rejects.toThrow(/não implementado/);
  });
});

describe('makeBackgroundCheckProvider', () => {
  it('mock por padrão', () => {
    expect(makeBackgroundCheckProvider('mock')).toBeInstanceOf(MockBackgroundCheckProvider);
    expect(makeBackgroundCheckProvider('qualquer')).toBeInstanceOf(MockBackgroundCheckProvider);
  });
  it('stripe_identity quando pedido', () => {
    expect(makeBackgroundCheckProvider('stripe_identity')).toBeInstanceOf(StripeIdentityProvider);
  });
});

describe('isCheckValid', () => {
  it('null → inválido', () => {
    expect(isCheckValid(null, NOW)).toBe(false);
  });
  it('clear e não expirado → válido', () => {
    expect(isCheckValid(clearValid, NOW)).toBe(true);
  });
  it('clear mas expirado → inválido', () => {
    expect(isCheckValid(clearExpired, NOW)).toBe(false);
  });
  it('clear sem expiração → válido', () => {
    expect(isCheckValid({ ...clearValid, expiresAt: null }, NOW)).toBe(true);
  });
  it('status pending → inválido', () => {
    expect(isCheckValid({ ...clearValid, status: 'pending' }, NOW)).toBe(false);
  });
  it('status consider/failed → inválido', () => {
    expect(isCheckValid({ ...clearValid, status: 'consider' }, NOW)).toBe(false);
    expect(isCheckValid({ ...clearValid, status: 'failed' }, NOW)).toBe(false);
  });
});

describe('canDriverGoOnline', () => {
  it('feature desligada → sempre permite (mesmo sem check)', () => {
    expect(canDriverGoOnline(false, null, NOW)).toBe(true);
  });
  it('feature ligada + sem check válido → bloqueia', () => {
    expect(canDriverGoOnline(true, null, NOW)).toBe(false);
    expect(canDriverGoOnline(true, clearExpired, NOW)).toBe(false);
  });
  it('feature ligada + check válido → permite', () => {
    expect(canDriverGoOnline(true, clearValid, NOW)).toBe(true);
  });
});

describe('daysUntilExpiry', () => {
  it('null quando não há expiração', () => {
    expect(daysUntilExpiry({ ...clearValid, expiresAt: null }, NOW)).toBeNull();
    expect(daysUntilExpiry(null, NOW)).toBeNull();
  });
  it('conta dias inteiros restantes', () => {
    expect(daysUntilExpiry(clearValid, NOW)).toBe(355);
  });
  it('expirado → 0 (nunca negativo)', () => {
    expect(daysUntilExpiry(clearExpired, NOW)).toBe(0);
  });
});

describe('startBackgroundCheck', () => {
  afterEach(() => jest.restoreAllMocks());

  it('usa o provider configurado (mock) e devolve pending', async () => {
    jest.spyOn(systemConfig, 'getConfig').mockResolvedValue('mock' as never);
    const r = await startBackgroundCheck('driver-9');
    expect(r).toEqual({ providerRef: 'mock_driver-9', status: 'pending' });
  });

  it('provider stub que lança → status failed (não propaga)', async () => {
    jest.spyOn(systemConfig, 'getConfig').mockResolvedValue('stripe_identity' as never);
    const r = await startBackgroundCheck('driver-9');
    expect(r).toEqual({ providerRef: '', status: 'failed' });
  });

  it('erro na config → status failed', async () => {
    jest.spyOn(systemConfig, 'getConfig').mockRejectedValue(new Error('x') as never);
    const r = await startBackgroundCheck('driver-9');
    expect(r.status).toBe('failed');
  });
});
