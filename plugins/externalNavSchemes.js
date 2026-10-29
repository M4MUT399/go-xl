/**
 * Os esquemas de URL da navegação externa que precisam ser DECLARADOS na
 * configuração nativa — fonte única para as duas metades.
 *
 * Por que um arquivo só para duas listas: as duas metades vivem em mundos
 * diferentes (o Info.plist sai de app.config.js, o AndroidManifest sai de um
 * config plugin) e, até aqui, cada uma carregava sua própria cópia literal.
 * Duas cópias que precisam concordar mas nada obriga a concordar são o começo
 * de uma divergência silenciosa: config nativa só falha em BUILD, nunca em
 * teste nem em OTA update.
 *
 * As listas NÃO são iguais, e é esse o ponto: `comgooglemaps://` é o esquema
 * do Google Maps de iOS, e o app Android não o registra — lá o alvo que inicia
 * o turn-by-turn é `google.navigation:`. Declarar um no lugar do outro produz
 * uma entrada que não torna app nenhum visível.
 *
 * CommonJS de propósito: app.config.js e os config plugins do Expo rodam fora
 * do bundle TypeScript do app.
 */

/** iOS: `ios.infoPlist.LSApplicationQueriesSchemes` (ver app.config.js). */
const IOS_QUERY_SCHEMES = ['comgooglemaps', 'waze'];

/** Android: um `<intent>` de VIEW por esquema em `<queries>`. */
const ANDROID_QUERY_SCHEMES = ['google.navigation', 'waze'];

module.exports = { IOS_QUERY_SCHEMES, ANDROID_QUERY_SCHEMES };
