import { getConfig, clearConfigCache, CONFIG_DEFAULTS } from '../systemConfig';
import { supabase } from '../supabase';

jest.mock('../supabase', () => ({
  supabase: { from: jest.fn() },
}));

type ConfigResult = { data: unknown; error: unknown };

// Monta o encadeamento from().select().eq().in() resolvendo no resultado dado.
function mockResponse(result: ConfigResult) {
  (supabase.from as jest.Mock).mockReturnValue({
    select: () => ({
      eq: () => ({
        in: () => Promise.resolve(result),
      }),
    }),
  });
}

beforeEach(() => {
  clearConfigCache();
  jest.clearAllMocks();
});

describe('getConfig', () => {
  it('cai no default local quando a query retorna erro (ex.: tabela ausente)', async () => {
    mockResponse({ data: null, error: { message: 'relation does not exist' } });
    const value = await getConfig('ride_offer_timeout_seconds');
    expect(value).toBe(CONFIG_DEFAULTS.ride_offer_timeout_seconds);
  });

  it('cai no default quando não há linhas', async () => {
    mockResponse({ data: [], error: null });
    const value = await getConfig('ride_offer_timeout_seconds');
    expect(value).toBe(CONFIG_DEFAULTS.ride_offer_timeout_seconds);
  });

  it('retorna o valor global configurado', async () => {
    mockResponse({ data: [{ jurisdiction: 'global', value: 45 }], error: null });
    const value = await getConfig('ride_offer_timeout_seconds');
    expect(value).toBe(45);
  });

  it('jurisdição específica sobrescreve a global', async () => {
    mockResponse({
      data: [
        { jurisdiction: 'global', value: 45 },
        { jurisdiction: 'US-FL', value: 20 },
      ],
      error: null,
    });
    const value = await getConfig('ride_offer_timeout_seconds', 'US-FL');
    expect(value).toBe(20);
  });

  it('nunca lança: exceção na query também cai no default', async () => {
    (supabase.from as jest.Mock).mockImplementation(() => {
      throw new Error('network down');
    });
    const value = await getConfig('ride_offer_timeout_seconds');
    expect(value).toBe(CONFIG_DEFAULTS.ride_offer_timeout_seconds);
  });
});
