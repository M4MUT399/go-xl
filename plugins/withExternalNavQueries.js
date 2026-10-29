const { withAndroidManifest } = require('expo/config-plugins');
const { addExternalNavQueries } = require('./externalNavQueries');

/**
 * Config plugin: declara no AndroidManifest, em `<queries>`, os esquemas que o
 * Android usa para navegação externa — `google.navigation` e `waze` — para que
 * `Linking.canOpenURL` consiga enxergar esses apps no Android 11+.
 *
 * ATENÇÃO: os esquemas do Android NÃO são os mesmos do iOS. Lá é
 * `comgooglemaps://`; aqui, `google.navigation:`. A fonte única dos dois
 * conjuntos é `plugins/externalNavSchemes.js` — este arquivo não os lista, só
 * delega a `addExternalNavQueries`.
 *
 * A contraparte iOS é `ios.infoPlist.LSApplicationQueriesSchemes`, declarada
 * direto em app.config.js. Ambas são configuração NATIVA: só valem em build
 * nova — não chegam por OTA update.
 */
module.exports = function withExternalNavQueries(config) {
  return withAndroidManifest(config, (config) => {
    config.modResults = addExternalNavQueries(config.modResults);
    return config;
  });
};
