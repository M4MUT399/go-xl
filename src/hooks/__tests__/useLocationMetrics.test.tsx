import React from 'react';
import { create, act, type ReactTestRenderer } from 'react-test-renderer';

/**
 * O intervalo entre fixes de GPS — e, principalmente, os dois momentos em que
 * ele NÃO deve existir.
 *
 * Esta amostra mede a cadência com que o SO entrega posição ao app. Ela NÃO é
 * a latência de rastreamento ponta a ponta que a régua de 2 s cobra: falta
 * tudo depois do fix (publicação, realtime, render no aparelho do passageiro).
 * O que se prova aqui é só que a série não é contaminada por dois intervalos
 * que nunca aconteceram: o "antes do primeiro fix" e o "enquanto o
 * rastreamento estava desligado".
 */

type Fix = { coords: { latitude: number; longitude: number; heading: number; speed: number; accuracy: number } };

let mockEntregarFix: ((pos: Fix) => void) | null = null;
const mockRemover = jest.fn();

jest.mock('expo-location', () => ({
  Accuracy: { Balanced: 3, High: 4 },
  requestForegroundPermissionsAsync: () => Promise.resolve({ status: 'granted' }),
  getLastKnownPositionAsync: () => Promise.resolve(null),
  getCurrentPositionAsync: () =>
    Promise.resolve({ coords: { latitude: 28.4, longitude: -81.3, heading: -1, speed: -1, accuracy: 8 } }),
  watchPositionAsync: (_opts: unknown, cb: (pos: Fix) => void) => {
    mockEntregarFix = cb;
    return Promise.resolve({ remove: mockRemover });
  },
}));

import { useLocation } from '../useLocation';
import { clearSamples, recentSamples } from '../../lib/fieldMetrics';

function fix(lat: number): Fix {
  return { coords: { latitude: lat, longitude: -81.3, heading: -1, speed: -1, accuracy: 8 } };
}

function Sonda({ watch }: { watch: boolean }) {
  useLocation({ watch });
  return null;
}

function intervalos() {
  return recentSamples().filter((s) => s.name === 'location_fix_interval');
}

async function montar(): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(<Sonda watch />);
  });
  await act(async () => {});
  return r;
}

/** Liga/desliga o rastreamento SEM desmontar — o ref sobrevive à troca. */
async function alternarWatch(r: ReactTestRenderer, watch: boolean) {
  await act(async () => {
    r.update(<Sonda watch={watch} />);
  });
  await act(async () => {});
}

async function entregar(lat: number) {
  await act(async () => {
    mockEntregarFix?.(fix(lat));
  });
}

beforeEach(() => {
  clearSamples();
  mockEntregarFix = null;
  mockRemover.mockClear();
});

describe('intervalo entre fixes de GPS', () => {
  it('o PRIMEIRO fix não gera intervalo — não há anterior de onde medir', async () => {
    await montar();
    await entregar(28.41);

    expect(intervalos()).toEqual([]);
  });

  it('dois fixes geram um intervalo', async () => {
    await montar();
    await entregar(28.41);
    await entregar(28.42);

    expect(intervalos()).toHaveLength(1);
    expect(intervalos()[0].unit).toBe('ms');
  });

  it('três fixes geram dois intervalos', async () => {
    await montar();
    await entregar(28.41);
    await entregar(28.42);
    await entregar(28.43);

    expect(intervalos()).toHaveLength(2);
  });

  it('o tempo com o rastreamento DESLIGADO não vira intervalo', async () => {
    // Sem zerar o cronômetro no cleanup, o primeiro fix depois de religar
    // fecharia um cronômetro aberto ANTES do desligamento — o motorista com o
    // app em segundo plano apareceria na série como GPS lento.
    //
    // Precisa ser o MESMO componente: `desdeUltimoFix` é um useRef, então
    // desmontar e montar de novo dá um ref zerado de graça e o teste passaria
    // mesmo sem a limpeza. Foi assim que a primeira versão deste arquivo
    // deixou o mutante sobreviver.
    const r = await montar();
    await entregar(28.41);
    await entregar(28.42);
    expect(intervalos()).toHaveLength(1);

    await alternarWatch(r, false);
    await alternarWatch(r, true);
    await entregar(28.44);

    expect(intervalos()).toHaveLength(1);
  });

  it('a amostra carrega a precisão do fix, que explica intervalo ruim', async () => {
    await montar();
    await entregar(28.41);
    await entregar(28.42);

    expect(intervalos()[0].context).toMatchObject({ accuracy: 8 });
  });
});
