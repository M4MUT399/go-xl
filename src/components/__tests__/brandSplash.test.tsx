import React from 'react';
import { create, act } from 'react-test-renderer';

/**
 * A ABERTURA TEM DE SAIR DA FRENTE.
 *
 * `splashTimeline.test.ts` prova a regra em aritmética pura. Isso não prova
 * que o COMPONENTE obedece a ela — e é o componente que pode deixar o usuário
 * preso numa tela de logo. O que estes testes cobrem é a fiação:
 *
 *   · o splash nativo só é escondido quando esta tela existe em pixels;
 *   · a saída acontece, por qualquer um dos dois caminhos;
 *   · `onDone` nunca é chamado duas vezes.
 *
 * O relógio é falso (`jest.useFakeTimers`), então os 8 s passam num piscar.
 */

jest.mock('react-native-reanimated', () => require('react-native-reanimated/mock'));

jest.mock('react-native/Libraries/Utilities/useWindowDimensions', () => ({
  __esModule: true,
  default: () => ({ width: 390, height: 844, scale: 3, fontScale: 1 }),
}));

const mockReduzir = { valor: false };
jest.mock('react-native/Libraries/Components/AccessibilityInfo/AccessibilityInfo', () => ({
  __esModule: true,
  default: {
    isReduceMotionEnabled: () => Promise.resolve(mockReduzir.valor),
    addEventListener: () => ({ remove: () => {} }),
  },
}));

import { BrandSplash } from '../BrandSplash';
import { PISO_MS, TETO_MS, SAIDA_MS } from '../../lib/splashTimeline';

type R = ReturnType<typeof create>;

function montar(props: Partial<React.ComponentProps<typeof BrandSplash>> = {}) {
  const feito = jest.fn();
  const visivel = jest.fn();
  let r!: R;
  act(() => {
    r = create(
      <BrandSplash pronto={false} onDone={feito} onVisivel={visivel} {...props} />,
    );
  });
  return { r, feito, visivel };
}

/** Dispara o onLayout da raiz — é ele que faz o relógio da peça começar. */
function darLayout(r: R) {
  const raiz = r.root.findAll(
    (n) => typeof n.props?.onLayout === 'function' && n.props?.pointerEvents === 'none',
  )[0];
  // O `react-test-renderer.d.ts` do repositório tipa `props` como unknown; sem
  // esta ponte o tsc reprova. Se o nó não trouxer `onLayout`, quebra alto — é
  // sinal de que o JSX da abertura mudou e o teste precisa acompanhar.
  const aoLayout = raiz?.props?.onLayout;
  if (typeof aoLayout !== 'function') {
    throw new Error('a raiz da abertura não tem `onLayout` — o JSX mudou');
  }
  act(() => {
    (aoLayout as (e: unknown) => void)({
      nativeEvent: { layout: { width: 390, height: 844, x: 0, y: 0 } },
    });
  });
}

function avancar(ms: number) {
  act(() => { jest.advanceTimersByTime(ms); });
}

