import React from 'react';
import { create, act } from 'react-test-renderer';
import { Linking, Platform } from 'react-native';

/**
 * Esta tela é um BLOQUEIO TOTAL. Dois riscos opostos, e os dois são caros:
 * aparecer quando não devia derruba quem está em dia; não aparecer quando devia
 * deixa a build velha precificando corrida com a tabela antiga (charge-ride:466
 * cobra o que o cliente gravar).
 */

const gate: { bloquear: boolean; cfg: unknown } = { bloquear: false, cfg: null };
jest.mock('../../../hooks/useAppUpdateGate', () => ({
  useAppUpdateGate: () => gate,
}));
jest.mock('../../../i18n', () => ({
  useTranslation: () => ({ lang: 'pt', t: (k: string) => k }),
}));
jest.mock('../../../lib/appVersion', () => ({
  versaoDoApp: () => '1.0.0',
  CABECALHO_VERSAO: 'x-goxl-version',
  cabecalhosDeVersao: () => ({}),
}));

import { lerConfigTrava } from '../../../lib/minAppVersion';
import { UpdateRequiredScreen } from '../UpdateRequiredScreen';

const CFG = lerConfigTrava({
  min: '1.0.10',
  enforceServer: true,
  store: { android: 'https://play.exemplo/goxl', ios: 'https://apple.exemplo/goxl' },
  message: { pt: { titulo: 'Atualize', corpo: 'Precisa atualizar.', botao: 'Ir à loja' } },
});

function montar() {
  let r!: ReturnType<typeof create>;
  act(() => { r = create(<UpdateRequiredScreen />); });
  return r;
}

/**
 * `findAll` casa o componente composto E o host que ele renderiza com o mesmo
 * testID, então a contagem crua dobra. Aqui isso não incomoda: o que importa é
 * PRESENÇA e QUAIS testIDs são tocáveis, não quantos nós o renderizador criou.
 *
 * (Filtrar por `n.type === 'string'` seria mais direto, mas a tipagem de
 * `ReactTestInstance` deste projeto não expõe `type` nem `find`.)
 */
function achar(r: ReturnType<typeof create>, testID: string) {
  return r.root.findAll((n) => n.props?.testID === testID);
}

/** Os testIDs distintos que respondem a toque. */
function tocaveis(r: ReturnType<typeof create>): Set<string> {
  return new Set(
    r.root
      .findAll((n) => typeof n.props?.onPress === 'function' && typeof n.props?.testID === 'string')
      .map((n) => n.props.testID as string),
  );
}

/** O `onPress` vive no COMPONENTE (TouchableOpacity), não no host que ele
 *  renderiza — o host recebe só os handlers de responder. */
function tocar(r: ReturnType<typeof create>, testID: string) {
  const alvo = r.root.findAll(
    (n) => n.props?.testID === testID && typeof n.props?.onPress === 'function',
  )[0];
  act(() => { (alvo.props.onPress as () => void)(); });
}

describe('quando NÃO há motivo para bloquear', () => {
  it('não desenha nada', () => {
    gate.bloquear = false;
    gate.cfg = CFG;
    expect(montar().toJSON()).toBeNull();
  });
});

describe('quando a build está abaixo do mínimo', () => {
  beforeEach(() => {
    gate.bloquear = true;
    gate.cfg = CFG;
  });

  it('cobre a tela', () => {
    expect(achar(montar(), 'updateRequiredScreen').length).toBeGreaterThan(0);
  });

  it('usa o texto do idioma vindo da config, não uma chave de i18n', () => {
    const json = JSON.stringify(montar().toJSON());
    expect(json).toContain('Atualize');
    expect(json).toContain('Precisa atualizar.');
  });

  // Sem isto, descobrir em que build um aparelho está exige ir em Ajustes →
  // Apps — foi o que travou o diagnóstico do Motorola por uma rodada inteira.
  it('mostra a versão instalada e o mínimo exigido', () => {
    const json = JSON.stringify(montar().toJSON());
    expect(json).toContain('1.0.0');
    expect(json).toContain('1.0.10');
  });

  it('não oferece nenhuma saída além de atualizar', () => {
    expect(tocaveis(montar())).toEqual(new Set(['updateRequiredButton']));
  });

  it('abre a loja ao tocar', () => {
    const abrir = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
    const r = montar();
    tocar(r, 'updateRequiredButton');
    expect(abrir).toHaveBeenCalledTimes(1);
  });

  // Loja errada por plataforma manda o usuário a um lugar onde ele não pode
  // resolver o problema — e ele fica preso na tela para sempre.
  it('escolhe a loja pela plataforma', () => {
    const abrir = jest.spyOn(Linking, 'openURL').mockResolvedValue(true as never);
    const original = Platform.OS;

    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    let r = montar();
    tocar(r, 'updateRequiredButton');
    expect(abrir).toHaveBeenLastCalledWith('https://play.exemplo/goxl');

    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
    r = montar();
    tocar(r, 'updateRequiredButton');
    expect(abrir).toHaveBeenLastCalledWith('https://apple.exemplo/goxl');

    Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
  });

  // Se não houver quem abra o link, a tela precisa continuar de pé em vez de
  // virar um erro vermelho por cima do aviso.
  it('engole a falha ao abrir a loja', () => {
    jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('sem navegador') as never);
    const r = montar();
    expect(() => tocar(r, 'updateRequiredButton')).not.toThrow();
  });
});
