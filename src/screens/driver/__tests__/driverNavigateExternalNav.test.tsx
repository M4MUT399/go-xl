import React from 'react';
import { Linking } from 'react-native';
import { create, act } from 'react-test-renderer';

/**
 * A NAVEGAÇÃO EXTERNA APONTA PARA O PONTO DA FASE.
 *
 * Os testes de `externalNav`/`openExternalNav`/`ExternalNavBar` provam a URL, a
 * escolha esquema×https e o toque. Nenhum deles prova a única coisa que só a
 * tela sabe: PARA ONDE mandar. Errar aqui é silencioso e caro — o motorista
 * aceita a corrida, toca em "Waze" e é levado ao DESTINO em vez do passageiro.
 *
 * Por isso a tela inteira é montada, com dois estados de corrida diferentes, e
 * lê-se a URL que o sistema operacional receberia. As duas coordenadas do
 * fixture são diferentes de propósito: se a fase for ignorada, o teste acusa.
 */

const EMBARQUE = { lat: 28.4312, lng: -81.3081 }; // aeroporto de Orlando (MCO)
const DESTINO = { lat: 28.3852, lng: -81.5639 }; // Walt Disney World

const WAZE_ATE_O_EMBARQUE = 'waze://?ll=28.4312,-81.3081&navigate=yes';
const WAZE_ATE_O_DESTINO = 'waze://?ll=28.3852,-81.5639&navigate=yes';
const GMAPS_ATE_O_EMBARQUE = 'comgooglemaps://?daddr=28.4312,-81.3081&directionsmode=driving';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@react-navigation/native', () => ({
  useIsFocused: () => true,
}));

// O mapa nativo não roda fora do device; só precisa existir para a árvore montar.
jest.mock('react-native-maps', () => {
  const React = require('react');
  const { View } = require('react-native');
  const Passa = ({ children }: { children?: React.ReactNode }) =>
    React.createElement(View, null, children);
  class AnimatedRegion {
    setValue() {}
    timing() {
      return { start: () => {} };
    }
  }
  return {
    __esModule: true,
    default: Passa,
    Marker: Passa,
    MarkerAnimated: Passa,
    Polyline: Passa,
    AnimatedRegion,
    PROVIDER_GOOGLE: 'google',
  };
});

jest.mock('../../../hooks/useAuth', () => ({
  useAuth: () => ({ profile: { id: 'motorista-1', jurisdiction: 'global' } }),
}));

// Sem GPS: a barra externa não depende de fix — ela navega para o ponto da
// CORRIDA, não para onde o motorista está.
jest.mock('../../../hooks/useNavigationLocation', () => ({
  useNavigationLocation: () => ({ fix: null }),
}));

jest.mock('../../../hooks/useRide', () => ({
  useDriverRide: () => ({
    updateRideStatus: () => Promise.resolve(true),
    refundRide: () => Promise.resolve(true),
  }),
  notifyPassengerRideCompleted: () => Promise.resolve(),
}));

// Todas as flags desligadas = caminho legado da tela. A barra externa não é
// controlada por flag: tem que aparecer assim mesmo.
jest.mock('../../../hooks/useFeatureFlag', () => ({
  useFeatureFlag: () => false,
}));

jest.mock('../../../hooks/useRoute', () => ({ useRoute: () => ({ route: null }) }));
jest.mock('../../../hooks/useDynamicEta', () => ({
  useDynamicEta: () => ({ etaMin: null, etaSeconds: null, arrival: null }),
}));
jest.mock('../../../hooks/useChatAlert', () => ({ useChatAlert: () => {} }));
jest.mock('../../../hooks/useCameraController', () => ({
  useCameraController: () => ({ follow: () => {}, setReady: () => {} }),
}));

jest.mock('../../../lib/nav/lastCamera', () => ({
  getLastValidCamera: () => null,
  rememberValidCamera: () => {},
}));
jest.mock('../../../lib/nav/backgroundLocationTask', () => ({
  startDriverBackgroundLocation: () => Promise.resolve(),
  stopDriverBackgroundLocation: () => Promise.resolve(),
  releaseRideBackgroundLocation: () => Promise.resolve(),
}));
jest.mock('../../../hooks/useLiveRide', () => ({
  ...jest.requireActual('../../../hooks/useLiveRide'),
  useLiveRide: (r: unknown) => r,
}));
jest.mock('../../../hooks/usePassengerLocation', () => ({
  usePassengerLiveLocation: () => null,
}));
jest.mock('../../../lib/nav/sharedRouteClient', () => ({
  requestServerRoute: () => Promise.resolve(null),
}));
jest.mock('../../../lib/errorReporting', () => ({
  reportWarning: () => {},
  reportError: () => {},
}));
jest.mock('../../../lib/inAppNotify', () => ({ notifyInApp: () => {} }));

jest.mock('expo-location', () => ({
  requestBackgroundPermissionsAsync: () => Promise.resolve({ status: 'denied' }),
}));

// Supabase encadeável e mudo: a tela publica posição e assina canais ao montar.
jest.mock('../../../lib/supabase', () => {
  const canal: any = {
    on: () => canal,
    subscribe: () => canal,
  };
  const consulta: any = {
    select: () => consulta,
    eq: () => consulta,
    single: () => Promise.resolve({ data: null }),
    update: () => consulta,
    upsert: () => Promise.resolve({ error: null }),
    then: (fn: (r: { error: null }) => unknown) => Promise.resolve({ error: null }).then(fn),
  };
  return {
    supabase: {
      from: () => consulta,
      channel: () => canal,
      removeChannel: () => {},
    },
  };
});

