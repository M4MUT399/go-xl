import React from 'react';
import { create, act } from 'react-test-renderer';

/**
 * A GORJETA RETROATIVA, na tela.
 *
 * Por que montar a tela em vez de só testar `src/lib/tip.ts`: a regra pura já
 * está coberta lá com 35 testes. O que ESTES provam é a outra metade, que é
 * onde o defeito original morava — o botão existir e chegar na `tip-ride` com o
 * valor certo. O defeito nunca foi de cálculo: era a ausência de um caminho.
 *
 * O caso que originou tudo: passageira relata que a corrida não debitou e que
 * "não apareceu a opção de gorjeta". A corrida estava CONCLUÍDA e NÃO PAGA. O
 * primeiro teste abaixo é exatamente essa linha.
 */

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: () => Promise.resolve(null),
    setItem: () => Promise.resolve(),
    removeItem: () => Promise.resolve(),
  },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../../hooks/useAuth', () => ({
  useAuth: () => ({ profile: { id: 'p1', full_name: 'Alice', jurisdiction: 'FL' } }),
}));

jest.mock('../../../hooks/useFeatureFlag', () => ({ useFeatureFlag: () => false }));

jest.mock('../../../lib/waybillExport', () => ({
  generateAndShareWaybill: () => Promise.resolve({ ok: true }),
}));

const mockChamadas: Array<{ rideId: string; cents: number }> = [];
const mockResposta = { ok: true as boolean, error: undefined as string | undefined };

jest.mock('../../../hooks/useRide', () => ({
  tipRide: (rideId: string, cents: number) => {
    mockChamadas.push({ rideId, cents });
    return Promise.resolve({ ok: mockResposta.ok, error: mockResposta.error });
  },
}));

const mockAlertas: Array<{ titulo: string; msg?: string }> = [];

import { Alert } from 'react-native';
import { TripDetailsScreen } from '../TripDetailsScreen';
import { TIP_PRESETS, TIP_WINDOW_DAYS } from '../../../lib/tip';
import { RideRecord } from '../../../types';

const DIA = 24 * 60 * 60 * 1000;
const AGORA = Date.parse('2026-08-21T12:00:00.000Z');
const CONCLUIDA = new Date(AGORA - DIA).toISOString();

type Renderer = ReturnType<typeof create>;

// A corrida do caso real: concluída, 13.6 mi, $30.17, NÃO PAGA, sem gorjeta.
const CORRIDA: RideRecord = {
  id: 'ride-30-17',
  passenger_id: 'p1',
  driver_id: 'd1',
  origin_lat: 28.4, origin_lng: -81.3, origin_address: '10064, Trilliums Drive',
  destination_lat: 28.43, destination_lng: -81.31, destination_address: 'MCO',
  status: 'completed',
  price: 30.17,
  distance_km: 21.9,
  paid: false,
  created_at: new Date(AGORA - DIA - 20 * 60 * 1000).toISOString(),
  completed_at: CONCLUIDA,
};

function handler(fn: unknown, nome: string): (...args: unknown[]) => void {
  if (typeof fn !== 'function') {
    throw new Error(`nó sem \`${nome}\` — o JSX da tela mudou`);
  }
  return fn as (...args: unknown[]) => void;
}

function montar(over: Partial<RideRecord> = {}): Renderer {
  const navigation = { navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn() };
  let r!: Renderer;
  act(() => {
    r = create(
      <TripDetailsScreen
        navigation={navigation as never}
        route={{ key: 'k', name: 'TripDetails', params: { ride: { ...CORRIDA, ...over } } } as never}
      />,
    );
  });
  return r;
}

/**
 * Os chips de valor sugerido, achados pelo rótulo de acessibilidade.
 *
 * Deduplicado POR RÓTULO, e não por tipo de nó: o `TouchableOpacity` repassa os
 * mesmos props para a camada que ele renderiza, então cada chip aparece mais de
 * uma vez na árvore. Sem deduplicar, `chips(r)[1]` aponta para o chip 0 e o
 * teste "cobra o valor do chip escolhido" passaria cobrando o valor errado —
 * exatamente o tipo de teste que dá verde sem provar nada.
 */
function chips(r: Renderer) {
  const vistos = new Set<string>();
  return r.root
    .findAll(
      (n) => typeof n.props.accessibilityLabel === 'string'
        && /^\$\d/.test(n.props.accessibilityLabel as string)
        && typeof n.props.onPress === 'function',
    )
    .filter((n) => {
      const rotulo = n.props.accessibilityLabel as string;
      if (vistos.has(rotulo)) return false;
      vistos.add(rotulo);
      return true;
    });
}

/** O campo de valor livre. */
function campoLivre(r: Renderer) {
  const nos = r.root.findAll((n) => typeof n.props.onChangeText === 'function');
  if (!nos.length) throw new Error('campo de valor livre não encontrado');
  return nos[0];
}

/** O botão que confirma a gorjeta: tem onPress e um `disabled` booleano. */
function botaoConfirmar(r: Renderer) {
  const nos = r.root.findAll(
    (n) => typeof n.props.onPress === 'function'
      && typeof n.props.disabled === 'boolean'
      && n.props.accessibilityRole === 'button',
  );
  if (!nos.length) throw new Error('botão de confirmar gorjeta não encontrado');
  return nos[nos.length - 1];
}

