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
    const comoOAvisoAntigoLia = (config as any).android?.config?.googleMaps?.apiKey;
    expect(comoOAvisoAntigoLia).toBeUndefined();
  });
});

/**
 * ── O SEGUNDO CAMINHO, ABERTO EM 03/09/2026 ────────────────────────────────
 *
 * Até aqui este arquivo afirmava que `Constants.expoConfig` tem UMA origem no
 * aparelho — o asset `app.config` gerado com `isPublicConfig: true` — e travava
 * essa premissa com `expect(dependencies['expo-updates']).toBeUndefined()`.
 *
 * O `expo-updates` foi instalado (ver o bloco `updates` em app.config.js: sem
 * OTA, um conserto de uma linha em JS dependia de revisão da Apple, e o QR
 * ficou quebrado no iPhone por dias). Agora existe um segundo caminho: o
 * manifesto do update, servido pela rede.
 *
 * A asserção antiga foi REMOVIDA em vez de ajustada, porque ela protegia a
 * premissa errada. O risco que o OTA realmente cria não é o asset — é o BUNDLE
 * JAVASCRIPT, que viaja a cada update: o Metro inlina qualquer variável
 * `EXPO_PUBLIC_*` que apareça em código empacotado. É esse vetor que o teste
 * abaixo tranca.
 *
 * ── O QUE FOI MEDIDO, E O QUE NÃO FOI ─────────────────────────────────────
 *
 * MEDIDO em 03/09/2026: `expo export --platform android` com a chave falsa no
 * ambiente produziu 0 arquivos contendo `AIzaSy` — com controle positivo (um
 * arquivo plantado com a chave foi encontrado pelo mesmo grep, provando que a
 * varredura enxergava). O payload que sobe no OTA não carrega a chave.
 *
 * NÃO MEDIDO: o conteúdo de `extra.expoClient` no manifesto que a EAS monta ao
 * publicar. Isso exigiria publicar um update de verdade.
 *
 * ⚠️ CORREÇÃO DE UMA AFIRMAÇÃO ANTERIOR DESTE ARQUIVO. Uma versão anterior deste
 * comentário dizia que "expo-updates resolve runtimeVersion e fingerprint com
 * `isPublicConfig: true`", citando resolveRuntimeVersionAsync.js:10. Aquelas
 * linhas existem, mas servem só para LER a política de runtimeVersion; o
 * fingerprint em si é calculado logo abaixo por `createFingerprintAsync`, e o
 * @expo/fingerprint carrega a config num subprocesso com `getConfig(projectRoot,
 * { skipSDKVersionRequirement: true })` — SEM `isPublicConfig`, isto é, a config
 * PRIVADA. As chaves do Maps estão dentro do fingerprint; está medido em
 * plugins/__tests__/fingerprintDoRuntime.test.ts.
 *
 * Portanto NÃO há indício aqui sobre o manifesto, e a conclusão prática é a
 * mesma de antes, só que sem apoio falso: quem publicar o primeiro update deve
 * conferir o manifesto servido por u.expo.dev antes de dar isto por fechado.
 */
describe('o OTA não pode virar um vetor novo para segredo nenhum', () => {
  /**
   * O Metro inlina TODA variável `EXPO_PUBLIC_*` que apareça em código
   * empacotado, e o bundle viaja pela rede a cada update publicado. Antes do
   * OTA, um segredo inlinado ficava dentro do binário da loja; agora ele passa
   * a trafegar.
   *
   * Duas correções sobre a primeira versão deste teste, ambas apontadas na
   * auditoria de 03/09/2026:
   *
   *   1. Ele varria só `src/`. Os pontos de entrada que o Metro empacota
   *      PRIMEIRO — `index.ts` e `App.tsx` — moram na raiz, e uma referência
   *      colocada ali passava verde.
   *   2. Ele casava apenas as duas chaves do Maps, enquanto o texto do próprio
   *      teste falava de "qualquer EXPO_PUBLIC_*". Uma variável nova e
   *      sensível passava sem ser vista.
   *
   * Agora a regra é inversa e por lista de permissão: NENHUMA `EXPO_PUBLIC_*`
   * pode aparecer em código empacotado, exceto as que são públicas por
   * desenho e estão listadas aqui com o motivo.
   */
  const PERMITIDAS = new Set([
    // URL do projeto Supabase. Pública por definição — está no eas.json e em
    // toda requisição que sai do app.
    'EXPO_PUBLIC_SUPABASE_URL',
    // Chave `sb_publishable_…`. Pública por desenho: quem protege os dados é a
    // RLS, não o sigilo dela (ver o cabeçalho de src/lib/supabase.ts).
    'EXPO_PUBLIC_SUPABASE_ANON_KEY',
  ]);

  /** Exatamente o que o Metro empacota: src/ mais os pontos de entrada da raiz. */
  function arquivosEmpacotados(): string[] {
    const achados: string[] = [];
    const anda = (dir: string) => {
      for (const nome of fs.readdirSync(dir)) {
        if (nome === 'node_modules' || nome === '__tests__') continue;
        const caminho = path.join(dir, nome);
        if (fs.statSync(caminho).isDirectory()) anda(caminho);
        else if (/\.(ts|tsx|js|jsx)$/.test(nome) && !/\.test\./.test(nome)) achados.push(caminho);
      }
    };
    anda(path.join(RAIZ, 'src'));
    for (const entrada of ['App.tsx', 'index.ts']) {
      const caminho = path.join(RAIZ, entrada);
      if (fs.existsSync(caminho)) achados.push(caminho);
    }
    return achados;
  }

  const arquivos = arquivosEmpacotados();

  it('encontrou o código empacotado, incluindo os pontos de entrada da raiz', () => {
    // Sem isto, um erro de caminho faria o teste passar por vacuidade.
    expect(arquivos.length).toBeGreaterThan(50);
    expect(arquivos.some((f) => f.endsWith('App.tsx'))).toBe(true);
    expect(arquivos.some((f) => f.endsWith('index.ts'))).toBe(true);
  });

  it('nenhuma EXPO_PUBLIC_* fora da lista de permissão aparece no bundle', () => {
    const ofensas: string[] = [];
    for (const caminho of arquivos) {
      const conteudo = fs.readFileSync(caminho, 'utf8');
      for (const achado of conteudo.match(/EXPO_PUBLIC_[A-Z0-9_]+/g) ?? []) {
        if (!PERMITIDAS.has(achado)) {
          ofensas.push(`${caminho.replace(RAIZ, '')} → ${achado}`);
        }
      }
    }
    expect([...new Set(ofensas)]).toEqual([]);
  });
});
