import {
  MockTollProvider,
  GoogleTollProvider,
  makeTollProvider,
  estimateTollAmount,
  type TollQuery,
} from '../tolls';
import * as systemConfig from '../systemConfig';

// Mocka o Supabase para não carregar módulos nativos (AsyncStorage) ao importar
// systemConfig. Os testes de estimateTollAmount espionam getConfig diretamente.
jest.mock('../supabase', () => ({ supabase: { from: jest.fn() } }));

const QUERY: TollQuery = {
  origin: { lat: 28.5383, lng: -81.3792 },
  destination: { lat: 28.4294, lng: -81.309 },
  distanceKm: 20,
};

describe('MockTollProvider', () => {
  it('calcula flat + perKm * distanceKm', async () => {
    const p = new MockTollProvider({ flat: 2, perKm: 0.5 });
    const q = await p.quote(QUERY); // 2 + 0.5*20 = 12
    expect(q.amount).toBe(12);
    expect(q.source).toBe('mock');
  });

  it('arredonda a centavos', async () => {
    const p = new MockTollProvider({ flat: 0, perKm: 0.333 });
    const q = await p.quote({ ...QUERY, distanceKm: 10 }); // 3.33
    expect(q.amount).toBe(3.33);
  });

  it('valor zero → source none', async () => {
    const p = new MockTollProvider({ flat: 0, perKm: 0 });
    const q = await p.quote(QUERY);
    expect(q).toEqual({ amount: 0, source: 'none' });
  });

  it('nunca devolve valor negativo', async () => {
    const p = new MockTollProvider({ flat: -5, perKm: 0 });
    const q = await p.quote(QUERY);
    expect(q.amount).toBe(0);
  });

  it('distância negativa é tratada como 0', async () => {
    const p = new MockTollProvider({ flat: 3, perKm: 1 });
    const q = await p.quote({ ...QUERY, distanceKm: -100 });
    expect(q.amount).toBe(3);
  });
});

describe('GoogleTollProvider', () => {
  it('ainda não implementado → lança', async () => {
    const p = new GoogleTollProvider();
    await expect(p.quote(QUERY)).rejects.toThrow(/não implementado/);
  });
});

describe('makeTollProvider', () => {
  it('mock por padrão', () => {
    expect(makeTollProvider('mock', { flat: 0, perKm: 0 })).toBeInstanceOf(MockTollProvider);
    expect(makeTollProvider('qualquer', { flat: 0, perKm: 0 })).toBeInstanceOf(MockTollProvider);
  });
  it('google quando pedido', () => {
    expect(makeTollProvider('google', { flat: 0, perKm: 0 })).toBeInstanceOf(GoogleTollProvider);
  });
});

describe('estimateTollAmount', () => {
  afterEach(() => jest.restoreAllMocks());

  it('flag desligada → 0/none e não consulta provider', async () => {
    const spy = jest.spyOn(systemConfig, 'getConfig').mockResolvedValue(false as never);
    const q = await estimateTollAmount(QUERY);
    expect(q).toEqual({ amount: 0, source: 'none' });
    // Só a leitura da flag deve acontecer.
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('tolls_enabled', 'global');
  });

  it('flag ligada + provider mock → soma flat + perKm', async () => {
    jest.spyOn(systemConfig, 'getConfig').mockImplementation((async (key: string) => {
      switch (key) {
        case 'tolls_enabled': return true;
        case 'toll_provider': return 'mock';
        case 'mock_toll_flat': return 1.5;
        case 'mock_toll_per_km': return 0.25;
        default: return undefined;
      }
    }) as never);
    const q = await estimateTollAmount(QUERY); // 1.5 + 0.25*20 = 6.5
    expect(q).toEqual({ amount: 6.5, source: 'mock' });
  });

  it('provider que lança (google) → cai para 0/none', async () => {
    jest.spyOn(systemConfig, 'getConfig').mockImplementation((async (key: string) => {
      switch (key) {
        case 'tolls_enabled': return true;
        case 'toll_provider': return 'google';
        default: return 0;
      }
    }) as never);
    const q = await estimateTollAmount(QUERY);
    expect(q).toEqual({ amount: 0, source: 'none' });
  });

  it('erro na leitura de config → 0/none (não lança)', async () => {
    jest.spyOn(systemConfig, 'getConfig').mockRejectedValue(new Error('sem rede') as never);
    const q = await estimateTollAmount(QUERY);
    expect(q).toEqual({ amount: 0, source: 'none' });
  });

  it('propaga a jurisdição para a leitura de config', async () => {
    const spy = jest.spyOn(systemConfig, 'getConfig').mockResolvedValue(false as never);
    await estimateTollAmount(QUERY, 'US-FL');
    expect(spy).toHaveBeenCalledWith('tolls_enabled', 'US-FL');
  });
});
