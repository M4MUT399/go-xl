import { openExternalNav, type UrlOpener } from '../openExternalNav';

/**
 * A ESCOLHA ENTRE ESQUEMA DO APP E https.
 *
 * O que importa aqui não é "chamou o Linking", é QUAL URL o motorista recebe em
 * cada situação — inclusive na situação que quebra de verdade: o iOS
 * respondendo `false` a `canOpenURL('waze://')` com o Waze instalado, por falta
 * de `LSApplicationQueriesSchemes`. As URLs esperadas estão escritas à mão, de
 * novo, para o teste não repetir a fórmula do código.
 */

const PONTO = { lat: 28.4312, lng: -81.3081 };

const WAZE_APP = 'waze://?ll=28.4312,-81.3081&navigate=yes';
const WAZE_WEB = 'https://waze.com/ul?ll=28.4312,-81.3081&navigate=yes';
const GMAPS_APP_IOS = 'comgooglemaps://?daddr=28.4312,-81.3081&directionsmode=driving';
const GMAPS_APP_ANDROID = 'google.navigation:q=28.4312,-81.3081&mode=d';
const GMAPS_WEB = 'https://www.google.com/maps/dir/?api=1&destination=28.4312,-81.3081&travelmode=driving';

/** Dublê do Linking: registra tudo o que foi perguntado e aberto. */
function dublê(opts: {
  podeAbrir?: boolean | Error;
  falhaAoAbrir?: 'esquema' | 'tudo';
}): UrlOpener & { perguntou: string[]; abriu: string[] } {
  const perguntou: string[] = [];
  const abriu: string[] = [];
  return {
    perguntou,
    abriu,
    canOpenURL: async (url: string) => {
      perguntou.push(url);
      if (opts.podeAbrir instanceof Error) throw opts.podeAbrir;
      return opts.podeAbrir ?? false;
    },
    openURL: async (url: string) => {
      if (opts.falhaAoAbrir === 'tudo') throw new Error('nada abre');
      if (opts.falhaAoAbrir === 'esquema' && !url.startsWith('https:')) {
        throw new Error('esquema recusado');
      }
      abriu.push(url);
      return true;
    },
  };
}

describe('app instalado e consultável', () => {
  it('abre o Waze pelo esquema, sem tocar no https', async () => {
    const d = dublê({ podeAbrir: true });
    await expect(openExternalNav('waze', PONTO, d)).resolves.toBe('app');
    expect(d.perguntou).toEqual([WAZE_APP]);
    expect(d.abriu).toEqual([WAZE_APP]);
  });

  it('abre o Google Maps pelo esquema', async () => {
    const d = dublê({ podeAbrir: true });
    await expect(openExternalNav('googleMaps', PONTO, d)).resolves.toBe('app');
    expect(d.abriu).toEqual([GMAPS_APP_IOS]);
  });
});

/**
 * O RAMO ANDROID.
 *
 * O jest deste repo roda tudo como iOS (o preset jest-expo transforma com
 * `platform: 'ios'`), então sem passar a plataforma explicitamente metade do
 * recurso ficaria sem teste — que foi exatamente como o `comgooglemaps://`
 * conseguiu ser emitido no Android com a suíte inteira verde.
 */
describe('plataforma decide o esquema', () => {
  it('no Android, o Google Maps é chamado por google.navigation, não por comgooglemaps', async () => {
    const d = dublê({ podeAbrir: true });
    await expect(openExternalNav('googleMaps', PONTO, d, 'android')).resolves.toBe('app');
    expect(d.perguntou).toEqual([GMAPS_APP_ANDROID]);
    expect(d.abriu).toEqual([GMAPS_APP_ANDROID]);
  });

  it('no iOS, o Google Maps é chamado por comgooglemaps', async () => {
    const d = dublê({ podeAbrir: true });
    await expect(openExternalNav('googleMaps', PONTO, d, 'ios')).resolves.toBe('app');
    expect(d.perguntou).toEqual([GMAPS_APP_IOS]);
  });

  it('o Waze recebe a mesma URL nas duas plataformas', async () => {
    const android = dublê({ podeAbrir: true });
    const ios = dublê({ podeAbrir: true });
    await openExternalNav('waze', PONTO, android, 'android');
    await openExternalNav('waze', PONTO, ios, 'ios');
    expect(android.abriu).toEqual([WAZE_APP]);
    expect(ios.abriu).toEqual([WAZE_APP]);
  });

  it('sem o esquema do Android disponível, o https continua sendo o plano B', async () => {
    const d = dublê({ podeAbrir: false });
    await expect(openExternalNav('googleMaps', PONTO, d, 'android')).resolves.toBe('web');
    expect(d.abriu).toEqual([GMAPS_WEB]);
  });
});

describe('esquema indisponível', () => {
  it('canOpenURL false → cai para o https (é o caso do iOS sem LSApplicationQueriesSchemes)', async () => {
    const d = dublê({ podeAbrir: false });
    await expect(openExternalNav('waze', PONTO, d)).resolves.toBe('web');
    expect(d.abriu).toEqual([WAZE_WEB]);
  });

  it('canOpenURL lançando exceção também cai para o https', async () => {
    const d = dublê({ podeAbrir: new Error('sem permissão de consulta') });
    await expect(openExternalNav('googleMaps', PONTO, d)).resolves.toBe('web');
    expect(d.abriu).toEqual([GMAPS_WEB]);
  });

  it('esquema consultável mas que recusa abrir → https', async () => {
    const d = dublê({ podeAbrir: true, falhaAoAbrir: 'esquema' });
    await expect(openExternalNav('waze', PONTO, d)).resolves.toBe('web');
    expect(d.abriu).toEqual([WAZE_WEB]);
  });
});

describe('desfechos sem navegação', () => {
  it('nem o https abre → failed, sem lançar', async () => {
    const d = dublê({ podeAbrir: false, falhaAoAbrir: 'tudo' });
    await expect(openExternalNav('waze', PONTO, d)).resolves.toBe('failed');
    expect(d.abriu).toEqual([]);
  });

  it('coordenada imprestável → invalid e o sistema nem é consultado', async () => {
    const d = dublê({ podeAbrir: true });
    await expect(openExternalNav('waze', { lat: 0, lng: 0 }, d)).resolves.toBe('invalid');
    await expect(openExternalNav('googleMaps', { lat: NaN, lng: 1 }, d)).resolves.toBe('invalid');
    await expect(openExternalNav('waze', null, d)).resolves.toBe('invalid');
    expect(d.perguntou).toEqual([]);
    expect(d.abriu).toEqual([]);
  });
});
