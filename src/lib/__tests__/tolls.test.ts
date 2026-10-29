import {
  MockTollProvider,
  GoogleTollProvider,
  makeTollProvider,
  estimateTollAmount,
  limparCacheDePedagio,
  type TollQuery,
  type PublicCaller,
} from '../tolls';
import * as systemConfig from '../systemConfig';

// Mocka o Supabase para não carregar módulos nativos (AsyncStorage) ao importar
// systemConfig. Os testes de estimateTollAmount espionam getConfig diretamente.
jest.mock('../supabase', () => ({ supabase: { from: jest.fn() } }));
jest.mock('../errorReporting', () => ({ reportError: () => {} }));
jest.mock('../edgeFunction', () => ({ callEdgeFunction: () => Promise.resolve({}) }));

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
  beforeEach(() => limparCacheDePedagio());

  const caller = (resp: unknown, registro?: unknown[]) =>
    (async (_n: string, body: Record<string, unknown>) => {
      registro?.push(body);
      if (resp instanceof Error) throw resp;
      return resp as never;
    }) as PublicCaller;

  it('devolve o valor que a função retornou', async () => {
    const p = new GoogleTollProvider(caller({ amount: 4.4 }));
    expect(await p.quote(QUERY)).toEqual({ amount: 4.4, source: 'google' });
  });

  it('rota sem pedágio vira source none, não google com zero', async () => {
    // Importa para o recibo e para o split: 'none' diz "não há", enquanto
    // 'google' com 0 diria "consultei e deu zero" — coisas diferentes de depurar.
    const p = new GoogleTollProvider(caller({ amount: 0 }));
    expect(await p.quote(QUERY)).toEqual({ amount: 0, source: 'none' });
  });

  it('arredonda a centavos', async () => {
    const p = new GoogleTollProvider(caller({ amount: 4.4449 }));
    expect((await p.quote(QUERY)).amount).toBe(4.44);
  });

  it('valor inválido não vira cobrança', async () => {
    for (const lixo of [undefined, null, 'abc', NaN, -3]) {
      limparCacheDePedagio();
      const p = new GoogleTollProvider(caller({ amount: lixo }));
      expect((await p.quote(QUERY)).amount).toBe(0);
    }
  });

  // A tela de pedido reestima a cada mudança de destino, e a chamada é PAGA.
  it('a segunda consulta do mesmo trecho não chama a função de novo', async () => {
    const chamadas: unknown[] = [];
    const p = new GoogleTollProvider(caller({ amount: 6.25 }, chamadas));
    await p.quote(QUERY);
    await p.quote(QUERY);
    await p.quote(QUERY);
    expect(chamadas).toHaveLength(1);
  });

  it('trecho diferente é consulta diferente', async () => {
    const chamadas: unknown[] = [];
    const p = new GoogleTollProvider(caller({ amount: 6.25 }, chamadas));
    await p.quote(QUERY);
    await p.quote({ ...QUERY, destination: { lat: 28.9, lng: -81.9 } });
    expect(chamadas).toHaveLength(2);
  });

  it('passe diferente é consulta diferente — muda o preço', async () => {
    const chamadas: unknown[] = [];
    await new GoogleTollProvider(caller({ amount: 6.25 }, chamadas), []).quote(QUERY);
    await new GoogleTollProvider(caller({ amount: 6.25 }, chamadas), ['US_FL_SUNPASS']).quote(QUERY);
    expect(chamadas).toHaveLength(2);
  });

  it('falha não é cacheada — a próxima corrida tenta de novo', async () => {
    const chamadas: unknown[] = [];
    const p = new GoogleTollProvider(caller(new Error('502'), chamadas));
    expect(await p.quote(QUERY)).toEqual({ amount: 0, source: 'none' });
    await p.quote(QUERY);
    expect(chamadas).toHaveLength(2);
  });

  it('manda o passe adiante só quando existe', async () => {
    const semPasse: Record<string, unknown>[] = [];
    await new GoogleTollProvider(caller({ amount: 1 }, semPasse), []).quote(QUERY);
    expect(semPasse[0]).not.toHaveProperty('tollPasses');

    limparCacheDePedagio();
    const comPasse: Record<string, unknown>[] = [];
    await new GoogleTollProvider(caller({ amount: 1 }, comPasse), ['US_FL_SUNPASS']).quote(QUERY);
    expect(comPasse[0]).toMatchObject({ tollPasses: ['US_FL_SUNPASS'] });
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

  // O nome antigo era "provider que lança": valia quando o GoogleTollProvider
  // era um stub. Hoje ele captura a falha por dentro e devolve zero, que é o
  // que de fato precisa ser garantido — cobrar pedágio errado é pior que não
  // cobrar, porque o valor vai inteiro para o motorista.
  it('google sem resposta utilizável → 0/none, sem quebrar a corrida', async () => {
    limparCacheDePedagio();
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
