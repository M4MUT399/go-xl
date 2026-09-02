import React from 'react';
import { create, act } from 'react-test-renderer';
import * as RN from 'react-native';

/**
 * O aviso só pode aparecer quando há o que avisar.
 *
 * O risco desta correção não é o falso negativo (aí o motorista volta a ver o
 * retângulo branco de sempre) e sim o FALSO POSITIVO: um aviso de erro em cima
 * do mapa de todo mundo, inclusive de quem está com o mapa funcionando. Por isso
 * o teste começa pelo caso "a chave está lá".
 */

const mockConfig: { valor: unknown } = { valor: undefined };
jest.mock('expo-constants', () => ({
  __esModule: true,
  get default() {
    return { expoConfig: { android: { config: { googleMaps: { apiKey: mockConfig.valor } } } } };
  },
}));

// `Platform.OS` é trocado no objeto real em vez de por `jest.mock('react-native')`:
// espalhar o módulo inteiro dispara os getters preguiçosos do React Native e o
// arquivo nem carrega.
const mockPlataforma = { os: 'android' };
Object.defineProperty(RN.Platform, 'OS', {
  configurable: true,
  get: () => mockPlataforma.os,
});

const mockAvisos: Array<{ msg: unknown; ctx: unknown }> = [];
jest.mock('../../../lib/errorReporting', () => ({
  reportWarning: (msg: unknown, ctx: unknown) => { mockAvisos.push({ msg, ctx }); },
}));

jest.mock('../../../hooks/useTheme', () => ({
  useTheme: () => ({ colors: require('../../../constants/theme').LightTheme }),
}));

jest.mock('../../../i18n', () => ({
  useTranslation: () => ({
    t: (k: string) => ({ 'nav.map': 'Mapa', 'payment.loadErrorTitle': 'Não foi possível carregar' }[k] ?? k),
  }),
}));

import { MapKeyNotice } from '../MapKeyNotice';

function montar() {
  let arvore!: ReturnType<typeof create>;
  act(() => { arvore = create(<MapKeyNotice />); });
  return arvore;
}

const achouAviso = (arvore: ReturnType<typeof create>) =>
  arvore.root.findAll((n) => n.props?.testID === 'mapKeyNotice', { deep: false }).length > 0;

describe('MapKeyNotice', () => {
  beforeEach(() => {
    mockAvisos.length = 0;
    mockPlataforma.os = 'android';
    mockConfig.valor = undefined;
  });

  it('com a chave no build, não desenha nada e não reporta nada', () => {
    mockConfig.valor = 'AIzaSyEXEMPLO-NAO-E-CHAVE-REAL';
    const arvore = montar();
    expect(achouAviso(arvore)).toBe(false);
    expect(mockAvisos).toHaveLength(0);
  });

  it('no iOS nunca aparece, mesmo sem chave de Android', () => {
    mockPlataforma.os = 'ios';
    const arvore = montar();
    expect(achouAviso(arvore)).toBe(false);
    expect(mockAvisos).toHaveLength(0);
  });

  it('Android sem a chave: aparece na tela E deixa registro no monitoramento', () => {
    const arvore = montar();
    expect(achouAviso(arvore)).toBe(true);
    expect(mockAvisos).toHaveLength(1);
    expect(mockAvisos[0].ctx).toMatchObject({ scope: 'mapsDiagnostics' });
  });

  it('o registro NÃO carrega valor de chave nenhum', () => {
    mockConfig.valor = '';
    montar();
    const serializado = JSON.stringify(mockAvisos);
    expect(serializado).not.toMatch(/AIza/);
  });
});
