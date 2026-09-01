/**
 * Mutação PURA do AndroidManifest para a navegação externa (Google Maps / Waze).
 *
 * Vive separada de `withExternalNavQueries.js` porque aquele arquivo carrega
 * `expo/config-plugins` inteiro só para registrar o mod — e a única coisa que
 * vale testar aqui é o XML resultante. Sem import de Expo, dá para exercitar
 * em teste unitário com um manifesto escrito à mão.
 *
 * POR QUE ISTO PRECISA EXISTIR:
 * a partir do Android 11 (API 30) o sistema esconde de cada app a lista de
 * apps instalados. Sem declarar `<queries>`, `Linking.canOpenURL('waze://')`
 * devolve FALSE com o Waze instalado — a mesma armadilha que o
 * `LSApplicationQueriesSchemes` resolve no iOS (ver app.config.js).
 *
 * A lista daqui NÃO é a mesma do iOS: quem responde por `comgooglemaps://` é
 * o Google Maps de iPhone, e declarar esse esquema no AndroidManifest não
 * torna app nenhum visível. Ver plugins/externalNavSchemes.js.
 */

const { ANDROID_QUERY_SCHEMES } = require('./externalNavSchemes');

const VIEW_ACTION = 'android.intent.action.VIEW';

/**
 * Acrescenta, ao objeto de manifesto do xml2js, um `<intent>` de VIEW por
 * esquema dentro de `<queries>`. Idempotente: o Expo já escreve um bloco
 * `<queries>` próprio, e um `expo prebuild` repetido não pode duplicar
 * entradas — por isso mescla no bloco existente em vez de substituí-lo.
 *
 * Devolve o MESMO objeto recebido (mutado), como esperam os mods do Expo.
 */
function addExternalNavQueries(androidManifest) {
  const manifest = androidManifest && androidManifest.manifest;
  if (!manifest) return androidManifest;

  if (!Array.isArray(manifest.queries)) manifest.queries = [];
  if (manifest.queries.length === 0) manifest.queries.push({});

  const queries = manifest.queries[0];
  if (!Array.isArray(queries.intent)) queries.intent = [];

  for (const scheme of ANDROID_QUERY_SCHEMES) {
    const already = queries.intent.some(
      (intent) =>
        Array.isArray(intent.data) &&
        intent.data.some((d) => d && d.$ && d.$['android:scheme'] === scheme),
    );
    if (already) continue;

    queries.intent.push({
      action: [{ $: { 'android:name': VIEW_ACTION } }],
      data: [{ $: { 'android:scheme': scheme } }],
    });
  }

  return androidManifest;
}

module.exports = { addExternalNavQueries };