beforeEach(() => {
  jest.useFakeTimers();
  mockReduzir.valor = false;
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('a troca com o splash nativo', () => {
  // Se `onVisivel` disparasse na montagem, o splash nativo sumiria antes desta
  // tela existir e o usuário veria um branco entre as duas.
  it('não avisa que está visível antes do primeiro layout', () => {
    const { visivel } = montar();
    expect(visivel).not.toHaveBeenCalled();
  });

  it('avisa no primeiro layout', () => {
    const { r, visivel } = montar();
    darLayout(r);
    expect(visivel).toHaveBeenCalledTimes(1);
  });

  it('não avisa de novo em relayouts (rotação, teclado)', () => {
    const { r, visivel } = montar();
    darLayout(r); darLayout(r); darLayout(r);
    expect(visivel).toHaveBeenCalledTimes(1);
  });
});

describe('o relógio só corre depois de a tela existir', () => {
  // Sem layout não há pixels; deixar o tempo correr aqui faria a animação
  // rodar escondida atrás do splash nativo.
  it('sem layout, nem o teto encerra', () => {
    const { feito } = montar({ pronto: true });
    avancar(TETO_MS + SAIDA_MS + 5000);
    expect(feito).not.toHaveBeenCalled();
  });
});

describe('a saída acontece', () => {
  it('pelo app ficar pronto, respeitando o piso', () => {
    const { r, feito } = montar({ pronto: true });
    darLayout(r);

    avancar(PISO_MS - 50);
    expect(feito).not.toHaveBeenCalled();

    avancar(50 + SAIDA_MS + 50);
    expect(feito).toHaveBeenCalledTimes(1);
  });

  // O caminho que garante que TODO mundo entra: auth pendurado, rede caída,
  // exceção silenciosa no contexto — não importa, a abertura sai.
  //
  // ATENÇÃO À MARGEM. Existe uma rede de segurança que encerra em
  // TETO_MS + SAIDA_MS + 1500. Se este teste avançar até lá, ele passa mesmo
  // com o teto REMOVIDO — foi o que aconteceu na primeira versão, e o teste
  // provava a rede, não o teto. A margem abaixo é deliberadamente menor que a
  // da rede, para que só o teto possa satisfazê-lo.
  it('pelo teto, mesmo com o app NUNCA pronto', () => {
    const { r, feito } = montar({ pronto: false });
    darLayout(r);

    avancar(TETO_MS - 50);
    expect(feito).not.toHaveBeenCalled();

    avancar(50 + SAIDA_MS + 100);
    expect(feito).toHaveBeenCalledTimes(1);
  });

});

describe('a rede de segurança', () => {
  // A rede existe para UM caso: a animação de saída começar e nunca terminar
  // — Reanimated pausado com o app em background, quadro perdido, worklet que
  // não volta. Nesse caso o callback do `withTiming` jamais roda e `onDone`
  // nunca seria chamado, deixando o usuário preso na abertura.
  //
  // Testar isso exige SIMULAR a saída que não completa. Sem isso o teto sempre
  // encerra primeiro e a rede passa despercebida — foi o que aconteceu numa
  // versão anterior deste arquivo, em que remover a rede não quebrava nada.
  it('encerra quando a animação de saída nunca chama de volta', () => {
    const Reanimated = require('react-native-reanimated');
    const espiao = jest
      .spyOn(Reanimated, 'withTiming')
      .mockImplementation((valor: unknown) => valor);

    try {
      const feito = jest.fn();
      let r!: R;
      act(() => { r = create(<BrandSplash pronto={false} onDone={feito} />); });
      darLayout(r);

      // Passa do teto e da duração da saída: sem a rede, nada acontece aqui,
      // porque o callback do withTiming foi engolido.
      avancar(TETO_MS + SAIDA_MS + 100);
      expect(feito).not.toHaveBeenCalled();

      avancar(1500);
      expect(feito).toHaveBeenCalledTimes(1);
    } finally {
      espiao.mockRestore();
    }
  });

  it('com antecipação desligada, espera os 8 s mesmo pronto', () => {
    const { r, feito } = montar({ pronto: true, antecipar: false });
    darLayout(r);

    avancar(PISO_MS + SAIDA_MS + 500);
    expect(feito).not.toHaveBeenCalled();

    avancar(TETO_MS);
    expect(feito).toHaveBeenCalledTimes(1);
  });

  it('o app ficando pronto DEPOIS do piso sai logo em seguida', () => {
    const feito = jest.fn();
    let r!: R;
    act(() => { r = create(<BrandSplash pronto={false} onDone={feito} />); });
    darLayout(r);

    avancar(5000);
    expect(feito).not.toHaveBeenCalled();

    act(() => { r.update(<BrandSplash pronto onDone={feito} />); });
    avancar(SAIDA_MS + 100);
    expect(feito).toHaveBeenCalledTimes(1);
  });
});

describe('onDone é uma vez só', () => {
  // Ele desmonta a abertura. Chamar duas vezes deixaria o app removendo algo
  // que já saiu — e há três disparadores possíveis correndo em paralelo.
  it('nem com pronto e teto batendo juntos', () => {
    const { r, feito } = montar({ pronto: true });
    darLayout(r);
    avancar(TETO_MS * 3);
    expect(feito).toHaveBeenCalledTimes(1);
  });
});

describe('movimento reduzido', () => {
  it('ainda assim a abertura sai', async () => {
    mockReduzir.valor = true;
    const { r, feito } = montar({ pronto: true });
    await act(async () => { await Promise.resolve(); });
    darLayout(r);
    avancar(TETO_MS + SAIDA_MS + 500);
    expect(feito).toHaveBeenCalledTimes(1);
  });
});
