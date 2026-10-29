/**
 * Configuração do @expo/fingerprint — o que entra e o que NÃO entra no
 * `runtimeVersion` do EAS Update.
 *
 * O `runtimeVersion` é o casamento entre um update publicado e as builds que
 * podem executá-lo. Com a política `fingerprint`, ele é um hash do projeto.
 * Errar aqui não levanta erro: publica-se para um runtime que build nenhuma
 * tem, e o conserto não chega a ninguém, calado. Leia este arquivo inteiro
 * antes de publicar.
 *
 * ── POR QUE `ExpoConfigVersions` ──────────────────────────────────────────
 *
 * Tira `version`, `versionCode` e `buildNumber` do hash. Neste projeto os três
 * são ruído:
 *
 *   • `appVersionSource: "remote"` + `autoIncrement: true` (eas.json) fazem a
 *     EAS decidir versionCode/buildNumber no servidor, a cada build. Os
 *     literais `versionCode: 1` e `buildNumber: '1'` que sobraram em
 *     app.config.js são ignorados na build e ainda assim entravam no hash —
 *     duas fontes divergentes para o mesmo dado.
 *
 *   • `version` sobe a cada release. Sem o skip, um conserto de JavaScript
 *     alcançaria só quem está na versão exata daquele dia. Com ele, o mesmo
 *     bundle alcança 1.0.12, 1.0.13 e adiante.
 *
 * ── POR QUE O SEGUNDO SKIP TAMBÉM PRECISA ESTAR AQUI ──────────────────────
 *
 * `sourceSkips` vindo deste arquivo SUBSTITUI o default da biblioteca, não
 * soma: em Options.js as opções são montadas como `{...defaults, ...config}`.
 * O default é `PackageJsonAndroidAndIosScriptsIfNotContainRun` (512), e ele
 * existe para o hash bater ANTES e DEPOIS do `expo prebuild` — que é
 * exatamente o que a EAS roda no servidor deste projeto (CNG, sem pastas
 * nativas versionadas). Uma primeira versão deste arquivo listava só o
 * `ExpoConfigVersions` e, sem perceber, desligou essa rede de proteção.
 *
 * ── ⚠️ O QUE CONTINUA NO HASH, E SURPREENDE ───────────────────────────────
 *
 * NÃO é só "superfície nativa". Também entram, entre 152 fontes:
 *
 *   • as CHAVES do Google Maps, que vêm de env — o fingerprint carrega a
 *     config PRIVADA (@expo/fingerprint/build/ExpoConfigLoader.js chama
 *     `getConfig` SEM `isPublicConfig`), então `android.config.googleMaps
 *     .apiKey` está lá dentro;
 *   • a seção `scripts` do package.json;
 *   • o próprio `eas.json`;
 *   • o `.gitignore`.
 *
 * Isso tem consequência prática imediata: acrescentar um script npm ou editar
 * o eas.json TROCA o runtimeVersion. O lote que criou este arquivo fez as duas
 * coisas.
 *
 * E a consequência mais perigosa: como as chaves vêm de env (`.env.local` no
 * laptop, ambiente da EAS na build), publicar de uma máquina com env diferente
 * gera um runtime órfão. Por isso:
 *
 *   1. publique SEMPRE com `npm run update:producao`, que força
 *      `--environment production` para a EAS injetar as mesmas variáveis;
 *   2. confira DEPOIS com `npm run update:confere`.
 *
 * ── COMO REPRODUZIR AS MEDIÇÕES ───────────────────────────────────────────
 *
 * Nenhum hash é citado aqui de propósito: ele muda a cada mexida no projeto, e
 * número em prosa que não reproduz é pior que número nenhum. Para medir:
 *
 *   npx @expo/fingerprint fingerprint:generate --platform android
 *
 * Rode duas vezes mudando UMA coisa (a chave numa env, um script no
 * package.json) e compare. O teste
 * plugins/__tests__/fingerprintDoRuntime.test.ts tranca o que importa.
 */
module.exports = {
  sourceSkips: [
    'ExpoConfigVersions',
    'PackageJsonAndroidAndIosScriptsIfNotContainRun',
  ],
};
