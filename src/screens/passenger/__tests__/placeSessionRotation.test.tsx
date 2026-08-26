import React from 'react';
import { create, act } from 'react-test-renderer';

/**
 * A ROTAÇÃO do token de sessão do Places, na tela.
 *
 * Por que montar a tela em vez de testar a biblioteca: `searchPlaces` e
 * `resolvePlace` recebem o token PRONTO, então a suíte de `geocoding` só
 * consegue mostrar que ele é repassado igual. Quem decide quando o token nasce,
 * quando é reusado e quando morre é esta tela — e essa decisão é a que vale
 * dinheiro. Se ela quebrar, nada falha, nenhum teste de unidade acusa: a Google
 * simplesmente volta a cobrar por requisição em vez de por sessão, e o primeiro
 * sinal é a fatura.
 *
 * O gerador real de token está coberto em src/lib/__tests__/placesSession.test.ts.
 * Aqui ele é trocado por um contador só para as asserções ficarem legíveis
 * (tok-1, tok-2…) — o que está sob teste é QUANDO a tela pede um token novo.
 */

const mockBuscas: Array<{ query: string; token: string }> = [];
const mockResolucoes: Array<{ placeId: string; token: string }> = [];
const mockEstado = {
  contador: 0,
  // Trocado para null no teste de falha de resolução.
  proximoPonto: { lat: 28.4312, lng: -81.3081 } as { lat: number; lng: number } | null,
};

const SUGESTAO = {
  placeId: 'ChIJ_MCO',
  shortName: 'Orlando International Airport',
  address: 'Orlando, FL, USA',
};

jest.mock('../../../lib/geocoding', () => ({
  newSessionToken: () => `tok-${++mockEstado.contador}`,
  reverseGeocode: () => Promise.resolve(null),
  searchPlaces: (query: string, sessionToken: string) => {
    mockBuscas.push({ query, token: sessionToken });
    return Promise.resolve([SUGESTAO]);
  },
  resolvePlace: (s: { placeId: string }, sessionToken: string) => {
    mockResolucoes.push({ placeId: s.placeId, token: sessionToken });
    return Promise.resolve(mockEstado.proximoPonto);
  },
}));

// A tela puxa `lib/tolls` → `lib/systemConfig` → `lib/supabase`, e o módulo do
// AsyncStorage explode no import fora de um app nativo. Só o import precisa
// sobreviver: nada aqui lê ou escreve armazenamento.
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: () => Promise.resolve(null),
    setItem: () => Promise.resolve(),
    removeItem: () => Promise.resolve(),
  },
}));

jest.mock('react-native-maps', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: View, Marker: View, Polyline: View, PROVIDER_GOOGLE: 'google' };
});

