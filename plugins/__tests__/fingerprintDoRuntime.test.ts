import { execFileSync } from 'child_process';
import path from 'path';

/**
 * O `fingerprint.config.js` FALHA EM SILÊNCIO — por isso ele precisa de teste.
 *
 * `@expo/fingerprint/build/Config.js` faz `try { require(arquivo) } catch {
 * rawConfig = {} }`, e `normalizeSourceSkips` descarta sem reclamar qualquer
 * string que não seja membro do enum. Um erro de digitação — `sourceSkip`,
 * `'ExpoConfigVersion'`, salvar como `.mjs` — não levanta nada: o skip
 * simplesmente deixa de valer, o runtimeVersion muda, e você descobre por um
 * update que não chega a ninguém. Era a única peça desta instalação com falha
 * 100% silenciosa e zero cobertura.
 *
 * ── POR QUE CADA MEDIÇÃO RODA NUM PROCESSO SEPARADO ───────────────────────
 *
 * Uma primeira versão deste teste chamava `createFingerprintAsync` várias vezes
 * DENTRO do processo do jest e produziu resultados que se contradiziam: dois
 * testes afirmavam, ao mesmo tempo, que o hash do projeto era o de `1|512` e o
 * de `1` sozinho. Não podem ser os dois. A biblioteca carrega a config num
 * subprocesso e há cache pelo caminho; medir tudo no mesmo processo não
 * reproduz o que a EAS faz na build.
 *
 * Aqui cada número sai de um `node -e` próprio, com o env explícito — que é
 * como o `expo-updates` calcula na build.
 *
 * NÃO É CIRCULAR: nenhum nome de skip é lido do arquivo de configuração. Os
 * valores são os números do enum, e o que se compara é comportamento medido.
 */

const RAIZ = path.resolve(__dirname, '..', '..');

/** Valores do enum SourceSkips — fixados aqui para não depender do config. */
const VERSIONS = 1;
const PREBUILD_SCRIPTS = 512;

jest.setTimeout(300_000);

/**
 * Calcula o fingerprint num processo limpo.
 * `skips === null` significa "sem opção nenhuma" — é aí que o
 * fingerprint.config.js do projeto vale.
 */
function hash(skips: number | null, envExtra: Record<string, string> = {}): string {
  const script = `
    const { createFingerprintAsync } = require(${JSON.stringify(path.join(RAIZ, 'node_modules/@expo/fingerprint'))});
    const opcoes = ${skips === null ? '{ platforms: ["android"] }' : `{ platforms: ["android"], sourceSkips: ${skips} }`};
    createFingerprintAsync(${JSON.stringify(RAIZ)}, opcoes)
      .then((f) => { process.stdout.write(f.hash); })
      .catch((e) => { console.error(e); process.exit(1); });
  `;
  return execFileSync(process.execPath, ['-e', script], {
    cwd: RAIZ,
    encoding: 'utf8',
    env: { ...process.env, ...envExtra },
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

describe('o fingerprint.config.js está sendo carregado e surtindo efeito', () => {
  let doProjeto: string;
  beforeAll(() => { doProjeto = hash(null); });

  it('o cálculo é determinístico — sem isto nada abaixo significa nada', () => {
    expect(hash(null)).toBe(doProjeto);
    expect(doProjeto).toMatch(/^[0-9a-f]{40}$/);
  });

  it('o hash do projeto é exatamente o de ExpoConfigVersions + o default da biblioteca', () => {
    expect(doProjeto).toBe(hash(VERSIONS | PREBUILD_SCRIPTS));
  });

  it('não é o de skip nenhum — o arquivo de configuração está sendo lido', () => {
    expect(doProjeto).not.toBe(hash(0));
  });

  // O default da biblioteca (512) existe para o hash bater ANTES e DEPOIS do
  // `expo prebuild`, que é o que a EAS roda no servidor. Uma primeira versão do
  // fingerprint.config.js listou só o ExpoConfigVersions e, sem perceber,
  // SUBSTITUIU esse default — `sourceSkips` do arquivo não soma, sobrescreve.
  it('o default de consistência pré/pós-prebuild NÃO foi perdido', () => {
    expect(doProjeto).not.toBe(hash(VERSIONS));
  });

  it('e o skip de versões também está lá', () => {
    expect(doProjeto).not.toBe(hash(PREBUILD_SCRIPTS));
  });
});

describe('o que o runtimeVersion ignora e o que ele NÃO ignora', () => {
  // ⚠️ O fato que mais surpreende quem lê "fingerprint" e pensa "superfície
  // nativa": as chaves do Maps vêm de env e ENTRAM no hash, porque o
  // fingerprint carrega a config PRIVADA. É por isso que publicar um update
  // exige `--environment production` — ver fingerprint.config.js.
  it('trocar a chave do Google Maps MUDA o runtimeVersion', () => {
    const comAChaveDoProjeto = hash(null);
    const comOutraChave = hash(null, {
      EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY: 'AIzaSy-OUTRA-CHAVE-SO-DESTE-TESTE',
    });
    expect(comOutraChave).not.toBe(comAChaveDoProjeto);
  });
});
