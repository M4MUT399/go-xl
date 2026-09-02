import React from 'react';
import { create, act } from 'react-test-renderer';

/**
 * O TAMANHO DO "VOLTAR" É REQUISITO, NÃO GOSTO.
 *
 * O botão antigo era `{ marginBottom: 20, alignSelf: 'flex-start' }` com texto
 * de 15 px e NENHUM padding — a área tocável era exatamente o desenho do
 * texto, uma faixa de ~18 px. O dono relatou dificuldade de acertar, e pediu
 * 50% maior e um pouco mais para baixo.
 *
 * Sem este teste, o próximo a passar por aqui vê "fontSize: 23" e "paddingVertical:
 * 12" como números arbitrários e os normaliza para o resto do app — desfazendo
 * o conserto sem saber que desfez.
 */

jest.mock('../../../hooks/useTheme', () => ({
  useTheme: () => ({ colors: { primary: '#1A1A2E' } }),
}));

jest.mock('../../../i18n', () => ({
  useTranslation: () => ({ t: (k: string) => (k === 'common.back' ? 'Voltar' : k) }),
}));

import { BackButton } from '../BackButton';

function montar() {
  let r!: ReturnType<typeof create>;
  const aoTocar = jest.fn();
  act(() => { r = create(<BackButton onPress={aoTocar} />); });
  return { r, aoTocar };
}

function achatar(style: unknown): Record<string, unknown> {
  const arr = Array.isArray(style) ? style : [style];
  return Object.assign({}, ...arr.filter(Boolean) as object[]);
}

describe('o alvo de toque', () => {
  it('o texto é 50% maior que os 15 px antigos', () => {
    const { r } = montar();
    const texto = r.root.findAll((n) => typeof n.props?.children !== 'undefined'
      && typeof n.props?.style !== 'undefined'
      && achatar(n.props.style).fontSize === 23);
    expect(texto.length).toBeGreaterThan(0);
  });

  // O alvo vem do PADDING, não da fonte. Aumentar só a fonte deixaria o botão
  // maior de olhar e igualmente difícil de acertar nas bordas.
  it('a altura tocável passa dos 44 pt mínimos da Apple', () => {
    const { r } = montar();
    const botao = r.root.findAll((n) => n.props?.testID === 'backButton')[0];
    const s = achatar(botao.props.style);
    const altura = Number(s.paddingVertical) * 2 + 23;
    expect(altura).toBeGreaterThanOrEqual(44);
  });

  // hitSlop estende a área sensível SEM empurrar o layout vizinho — é o que
  // permite crescer o alvo sem reabrir o espaçamento de cinco telas.
  it('tem hitSlop nos quatro lados', () => {
    const { r } = montar();
    const h = r.root.findAll((n) => n.props?.testID === 'backButton')[0].props.hitSlop as Record<string, number>;
    for (const lado of ['top', 'bottom', 'left', 'right']) {
      expect(h[lado]).toBeGreaterThan(0);
    }
  });

  it('desceu um pouco em relação ao topo', () => {
    const { r } = montar();
    const s = achatar(r.root.findAll((n) => n.props?.testID === 'backButton')[0].props.style);
    expect(Number(s.marginTop)).toBeGreaterThan(0);
  });
});

describe('o botão continua sendo um botão', () => {
  it('chama onPress', () => {
    const { r, aoTocar } = montar();
    const botao = r.root.findAll((n) => n.props?.testID === 'backButton')[0];
    act(() => { (botao.props.onPress as () => void)(); });
    expect(aoTocar).toHaveBeenCalledTimes(1);
  });

  it('anuncia-se como botão para o leitor de tela', () => {
    const { r } = montar();
    const botao = r.root.findAll((n) => n.props?.testID === 'backButton')[0];
    expect(botao.props.accessibilityRole).toBe('button');
    expect(botao.props.accessibilityLabel).toBe('Voltar');
  });
});