beforeEach(() => {
  mockChamadas.length = 0;
  mockAlertas.length = 0;
  // `Alert` espionado no objeto importado, e não pelo caminho interno do módulo:
  // o caminho `react-native/Libraries/Alert/Alert` muda entre versões do RN, e
  // um mock que erra o caminho não falha — só nunca registra nada.
  jest.spyOn(Alert, 'alert').mockImplementation((titulo?: string, msg?: string) => {
    mockAlertas.push({ titulo: titulo ?? '', msg });
  });
  mockResposta.ok = true;
  mockResposta.error = undefined;
  jest.spyOn(Date, 'now').mockReturnValue(AGORA);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('o caminho que não existia', () => {
  it('oferece gorjeta numa corrida concluída e NÃO PAGA — o caso da passageira', () => {
    const r = montar();
    expect(chips(r).length).toBe(TIP_PRESETS.length);
  });

  it('cobra o valor do chip escolhido, em centavos inteiros', async () => {
    const r = montar();
    await act(async () => { handler(chips(r)[1].props.onPress, 'onPress')(); });
    await act(async () => { handler(botaoConfirmar(r).props.onPress, 'onPress')(); });

    expect(mockChamadas).toEqual([{ rideId: 'ride-30-17', cents: TIP_PRESETS[1] * 100 }]);
  });

  it('aceita valor livre com VÍRGULA decimal', async () => {
    const r = montar();
    await act(async () => { handler(campoLivre(r).props.onChangeText, 'onChangeText')('7,50'); });
    await act(async () => { handler(botaoConfirmar(r).props.onPress, 'onPress')(); });

    expect(mockChamadas).toEqual([{ rideId: 'ride-30-17', cents: 750 }]);
  });

  it('o valor livre tem precedência sobre o chip — sem cobrar os dois', async () => {
    const r = montar();
    await act(async () => { handler(chips(r)[2].props.onPress, 'onPress')(); });
    await act(async () => { handler(campoLivre(r).props.onChangeText, 'onChangeText')('3'); });
    await act(async () => { handler(botaoConfirmar(r).props.onPress, 'onPress')(); });

    expect(mockChamadas).toEqual([{ rideId: 'ride-30-17', cents: 300 }]);
  });

  it('não deixa confirmar sem valor escolhido', async () => {
    const r = montar();
    expect(botaoConfirmar(r).props.disabled).toBe(true);
    await act(async () => { handler(botaoConfirmar(r).props.onPress, 'onPress')(); });
    expect(mockChamadas).toEqual([]);
  });

  it('não deixa confirmar abaixo do mínimo da tip-ride', async () => {
    const r = montar();
    await act(async () => { handler(campoLivre(r).props.onChangeText, 'onChangeText')('0,20'); });
    expect(botaoConfirmar(r).props.disabled).toBe(true);
  });

  it('some depois de gorjetar, para ninguém tentar duas vezes', async () => {
    const r = montar();
    await act(async () => { handler(chips(r)[0].props.onPress, 'onPress')(); });
    await act(async () => { handler(botaoConfirmar(r).props.onPress, 'onPress')(); });

    expect(chips(r).length).toBe(0);
    expect(mockChamadas.length).toBe(1);
  });

  it('mostra a gorjeta no resumo sem recarregar a tela', async () => {
    const r = montar();
    await act(async () => { handler(chips(r)[0].props.onPress, 'onPress')(); });
    await act(async () => { handler(botaoConfirmar(r).props.onPress, 'onPress')(); });

    // Varre pelos FILHOS de texto, não pelo tipo do nó: a tipagem própria de
    // `react-test-renderer` deste repo (src/types/react-test-renderer.d.ts) não
    // expõe `type`, de propósito.
    const textos = r.root
      .findAll((n) => typeof n.props.children === 'string')
      .map((n) => n.props.children as string);
    expect(textos.join(' ')).toContain('$5.00');
  });

  it('avisa e MANTÉM a oferta quando a cobrança falha', async () => {
    mockResposta.ok = false;
    mockResposta.error = 'cartão recusado';
    const r = montar();
    await act(async () => { handler(chips(r)[0].props.onPress, 'onPress')(); });
    await act(async () => { handler(botaoConfirmar(r).props.onPress, 'onPress')(); });

    expect(mockAlertas.length).toBe(1);
    expect(mockAlertas[0].msg).toBe('cartão recusado');
    // Some seria pior: a pessoa quis gorjetar, falhou, e perderia a chance.
    expect(chips(r).length).toBe(TIP_PRESETS.length);
  });
});

describe('quando NÃO deve aparecer', () => {
  it('corrida cancelada', () => {
    expect(chips(montar({ status: 'cancelled' })).length).toBe(0);
  });

  it('corrida que já tem gorjeta', () => {
    expect(chips(montar({ tip_amount: 10 })).length).toBe(0);
  });

  it('fora do prazo', () => {
    const velha = new Date(AGORA - (TIP_WINDOW_DAYS + 1) * DIA).toISOString();
    expect(chips(montar({ completed_at: velha, created_at: velha })).length).toBe(0);
  });

  it('corrida de 30 dias atrás — prazo em número ABSOLUTO', () => {
    // O teste acima deriva a idade de `TIP_WINDOW_DAYS` e por isso acompanha
    // qualquer valor da constante. Este não: se alguém transformar o prazo em
    // "praticamente infinito", ele reprova.
    const velha = new Date(AGORA - 30 * DIA).toISOString();
    expect(chips(montar({ completed_at: velha, created_at: velha })).length).toBe(0);
  });

  it('no último dia do prazo ainda aparece — a borda é dentro', () => {
    const noLimite = new Date(AGORA - TIP_WINDOW_DAYS * DIA + 1000).toISOString();
    expect(chips(montar({ completed_at: noLimite })).length).toBe(TIP_PRESETS.length);
  });
});
