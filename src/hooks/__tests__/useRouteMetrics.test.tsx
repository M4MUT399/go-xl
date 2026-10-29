import React from 'react';
import { create, act, type ReactTestRenderer } from 'react-test-renderer';

/**
 * O RÓTULO que o `useRoute` põe em cada cálculo de rota.
 *
 * Não existe caminho de código separado para reroute: sair da rota mexe na
 * origem e cai no mesmo efeito. Então a régua de 3 s do reroute só é legível
 * se `trigger` estiver certo — um `origin_change` rotulado como `refresh`
 * esconde exatamente as amostras que a régua cobra, e some sem sintoma.
 *
 * A duração em si está coberta em src/lib/__tests__/fieldMetrics.test.ts. Aqui
 * ninguém olha número de relógio: só qual amostra existe e com que rótulo.
 */

const mockFlag = { directionsV2: false };

let mockRotaOsrm: () => Promise<unknown>;
let mockRotaGoogle: () => Promise<unknown>;

jest.mock('../../lib/routing', () => ({
  getRoute: () => mockRotaOsrm(),
  getRouteViaDirections: () => mockRotaGoogle(),
}));

jest.mock('../useFeatureFlag', () => ({
  useFeatureFlag: () => mockFlag.directionsV2,
}));

import { useRoute } from '../useRoute';
import { clearSamples, recentSamples } from '../../lib/fieldMetrics';

const ROTA = { coordinates: [], distanceKm: 5, durationMin: 9, steps: [] };
const A = { lat: 28.4312, lng: -81.3081 };
const B = { lat: 28.5383, lng: -81.3792 };
const C = { lat: 28.3852, lng: -81.5639 };

function Sonda({
  origin,
  dest,
  refreshKey,
}: {
  origin: { lat: number; lng: number } | null;
  dest: { lat: number; lng: number } | null;
  refreshKey?: number;
}) {
  useRoute(origin, dest, refreshKey);
  return null;
}

function gatilhos(): unknown[] {
  return recentSamples()
    .filter((s) => s.name === 'route_compute')
    .map((s) => (s.context as { trigger?: unknown } | undefined)?.trigger);
}

async function montar(props: React.ComponentProps<typeof Sonda>): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(<Sonda {...props} />);
  });
  await act(async () => {});
  return r;
}

async function rerenderizar(r: ReactTestRenderer, props: React.ComponentProps<typeof Sonda>) {
  await act(async () => {
    r.update(<Sonda {...props} />);
  });
  await act(async () => {});
}

beforeEach(() => {
  clearSamples();
  mockFlag.directionsV2 = false;
  mockRotaOsrm = () => Promise.resolve(ROTA);
  mockRotaGoogle = () => Promise.resolve(null);
});

describe('rótulo do cálculo de rota', () => {
  it('o primeiro cálculo é `initial`', async () => {
    await montar({ origin: A, dest: B });
    expect(gatilhos()).toEqual(['initial']);
  });

  it('mudar a ORIGEM é `origin_change` — é assim que o reroute aparece', async () => {
    // DriverNavigateScreen chama setRouteOrigin ao detectar off-route; do ponto
    // de vista deste hook, um desvio é indistinguível de qualquer outra troca
    // de origem, e é por isso que o rótulo precisa ser exatamente este.
    const r = await montar({ origin: A, dest: B });
    await rerenderizar(r, { origin: C, dest: B });

    expect(gatilhos()).toEqual(['initial', 'origin_change']);
  });

  it('mexer só no refreshKey é `refresh`', async () => {
    // A cadência de ~45 s que renova o ETA com trânsito. Se ela saísse como
    // origin_change, inundaria a série do reroute com cálculos de rotina e a
    // régua de 3 s passaria a medir outra coisa.
    const r = await montar({ origin: A, dest: B, refreshKey: 1 });
    await rerenderizar(r, { origin: A, dest: B, refreshKey: 2 });

    expect(gatilhos()).toEqual(['initial', 'refresh']);
  });

  it('re-render sem mudar nada não gera cálculo nenhum', async () => {
    const r = await montar({ origin: A, dest: B });
    await rerenderizar(r, { origin: { ...A }, dest: { ...B } });

    expect(gatilhos()).toEqual(['initial']);
  });

  it('sem origem ou destino não há espera para medir', async () => {
    await montar({ origin: null, dest: B });
    expect(recentSamples()).toEqual([]);
  });
});

describe('o que a amostra carrega', () => {
  it('marca quando a Google falhou e a espera incluiu a queda no OSRM', async () => {
    mockFlag.directionsV2 = true;
    mockRotaGoogle = () => Promise.resolve(null);

    await montar({ origin: A, dest: B });

    const [s] = recentSamples().filter((x) => x.name === 'route_compute');
    expect(s.context).toMatchObject({ trigger: 'initial', fellBack: true, got: true });
  });

  it('com a flag desligada não existe queda a reportar', async () => {
    await montar({ origin: A, dest: B });

    const [s] = recentSamples().filter((x) => x.name === 'route_compute');
    expect(s.context).toMatchObject({ fellBack: false });
  });

  it('rota que não veio ainda é uma espera — `got: false`', async () => {
    mockRotaOsrm = () => Promise.resolve(null);

    await montar({ origin: A, dest: B });

    const [s] = recentSamples().filter((x) => x.name === 'route_compute');
    expect(s.context).toMatchObject({ got: false });
  });

  it('cálculo abandonado no meio ainda vira amostra', async () => {
    // Descartar o que foi cancelado tiraria da série justamente os cálculos
    // mais LENTOS — são eles que o usuário abandona. A média sobrevivente
    // ficaria bonita e falsa.
    let liberar!: (v: unknown) => void;
    mockRotaOsrm = () => new Promise((resolve) => { liberar = resolve; });

    const r = await montar({ origin: A, dest: B });
    expect(gatilhos()).toEqual([]);

    await act(async () => {
      r.unmount();
    });
    await act(async () => {
      liberar(ROTA);
    });

    expect(gatilhos()).toEqual(['initial']);
  });
});
