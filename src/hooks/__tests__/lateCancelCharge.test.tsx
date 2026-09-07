// A COBRANÇA DO CANCELAMENTO TARDIO — `cancelScheduledRideWithPolicy`.
//
// A regra pura (quando cobra, quanto) já tem suíte própria em
// `src/lib/__tests__/cancellation.test.ts`. O que se prova AQUI é a SEQUÊNCIA,
// que é onde mora o dinheiro:
//
//   • a ORDEM — cancela primeiro, cobra depois. Invertida, uma falha no
//     cancelamento deixaria o passageiro cobrado com a corrida ainda de pé e o
//     motorista a caminho;
//   • que uma cobrança RECUSADA não tranca o cancelamento. Trancar produz o pior
//     desfecho para o motorista: o passageiro não consegue cancelar, não avisa
//     ninguém e simplesmente não aparece;
//   • que dentro da janela grátis NENHUMA cobrança é tentada.
//
// As asserções são sobre o registro externo (o que foi chamado, em que ordem),
// não sobre valores que a própria função calculou e devolveu para si.

// O prefixo `mock` nos três estados abaixo NÃO é estilo: é exigência do jest.
// O factory de `jest.mock()` roda içado, antes das declarações do módulo, e só
// pode referenciar variáveis com esse prefixo — sem ele, a suíte nem carrega.
const mockChamadas: string[] = [];
let mockUpdateFalha = false;
let mockUpdateAfetaLinha = true;
let fetchStatus = 200;
let fetchBody: Record<string, unknown> = { success: true };

jest.mock('../../lib/supabase', () => {
  const cadeia: Record<string, unknown> = {};
  const devolve = () => cadeia;
  cadeia.update = () => { mockChamadas.push('update:cancelled'); return cadeia; };
  cadeia.eq = devolve;
  cadeia.not = devolve;
  cadeia.select = devolve;
  cadeia.maybeSingle = () =>
    Promise.resolve(
      mockUpdateFalha
        ? { data: null, error: { message: 'recusado', code: '42501' } }
        : { data: mockUpdateAfetaLinha ? { id: 'corrida-1' } : null, error: null },
    );
  return {
    supabase: {
      from: () => cadeia,
      channel: () => ({ on: () => ({ subscribe: () => ({}) }), subscribe: () => ({}), send: () => Promise.resolve() }),
      removeChannel: () => {},
      auth: { getSession: () => Promise.resolve({ data: { session: { access_token: 'tok' } } }) },
    },
  };
});

// `useRide` puxa a cadeia nativa (expo-audio, haptics, notificações) por causa
// do alerta de oferta do motorista. Nada disso participa do cancelamento; são
// as mesmas fronteiras que `useRideRefs.test.tsx` corta.
jest.mock('../../lib/offerAlertManager', () => ({
  offerAlertManager: { start: () => undefined, stopAll: () => undefined, stop: () => undefined },
}));
jest.mock('../../lib/notifications', () => ({ dismissRideNotifications: () => undefined }));
jest.mock('../../lib/rideOfferEvents', () => ({ logRideOfferEvent: () => undefined }));
jest.mock('../../lib/errorReporting', () => ({ reportError: () => undefined, addBreadcrumb: () => undefined }));
jest.mock('../../lib/routing', () => ({ getRoute: () => Promise.resolve(null) }));
jest.mock('../../lib/systemConfig', () => ({
  getConfig: () => Promise.resolve(false),
  getConfigDefault: () => 0,
}));
jest.mock('../useFeatureFlag', () => ({ useFeatureFlag: () => false }));

import { cancelScheduledRideWithPolicy } from '../useRide';

const MIN = 60_000;
const AGORA = Date.parse('2026-09-07T15:00:00Z');
const daquiA = (m: number) => new Date(AGORA + m * MIN).toISOString();

beforeEach(() => {
  mockChamadas.length = 0;
  mockUpdateFalha = false;
  mockUpdateAfetaLinha = true;
  fetchStatus = 200;
  fetchBody = { success: true };
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string) => {
    mockChamadas.push(`fetch:${String(url).split('/').pop()}`);
    return { status: fetchStatus, json: async () => fetchBody } as unknown as Response;
  });
});

const corrida = (minutos: number) => ({ id: 'corrida-1', scheduled_for: daquiA(minutos), price: 41.49 });

describe('janela grátis', () => {
  it('cancela e NÃO tenta cobrar nada', async () => {
    const r = await cancelScheduledRideWithPolicy(corrida(21 * 60), AGORA);
    expect(r).toEqual({ ok: true, charged: false });
    expect(mockChamadas).toEqual(['update:cancelled']);
    expect(mockChamadas.some((c) => c.startsWith('fetch:'))).toBe(false);
  });
});

describe('dentro da última hora', () => {
  it('cobra a tarifa integral e devolve o valor cobrado', async () => {
    const r = await cancelScheduledRideWithPolicy(corrida(30), AGORA);
    expect(r).toEqual({ ok: true, charged: true, amountDollars: 41.49 });
  });

  // A ordem é o ponto: invertida, um cancelamento que falhasse deixaria o
  // passageiro cobrado com a corrida ainda de pé.
  it('CANCELA ANTES de cobrar', async () => {
    await cancelScheduledRideWithPolicy(corrida(30), AGORA);
    expect(mockChamadas).toEqual(['update:cancelled', 'fetch:charge-ride']);
  });

  it('cobrança recusada NÃO tranca o cancelamento', async () => {
    fetchBody = { error: 'Seu cartão recusou a cobrança.' };
    const r = await cancelScheduledRideWithPolicy(corrida(30), AGORA);
    expect(r.ok).toBe(true);
    expect(r.ok && r.charged).toBe(false);
    expect(r.ok && 'chargeError' in r && r.chargeError).toBe('Seu cartão recusou a cobrança.');
    // E a corrida foi mesmo cancelada, não só "reportada".
    expect(mockChamadas[0]).toBe('update:cancelled');
  });

  it('rede caindo na cobrança também não tranca', async () => {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => { throw new Error('offline'); });
    const r = await cancelScheduledRideWithPolicy(corrida(30), AGORA);
    expect(r.ok).toBe(true);
    expect(r.ok && r.charged).toBe(false);
  });
});

describe('quando o servidor recusa o cancelamento', () => {
  it('não cobra ninguém', async () => {
    mockUpdateFalha = true;
    const r = await cancelScheduledRideWithPolicy(corrida(30), AGORA);
    expect(r).toEqual({ ok: false });
    expect(mockChamadas.some((c) => c.startsWith('fetch:'))).toBe(false);
  });

  // Corrida que já estava cancelada/concluída: o UPDATE não bate em linha
  // nenhuma, mas do ponto de vista do passageiro ela não está mais ativa.
  it('corrida já finalizada conta como sucesso — e aí a multa se aplica', async () => {
    mockUpdateAfetaLinha = false;
    const r = await cancelScheduledRideWithPolicy(corrida(30), AGORA);
    expect(r.ok).toBe(true);
  });
});
