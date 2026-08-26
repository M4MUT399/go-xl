import React from 'react';
import { create, act } from 'react-test-renderer';

/**
 * A LINHA DA TAXA, NA TELA DO MOTORISTA.
 *
 * `driverFareLines.test.ts` prova a regra: quando há taxa, sai uma linha com o
 * sinal certo. Isso não prova que a linha CHEGA na tela — a prop `fareBreakdown`
 * existia em IncomingRideCall desde a P6 e ficou o tempo todo vazia, que é
 * exatamente o defeito que se está consertando. Um teste de unidade teria
 * passado durante todo esse tempo.
 *
 * Estes montam o card de chamada e leem o texto que o motorista veria.
 */

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('../../../hooks/useRideCallAlert', () => ({
  useRideCallAlert: () => {},
}));

jest.mock('../../../lib/routing', () => ({
  getRoute: () => Promise.resolve(null),
}));

jest.mock('../../../lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({ eq: () => ({ single: () => Promise.resolve({ data: null }) }) }),
    }),
  },
}));

// Tradução DE VERDADE, em português: se a chave sumir do translations.ts, o
// texto esperado não aparece e o teste cai.
jest.mock('../../../i18n', () => {
  const { translations } = jest.requireActual('../../../i18n/translations');
  return {
    useTranslation: () => ({
      lang: 'pt',
      t: (k: string, f?: string) => translations.pt[k] ?? f ?? k,
    }),
  };
});

import { IncomingRideCall } from '../IncomingRideCall';
// ── Mocks só do overlay (o bloco final monta a cadeia inteira) ──────────────
const mockCorridaPendente: { atual: unknown } = { atual: null };

jest.mock('../../../hooks/useAuth', () => ({ useAuth: () => ({ profile: { id: 'd1' } }) }));

jest.mock('../../../contexts/DriverRideContext', () => ({
  useDriverRideContext: () => ({
    pendingRide: mockCorridaPendente.atual,
    dismissOffer: () => {},
    rejectServerOffer: () => {},
    acceptRide: () => Promise.resolve(null),
    isOnline: true,
    location: { lat: 28.43, lng: -81.31 },
    resumableRide: null,
    clearResumableRide: () => {},
  }),
}));

jest.mock('../../../lib/systemConfig', () => ({
  getConfig: () => Promise.resolve(30),
  getConfigDefault: () => 30,
}));

jest.mock('../../../lib/rideOfferEvents', () => ({ logRideOfferEvent: () => {} }));
jest.mock('../../../lib/notifications', () => ({ dismissRideNotifications: () => {} }));
jest.mock('../../../lib/offerAlertManager', () => ({
  offerAlertManager: { stopAll: () => {}, stop: () => {} },
}));
jest.mock('../../../navigation/AppNavigator', () => ({
  navigationRef: { isReady: () => false, navigate: () => {} },
}));
jest.mock('../../../native/carRideBridge', () => ({
  addCarRideActionListener: () => () => {},
}));

import { GlobalDriverRideOverlay } from '../GlobalDriverRideOverlay';

import { driverFareLines } from '../../../lib/driverFareLines';
import { translations } from '../../../i18n/translations';
import type { Ride } from '../../../types';

type Renderer = ReturnType<typeof create>;

/** Todo texto renderizado, achatado — é o que o motorista leria na tela. */
function textos(r: Renderer): string[] {
  const out: string[] = [];
  const anda = (n: unknown): void => {
    if (n == null || typeof n === 'boolean') return;
    if (typeof n === 'string') { out.push(n); return; }
    if (typeof n === 'number') { out.push(String(n)); return; }
    if (Array.isArray(n)) { n.forEach(anda); return; }
    anda((n as { children?: unknown }).children);
  };
  anda(r.toJSON());
  return out;
}

// A corrida real de 25/08: MCO → Oak Ridge, $28,06 de tarifa. Com a zona `mco`
// no ar, o passageiro paga $35,06 e $7,00 são do aeroporto.
const CORRIDA = {
  id: 'r1',
  passenger_id: 'p1',
  origin_lat: 28.4294, origin_lng: -81.3089,
  origin_address: 'Orlando International Airport',
  destination_lat: 28.4640, destination_lng: -81.4130,
  destination_address: '3916 Scotsboro Court, Oak Ridge',
  status: 'requesting',
  price: 35.06,
  distance_km: 19.3,
  duration_min: 25,
  airport_port_fee: 7,
} as unknown as Ride;

function montar(over: Record<string, unknown> = {}): Renderer {
  const ride = { ...CORRIDA, ...over } as Ride;
  const linhas = driverFareLines(ride).map((l) => ({
    label: translations.pt[l.labelKey] ?? l.labelKey,
    value: l.value,
  }));
  let r!: Renderer;
  act(() => {
    r = create(
      <IncomingRideCall
        ride={ride}
        driverLocation={{ lat: 28.43, lng: -81.31 }}
        timeoutSeconds={30}
        accepting={false}
        isQrLocked={false}
        fareBreakdown={linhas}
        onAccept={() => {}}
        onReject={() => {}}
        onExpire={() => {}}
      />,
    );
  });
  return r;
}

describe('corrida com embarque no MCO', () => {
  it('mostra o rótulo da taxa, em português', () => {
    expect(textos(montar())).toContain('Taxa de aeroporto / porto');
  });

  it('mostra a dedução com o sinal de menos', () => {
    expect(textos(montar())).toContain('− $7.00');
  });

  it('o total continua sendo o que o passageiro paga', () => {
    // O motorista precisa ver o total: é o que aparece no extrato do passageiro
    // e é sobre ele que a conversa acontece. A linha abaixo é que explica.
    expect(textos(montar())).toContain('$35.06');
  });

  it('não exibe o valor da taxa sem sinal, para não parecer receita', () => {
    expect(textos(montar())).not.toContain('$7.00');
  });
});

describe('corrida comum, sem aeroporto', () => {
  it('não mostra linha nenhuma de taxa', () => {
    const t = textos(montar({ airport_port_fee: 0, price: 28.06 }));
    expect(t).toContain('$28.06');
    expect(t).not.toContain('Taxa de aeroporto / porto');
    expect(t.some((x) => x.startsWith('−'))).toBe(false);
  });
});

/**
 * A CADEIA INTEIRA — a corrida vem do contexto, o overlay decide, o card
 * desenha. É este bloco que pega o defeito real: a prop existia e ninguém a
 * passava. Se alguém remover `fareBreakdown={...}` do overlay, os testes de
 * unidade e os de render acima continuam VERDES; só estes caem.
 */
describe('do contexto até a tela, sem atalho', () => {
  function montarOverlay(ride: Record<string, unknown>): Renderer {
    mockCorridaPendente.atual = ride;
    let r!: Renderer;
    act(() => { r = create(<GlobalDriverRideOverlay />); });
    return r;
  }

  it('corrida com taxa → o motorista vê o rótulo e a dedução', () => {
    const t = textos(montarOverlay(CORRIDA as unknown as Record<string, unknown>));
    expect(t).toContain('Taxa de aeroporto / porto');
    expect(t).toContain('− $7.00');
    expect(t).toContain('$35.06');
  });

  it('corrida sem aeroporto → nada de linha extra', () => {
    const t = textos(montarOverlay({ ...CORRIDA, airport_port_fee: 0, price: 28.06 } as unknown as Record<string, unknown>));
    expect(t).toContain('$28.06');
    expect(t).not.toContain('Taxa de aeroporto / porto');
  });
});
