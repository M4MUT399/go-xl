const config = require('../../app.config.js');
const { addExternalNavQueries } = require('../externalNavQueries');

/**
 * A CONFIG NATIVA DA NAVEGAÇÃO EXTERNA — AS DUAS METADES.
 *
 * Este é o único pedaço do recurso que NÃO chega por OTA update: mexeu aqui,
 * só vale depois de uma build nova instalada num aparelho. O ciclo para
 * descobrir uma regressão é de dias, e o sintoma no aparelho é mudo — o botão
 * continua na tela, só que sempre caindo no https.
 *
 * Por isso as expectativas abaixo são LITERAIS escritos à mão e conferidos
 * contra os CONSUMIDORES de verdade (o objeto que o Expo lê de app.config.js e
 * o XML que o plugin escreve), nunca contra a constante que os alimenta —
 * comparar a constante consigo mesma passaria com as duas listas erradas.
 *
 * As duas listas são DIFERENTES de propósito: `comgooglemaps://` é o esquema
 * do Google Maps de iOS; no Android o alvo é `google.navigation:`.
 */

describe('iOS — LSApplicationQueriesSchemes', () => {
  it('declara os dois esquemas que o canOpenURL do iPhone precisa consultar', () => {
    expect(config.expo.ios.infoPlist.LSApplicationQueriesSchemes).toEqual([
      'comgooglemaps',
      'waze',
    ]);
  });

  it('não carrega o esquema do Android, que no iPhone não abre nada', () => {
    expect(config.expo.ios.infoPlist.LSApplicationQueriesSchemes).not.toContain(
      'google.navigation',
    );
  });
});

describe('Android — o plugin do <queries> está ligado', () => {
  it('app.config.js registra ./plugins/withExternalNavQueries', () => {
    // Sem esta entrada o plugin nunca roda, o <queries> não é escrito e o
    // canOpenURL do Android 11+ responde false com os apps instalados.
    expect(config.expo.plugins).toContain('./plugins/withExternalNavQueries');
  });

  it('o manifesto resultante declara os esquemas do Android, não os do iOS', () => {
    const manifesto: any = { manifest: {} };
    addExternalNavQueries(manifesto);
    const esquemas = manifesto.manifest.queries[0].intent.flatMap((i: any) =>
      i.data.map((d: any) => d.$['android:scheme']),
    );
    expect(esquemas).toEqual(['google.navigation', 'waze']);
  });
});

describe('as duas metades não são intercambiáveis', () => {
  it('só o Waze aparece nas duas listas', () => {
    const manifesto: any = { manifest: {} };
    addExternalNavQueries(manifesto);
    const android: string[] = manifesto.manifest.queries[0].intent.flatMap((i: any) =>
      i.data.map((d: any) => d.$['android:scheme']),
    );
    const ios: string[] = config.expo.ios.infoPlist.LSApplicationQueriesSchemes;
    expect(android.filter((s) => ios.includes(s))).toEqual(['waze']);
  });
});