// Tradução DE VERDADE, em português.
jest.mock('../../../i18n', () => {
  const { translations } = jest.requireActual('../../../i18n/translations');
  return {
    useTranslation: () => ({
      lang: 'pt',
      t: (k: string, f?: string) => translations.pt[k] ?? f ?? k,
    }),
  };
});

import { DriverNavigateScreen } from '../DriverNavigateScreen';

const CORRIDA_BASE = {
  id: 'corrida-1',
  passenger_id: 'passageiro-1',
  driver_id: 'motorista-1',
  origin_lat: EMBARQUE.lat,
  origin_lng: EMBARQUE.lng,
  origin_address: '9 Terminal Dr, Orlando',
  destination_lat: DESTINO.lat,
  destination_lng: DESTINO.lng,
  destination_address: 'Walt Disney World, Bay Lake',
  price: 84.5,
  distance_km: 27.3,
};

const navegacao: any = { reset: () => {}, goBack: () => {}, navigate: () => {} };

// A tela mantém um cronômetro de 1 s vivo enquanto montada. Sem desmontar ao
// fim de cada teste, ele continua disparando depois que o Jest derruba o
// ambiente e polui a suíte com erros que não são do que se está testando.
const montadas: Array<ReturnType<typeof create>> = [];

async function montarTela(status: string, sobrescreve: Record<string, unknown> = {}) {
  const rota: any = { params: { ride: { ...CORRIDA_BASE, status, ...sobrescreve } } };
  let arvore!: ReturnType<typeof create>;
  await act(async () => {
    arvore = create(<DriverNavigateScreen navigation={navegacao} route={rota} />);
  });
  montadas.push(arvore);
  return arvore;
}

function botaoDe(arvore: ReturnType<typeof create>, testID: string) {
  const achados = arvore.root.findAll((n) => n.props.testID === testID, { deep: false });
  expect(achados).toHaveLength(1);
  return achados[0];
}

async function tocar(arvore: ReturnType<typeof create>, testID: string) {
  const onPress = botaoDe(arvore, testID).props.onPress as () => Promise<void>;
  await act(async () => {
    await onPress();
  });
}

describe('barra Google Maps / Waze na tela de navegação do motorista', () => {
  let abriu: string[];
  let canOpen: jest.SpyInstance;
  let openUrl: jest.SpyInstance;

  beforeEach(() => {
    abriu = [];
    canOpen = jest.spyOn(Linking, 'canOpenURL').mockResolvedValue(true);
    openUrl = jest.spyOn(Linking, 'openURL').mockImplementation(async (url: string) => {
      abriu.push(url);
      return true as any;
    });
  });

  afterEach(async () => {
    await act(async () => {
      while (montadas.length) montadas.pop()!.unmount();
    });
    canOpen.mockRestore();
    openUrl.mockRestore();
  });

  it('na fase de embarque, navega até O PASSAGEIRO', async () => {
    const arvore = await montarTela('accepted');
    await tocar(arvore, 'externalNav-waze');
    expect(abriu).toEqual([WAZE_ATE_O_EMBARQUE]);
  });

  it('na fase de embarque, o botão do Google Maps aponta para o mesmo ponto', async () => {
    const arvore = await montarTela('accepted');
    await tocar(arvore, 'externalNav-googleMaps');
    expect(abriu).toEqual([GMAPS_ATE_O_EMBARQUE]);
  });

  it('com a corrida já em andamento, navega até O DESTINO', async () => {
    // status in_progress = motorista já pegou o passageiro (fase dropoff).
    const arvore = await montarTela('in_progress');
    await tocar(arvore, 'externalNav-waze');
    expect(abriu).toEqual([WAZE_ATE_O_DESTINO]);
  });

  it('os dois botões estão na tela em qualquer uma das fases', async () => {
    for (const status of ['accepted', 'in_progress']) {
      const arvore = await montarTela(status);
      expect(botaoDe(arvore, 'externalNav-googleMaps')).toBeTruthy();
      expect(botaoDe(arvore, 'externalNav-waze')).toBeTruthy();
    }
  });
});

describe('coordenada ausente NÃO vira navegação para o centro de Orlando', () => {
  // `rideOrigin()` troca coordenada nula pelo FALLBACK de src/lib/ride.ts — o
  // centro de Orlando — para o mapa interno ter o que desenhar. Se esse mesmo
  // valor chegasse à barra, o guarda dela nunca dispararia e o Waze passaria a
  // guiar o motorista, com voz e confiança, até uma coordenada inventada.
  //
  // Um mapa no lugar errado o motorista percebe; uma instrução de voz ele segue.
  // Por isso a barra lê a coordenada CRUA e some quando ela não existe.
  it('sem coordenada de embarque, a barra não aparece na fase de pickup', async () => {
    const arvore = await montarTela('accepted', { origin_lat: null, origin_lng: null });
    expect(arvore.root.findAll((n) => n.props.testID === 'externalNav-waze', { deep: false }))
      .toHaveLength(0);
    expect(arvore.root.findAll((n) => n.props.testID === 'externalNav-googleMaps', { deep: false }))
      .toHaveLength(0);
  });

  it('sem coordenada de destino, a barra não aparece na fase de dropoff', async () => {
    const arvore = await montarTela('in_progress', { destination_lat: null, destination_lng: null });
    expect(arvore.root.findAll((n) => n.props.testID === 'externalNav-waze', { deep: false }))
      .toHaveLength(0);
  });

  // O outro lado da moeda: faltar o DESTINO não pode esconder a barra enquanto
  // o motorista ainda está indo buscar o passageiro — a fase manda.
  it('destino ausente não esconde a barra na fase de pickup', async () => {
    const arvore = await montarTela('accepted', { destination_lat: null, destination_lng: null });
    expect(arvore.root.findAll((n) => n.props.testID === 'externalNav-waze', { deep: false }))
      .toHaveLength(1);
  });
});
