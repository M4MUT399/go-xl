import React from 'react';
import { Alert } from 'react-native';
import { create, act } from 'react-test-renderer';

/**
 * A BARRA "GOOGLE MAPS / WAZE", NA TELA.
 *
 * `externalNav.test.ts` prova que as URLs saem certas e `openExternalNav.test.ts`
 * prova a escolha entre esquema e https. Nenhum dos dois prova que o TOQUE do
 * motorista chega lá com a coordenada certa — que é justamente onde uma barra
 * bonita e inerte passaria despercebida. Aqui monta-se o componente, toca-se no
 * botão e lê-se a URL que o sistema receberia.
 */

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

import { ExternalNavBar } from '../ExternalNavBar';

const EMBARQUE = { lat: 28.4312, lng: -81.3081, label: '9 Terminal Dr, Orlando' };

const WAZE_APP = 'waze://?ll=28.4312,-81.3081&navigate=yes';
const GMAPS_APP = 'comgooglemaps://?daddr=28.4312,-81.3081&directionsmode=driving';
const GMAPS_WEB = 'https://www.google.com/maps/dir/?api=1&destination=28.4312,-81.3081&travelmode=driving';

function dublê(podeAbrir: boolean) {
  const abriu: string[] = [];
  return {
    abriu,
    canOpenURL: async () => podeAbrir,
    openURL: async (url: string) => {
      abriu.push(url);
      return true;
    },
  };
}

async function montar(props: React.ComponentProps<typeof ExternalNavBar>) {
  let arvore!: ReturnType<typeof create>;
  await act(async () => {
    arvore = create(<ExternalNavBar {...props} />);
  });
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

describe('barra de navegação externa', () => {
  it('mostra os dois nomes, nessa ordem, sem traduzir', async () => {
    const arvore = await montar({ target: EMBARQUE, opener: dublê(true) });
    const textos = arvore.root
      .findAll((n) => typeof n.props.children === 'string', { deep: false })
      .map((n) => n.props.children as string);
    expect(textos).toEqual(['Google Maps', 'Waze']);
  });

  it('o toque no Waze manda o esquema do app com a coordenada do alvo', async () => {
    const d = dublê(true);
    const arvore = await montar({ target: EMBARQUE, opener: d });
    await tocar(arvore, 'externalNav-waze');
    expect(d.abriu).toEqual([WAZE_APP]);
  });

  it('o toque no Google Maps manda o esquema do Google Maps', async () => {
    const d = dublê(true);
    const arvore = await montar({ target: EMBARQUE, opener: d });
    await tocar(arvore, 'externalNav-googleMaps');
    expect(d.abriu).toEqual([GMAPS_APP]);
  });

  it('sem poder consultar o esquema, o toque ainda leva o motorista pelo https', async () => {
    const d = dublê(false);
    const arvore = await montar({ target: EMBARQUE, opener: d });
    await tocar(arvore, 'externalNav-googleMaps');
    expect(d.abriu).toEqual([GMAPS_WEB]);
  });

  it('avisa o motorista quando nada abriu', async () => {
    const alerta = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const opener = {
      canOpenURL: async () => false,
      openURL: async () => {
        throw new Error('nada abre');
      },
    };
    const arvore = await montar({ target: EMBARQUE, opener });
    await tocar(arvore, 'externalNav-waze');
    expect(alerta).toHaveBeenCalledWith('Waze', 'Não foi possível iniciar a rota agora. Tente novamente.');
    alerta.mockRestore();
  });

  it('não avisa nada quando abriu normalmente', async () => {
    const alerta = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    const arvore = await montar({ target: EMBARQUE, opener: dublê(true) });
    await tocar(arvore, 'externalNav-waze');
    expect(alerta).not.toHaveBeenCalled();
    alerta.mockRestore();
  });

  it('some inteira quando a coordenada do alvo não presta', async () => {
    const arvore = await montar({ target: { lat: 0, lng: 0 }, opener: dublê(true) });
    expect(arvore.toJSON()).toBeNull();
    const semFix = await montar({ target: { lat: null, lng: null }, opener: dublê(true) });
    expect(semFix.toJSON()).toBeNull();
  });

  it('reporta o desfecho de cada toque a quem montou a barra', async () => {
    const desfechos: string[] = [];
    const arvore = await montar({
      target: EMBARQUE,
      opener: dublê(false),
      onOpen: (_app, desfecho) => desfechos.push(desfecho),
    });
    await tocar(arvore, 'externalNav-waze');
    expect(desfechos).toEqual(['web']);
  });

  it('o rótulo do ponto vai para a acessibilidade, não para a URL', async () => {
    const d = dublê(true);
    const arvore = await montar({ target: EMBARQUE, opener: d });
    expect(botaoDe(arvore, 'externalNav-waze').props.accessibilityLabel).toBe(
      'Waze — 9 Terminal Dr, Orlando',
    );
    await tocar(arvore, 'externalNav-waze');
    expect(d.abriu[0]).not.toContain('Terminal');
  });
});
