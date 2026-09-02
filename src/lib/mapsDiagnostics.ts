// mapsDiagnostics — por que a área do mapa aparece BRANCA no Android.
//
// ─── O SINTOMA ───────────────────────────────────────────────────────────────
// O Maps SDK for Android desenha a marca d'água "Google" e o resto do quadro
// fica branco. É o desenho de um mapa que carregou o SDK e NÃO conseguiu buscar
// tile nenhum. O mesmo build no aparelho do lado pode funcionar — o que muda é
// a chave que chegou naquele APK/AAB e a assinatura com que ele foi assinado.
//
// ─── OS CAMINHOS QUE PRODUZEM ESSA TELA ──────────────────────────────────────
// Este módulo cobre UM deles, o único que o app consegue enxergar de dentro:
//
//   (1) A CHAVE NÃO ENTROU NO BUILD.
//       app.config.js:159-161 lê `process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY`.
//       Ela NÃO está em eas.json (nenhum profile a declara em `env`) — vem das
//       variáveis de ambiente do EAS por `environment`. Um build feito sem ela
//       (local sem .env, profile errado, variável não promovida ao environment)
//       compila normalmente e sobe: o campo simplesmente fica `undefined` e o
//       plugin escreve um `com.google.android.geo.API_KEY` vazio. O próprio
//       comentário do app.config.js:19-21 admite o desfecho — "o app roda
//       normal, só o mapa nativo não renderiza tiles". Silencioso por design.
//       → É ISTO que `diagnoseMapsKey` detecta, lendo a config EMBUTIDA no
//         build instalado (expo-constants), não a do repositório.
//
// Os demais NÃO são detectáveis daqui, e é honesto dizer isso em vez de fingir:
//
//   (2) RESTRIÇÃO DA CHAVE NÃO BATE COM A ASSINATURA. A chave é restrita a
//       "Apps Android" por pacote + SHA-1 (app.config.js:13-14). Um build
//       assinado com outro keystore — debug local, APK de `development`/
//       `preview` versus o AAB assinado pelo Play App Signing — apresenta outro
//       SHA-1 e a Google recusa. A chave ESTÁ no build; o app não tem como
//       saber que foi recusada. Assinatura do sintoma: no logcat, uma linha do
//       Maps SDK dizendo "Authorization failure" com o par pacote/SHA-1 exato
//       que precisa ser cadastrado.
//   (3) API "Maps SDK for Android" desabilitada no projeto do Google Cloud, ou
//       faturamento suspenso. Mesmo desenho de tela.
//   (4) Play Services ausente/desatualizado no aparelho (emulador sem GMS,
//       aparelho sem serviços Google).
//   (5) Altura zero / layout: o MapView existe mas com 0 px — aqui não é o
//       caso, `styles.map` usa `...StyleSheet.absoluteFillObject` nas telas.
//   (6) `customMapStyle` inválido. Também não é o caso no Android: as telas
//       passam `[]` de propósito (ver DriverHomeScreen.tsx:388).
//
// Nada disto foi reproduzido: não há acesso aos aparelhos do dono nem ao
// console do Google Cloud dele. O que este módulo faz é converter o caminho (1)
// de invisível em visível, e o resto vira pedido de evidência — ver o relatório.

/** Resultado do que dá para apurar de DENTRO do app. */
export type MapsKeyDiagnosis =
  /** Plataforma sem chave nativa do Google Maps embutida (iOS/web). */
  | 'not_applicable'
  /** A chave chegou ao build. Não diz que ela FUNCIONA — ver (2) e (3) acima. */
  | 'present'
  /** A chave não chegou ao build: mapa branco garantido no Android. */
  | 'missing';

/**
 * @param platform    `Platform.OS`.
 * @param androidKey  `Constants.expoConfig?.android?.config?.googleMaps?.apiKey`
 *                    — a config EMBUTIDA no build instalado.
 */
export function diagnoseMapsKey(platform: string, androidKey: unknown): MapsKeyDiagnosis {
  if (platform !== 'android') return 'not_applicable';
  // String vazia e espaços em branco contam como ausente: uma env definida como
  // "" produz exatamente o mesmo mapa branco que uma env não definida.
  if (typeof androidKey !== 'string' || androidKey.trim() === '') return 'missing';
  return 'present';
}
