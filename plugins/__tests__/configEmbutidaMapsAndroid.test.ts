import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * POR QUE ESTE TESTE EXISTE.
 *
 * Uma rodada anterior colocou sobre o mapa um aviso — "Google Maps Android key
 * missing in this build" — decidido por
 * `Constants.expoConfig?.android?.config?.googleMaps?.apiKey`. O aviso aparecia
 * para TODO motorista Android, inclusive os que estavam com o mapa desenhando
 * ruas normalmente, porque esse campo não existe num app instalado: o asset
 * `app.config` que o expo-constants embute é gerado com `isPublicConfig: true`,
 * e essa opção APAGA `android.config` e `ios.config` — é justamente onde moram
 * as chaves privadas. O aviso e o módulo que o alimentava foram removidos; o
 * raciocínio completo está em docs/mapa-branco-android.md.
 *
 * O que este teste trava é o FATO que derruba aquele palpite, para que ninguém
 * o reintroduza: com a chave presente no ambiente, ela entra na config do
 * projeto e NÃO entra no artefato que vai para dentro do APK.
 *
 * NÃO É CIRCULAR: não existe função nossa envolvida. O lado A é o
 * `app.config.js` de verdade; o lado B é o script de build de verdade
 * (`expo-constants/scripts/getAppConfig.js`, o mesmo que o Gradle chama no
 * preBuild), executado num processo separado. A chave é um literal falso
 * escrito à mão aqui.
 *
 * O que ele NÃO prova: que o mapa do dono funciona ou deixa de funcionar.
 * Nenhum aparelho foi acessado. Ele prova apenas que o app não tem como saber.
 */

const RAIZ = path.resolve(__dirname, '..', '..');
const CHAVE_FALSA = 'AIzaSy-CHAVE-FALSA-EXCLUSIVA-DESTE-TESTE';
const SCRIPT_DO_BUILD = path.join(
  RAIZ,
  'node_modules/expo-constants/scripts/getAppConfig.js',
);

/** Roda o script real do preBuild e devolve o `app.config` que ele empacota. */
function gerarConfigEmbutida(): { texto: string; config: Record<string, any> } {
  const destino = fs.mkdtempSync(path.join(os.tmpdir(), 'goxl-app-config-'));
  try {
    execFileSync(process.execPath, [SCRIPT_DO_BUILD, RAIZ, destino], {
      cwd: RAIZ,
      env: { ...process.env, EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY: CHAVE_FALSA },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const texto = fs.readFileSync(path.join(destino, 'app.config'), 'utf8');
    return { texto, config: JSON.parse(texto) };
  } finally {
    fs.rmSync(destino, { recursive: true, force: true });
  }
}

describe('lado A — a chave chega à config do projeto', () => {
  const envOriginal = process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY;
  afterAll(() => {
    if (envOriginal === undefined) delete process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY;
    else process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY = envOriginal;
  });

  it('app.config.js coloca a env em android.config.googleMaps.apiKey', () => {
    // Controle positivo: sem isto, a ausência no lado B não provaria nada —
    // poderia ser só uma env que nunca foi lida.
    process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY = CHAVE_FALSA;
    let config: any;
    jest.isolateModules(() => {
      config = require('../../app.config.js');
    });
    expect(config.expo.android.config.googleMaps.apiKey).toBe(CHAVE_FALSA);
  });
});

describe('lado B — a chave NÃO chega ao artefato que vai dentro do APK', () => {
  let texto: string;
  let config: Record<string, any>;
  beforeAll(() => {
    ({ texto, config } = gerarConfigEmbutida());
  });

  it('o artefato gerado é mesmo o deste app', () => {
    // Sanidade: se o script falhasse e devolvesse outra coisa, as asserções
    // seguintes passariam por vacuidade.
    expect(config.slug).toBe('go-xl');
    expect(config.android.package).toBe('com.goxl.app');
  });

  it('android.config foi apagado inteiro pelo filtro de config pública', () => {
    expect(config.android.config).toBeUndefined();
  });

  it('ios.config também — mesma regra, mesma chave privada', () => {
    expect(config.ios.config).toBeUndefined();
  });

  it('nenhum rastro da chave sobra no JSON embutido', () => {
    expect(texto).not.toContain(CHAVE_FALSA);
    expect(texto).not.toContain('AIzaSy');
  });

  it('portanto Constants.expoConfig NUNCA vê a chave: qualquer aviso decidido por esse campo é falso', () => {
    // Este é o desfecho que interessa. O caminho de leitura no aparelho é
    // ConstantsService.kt → asset `app.config` → este JSON. `expo-updates` não
    // é dependência deste projeto, então não há outro caminho em produção.
    const comoOAvisoAntigoLia = (config as any).android?.config?.googleMaps?.apiKey;
    expect(comoOAvisoAntigoLia).toBeUndefined();
    expect(require(path.join(RAIZ, 'package.json')).dependencies['expo-updates']).toBeUndefined();
  });
});