jest.mock('@react-native-community/datetimepicker', () => {
  const { View } = require('react-native');
  return { __esModule: true, default: View };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../../hooks/useLocation', () => ({ useLocation: () => ({ location: null }) }));

jest.mock('../../../hooks/useAuth', () => ({
  useAuth: () => ({ profile: { id: 'p1', jurisdiction: 'FL' } }),
}));

jest.mock('../../../hooks/useRoute', () => ({ useRoute: () => ({ route: null }) }));

jest.mock('../../../hooks/useRide', () => ({
  usePassengerRide: () => ({ requestRide: jest.fn(), scheduleRide: jest.fn() }),
  estimatePrice: () => 0,
  estimateDuration: () => 0,
}));

jest.mock('../../../lib/onboarding', () => ({
  hasPaymentCard: () => true,
  isProfileComplete: () => true,
}));

import { RequestRideScreen } from '../RequestRideScreen';

const DEBOUNCE_MS = 150;

type Renderer = ReturnType<typeof create>;

/**
 * Único ponto onde um prop dinâmico vira função — `props` é `Record<string,
 * unknown>` em `src/types/react-test-renderer.d.ts`, de propósito, para que
 * nenhum nó da árvore aceite `onPress()` só porque o teste acha que deveria.
 *
 * A checagem em tempo de execução importa tanto quanto a de tipo: handler
 * ausente significa que o nó localizado não é o que estes testes pensam que é,
 * e falhar com o NOME dele é mais legível do que um "undefined is not a
 * function" no meio de uma asserção.
 */
function handler(fn: unknown, nome: string): (...args: unknown[]) => void {
  if (typeof fn !== 'function') {
    throw new Error(`nó sem \`${nome}\` — o JSX da tela mudou`);
  }
  return fn as (...args: unknown[]) => void;
}

function montar(): Renderer {
  const navigation = { navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn() };
  let r!: Renderer;
  act(() => {
    r = create(
      <RequestRideScreen
        navigation={navigation as never}
        route={{ params: {} } as never}
      />,
    );
  });
  return r;
}

/** [0] é o campo de embarque, [1] o de destino — nessa ordem no JSX. */
function campos(r: Renderer) {
  const { TextInput } = require('react-native');
  return r.root.findAllByType(TextInput);
}

async function digitar(r: Renderer, campo: 'origin' | 'destination', texto: string) {
  const input = campos(r)[campo === 'origin' ? 0 : 1];
  await act(async () => {
    handler(input.props.onFocus, 'onFocus')();
    handler(input.props.onChangeText, 'onChangeText')(texto);
  });
  await act(async () => {
    jest.advanceTimersByTime(DEBOUNCE_MS);
  });
  // Deixa o `then` da busca assentar antes de olhar a lista.
  await act(async () => {});
}

/**
 * A linha da sugestão vinda da busca — identificada pelo ENDEREÇO dela.
 *
 * Duas armadilhas que este filtro evita: `findAll` solto devolve também o nó
 * host que a TouchableOpacity renderiza (a linha apareceria duplicada), e o
 * campo de embarque abre com uma linha extra "usar minha localização" que
 * carrega o mesmo pino 📍 mas não é sugestão nenhuma.
 */
function linhasDeSugestao(r: Renderer) {
  const { TouchableOpacity } = require('react-native');
  return r.root
    .findAllByType(TouchableOpacity)
    .filter((n) => n.findAll((c) => c.props.children === SUGESTAO.address).length > 0);
}

async function escolherPrimeiraSugestao(r: Renderer) {
  const linhas = linhasDeSugestao(r);
  expect(linhas).toHaveLength(1);
  await act(async () => {
    handler(linhas[0].props.onPress, 'onPress')();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockBuscas.length = 0;
  mockResolucoes.length = 0;
  mockEstado.contador = 0;
  mockEstado.proximoPonto = { lat: 28.4312, lng: -81.3081 };
});

afterEach(() => {
  jest.useRealTimers();
});

describe('sessão do autocomplete na tela', () => {
  it('todas as teclas de uma mesma busca entram na MESMA sessão', async () => {
    const r = montar();
    await digitar(r, 'destination', 'orl');
    await digitar(r, 'destination', 'orlan');
    await digitar(r, 'destination', 'orlando');

    expect(mockBuscas).toHaveLength(3);
    const tokens = new Set(mockBuscas.map((b) => b.token));
    expect(tokens.size).toBe(1);
  });

  it('o details fecha a sessão com o token que a busca usou', async () => {
    const r = montar();
    await digitar(r, 'destination', 'orlando');
    await escolherPrimeiraSugestao(r);

    expect(mockResolucoes).toHaveLength(1);
    expect(mockResolucoes[0].token).toBe(mockBuscas[0].token);
  });

  it('depois da escolha, a busca seguinte abre uma sessão NOVA', async () => {
    const r = montar();
    await digitar(r, 'destination', 'orlando');
    const sessaoFechada = mockBuscas[0].token;
    await escolherPrimeiraSugestao(r);

    await digitar(r, 'destination', 'disney springs');

    const novas = mockBuscas.slice(1);
    expect(novas.length).toBeGreaterThan(0);
    for (const b of novas) {
      // Token reusado depois de fechado faz a Google voltar a cobrar avulso.
      expect(b.token).not.toBe(sessaoFechada);
    }
  });

  it('resolução que FALHA não queima a sessão — não houve details bem-sucedido', async () => {
    const r = montar();
    await digitar(r, 'destination', 'orlando');
    const sessao = mockBuscas[0].token;

    mockEstado.proximoPonto = null;
    await escolherPrimeiraSugestao(r);

    await digitar(r, 'destination', 'orlando int');
    for (const b of mockBuscas.slice(1)) {
      expect(b.token).toBe(sessao);
    }
  });

  it('embarque e destino são sessões independentes', async () => {
    const r = montar();
    await digitar(r, 'destination', 'orlando');
    await digitar(r, 'origin', 'disney');

    const doDestino = mockBuscas.filter((b) => b.query === 'orlando')[0];
    const daOrigem = mockBuscas.filter((b) => b.query === 'disney')[0];
    expect(daOrigem.token).not.toBe(doDestino.token);
  });

  it('escolher no embarque fecha a sessão DO EMBARQUE, não a do destino', async () => {
    // O teste acima só olha as BUSCAS, então não enxerga um `escolherSugestao`
    // que pegue a ref errada. Esse erro é caro duas vezes: as buscas do embarque
    // ficam sem details e viram cobrança avulsa, e a sessão do destino é
    // queimada no meio da digitação dele.
    const r = montar();
    await digitar(r, 'destination', 'orlando');
    await digitar(r, 'origin', 'disney');

    const daOrigem = mockBuscas.filter((b) => b.query === 'disney')[0];
    const doDestino = mockBuscas.filter((b) => b.query === 'orlando')[0];

    await escolherPrimeiraSugestao(r);

    expect(mockResolucoes).toHaveLength(1);
    expect(mockResolucoes[0].token).toBe(daOrigem.token);
    expect(mockResolucoes[0].token).not.toBe(doDestino.token);
  });
});
