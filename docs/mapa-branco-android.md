# Mapa branco no Android — mapa de investigação

Este documento é o que sobrou, e o que vale, do módulo `src/lib/mapsDiagnostics.ts`
(removido). O módulo tinha duas partes: a ENUMERAÇÃO dos caminhos que produzem a
tela branca — preservada aqui — e um DETECTOR que emitia um aviso falso em cima
do mapa de todo motorista Android. O detector foi removido; a prova de por que
ele era falso está no fim deste arquivo e está travada em teste
(`plugins/__tests__/configEmbutidaMapsAndroid.test.ts`).

## O sintoma

O Maps SDK for Android desenha a marca d'água "Google" e o resto do quadro fica
branco. É o desenho de um mapa que carregou o SDK e NÃO conseguiu buscar tile
nenhum. O mesmo build no aparelho do lado pode funcionar — o que muda é a chave
que chegou naquele APK/AAB e a assinatura com que ele foi assinado.

## Os caminhos que produzem essa tela

Nenhum deles é observável de dentro do app (ver "A prova" abaixo). Todos exigem
logcat do aparelho ou o console do Google Cloud.

1. **A CHAVE NÃO ENTROU NO BUILD.**
   `app.config.js:158-162` lê `process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY`.
   Ela NÃO está em `eas.json` (nenhum profile a declara em `env`) — vem das
   variáveis de ambiente do EAS pelo `environment` do profile. Um build feito sem
   ela (local sem `.env`, profile errado, variável não promovida ao environment)
   compila normalmente e sobe. O próprio comentário do `app.config.js:20-22`
   admite o desfecho — "o app roda normal, só o mapa nativo não renderiza tiles".
   Silencioso por design.
   Quando o campo está vazio, o plugin do Expo **remove** o
   `<meta-data android:name="com.google.android.geo.API_KEY">` do
   AndroidManifest em vez de escrevê-lo vazio — ver
   `node_modules/@expo/config-plugins/build/android/GoogleMapsApiKey.js:39-43`.
   (O comentário antigo do módulo dizia "escreve um API_KEY vazio"; estava
   errado.) Assinatura no logcat: o Maps SDK reclamando de API key ausente.

2. **RESTRIÇÃO DA CHAVE NÃO BATE COM A ASSINATURA.**
   A chave é restrita a "Apps Android" por pacote + SHA-1 (`app.config.js:13-14`).
   Um build assinado com outro keystore — debug local, APK de `development`/
   `preview` versus o AAB assinado pelo Play App Signing — apresenta outro SHA-1
   e a Google recusa. A chave ESTÁ no build; o app não tem como saber que foi
   recusada. Assinatura do sintoma: no logcat, uma linha do Maps SDK dizendo
   "Authorization failure" com o par pacote/SHA-1 exato que precisa ser
   cadastrado.

3. **API "Maps SDK for Android" desabilitada** no projeto do Google Cloud, ou
   faturamento suspenso. Mesmo desenho de tela.

4. **Play Services ausente/desatualizado** no aparelho (emulador sem GMS,
   aparelho sem serviços Google).

5. **Altura zero / layout:** o `MapView` existe mas com 0 px. Não é o caso hoje:
   `styles.map` usa `...StyleSheet.absoluteFillObject` nas telas.

6. **`customMapStyle` inválido.** Também não é o caso no Android: as telas
   passam `[]` de propósito (ver `DriverHomeScreen.tsx`, prop `customMapStyle`).

## A prova: por que o caminho (1) também NÃO é detectável de dentro do app

O detector removido decidia por
`Constants.expoConfig?.android?.config?.googleMaps?.apiKey`. Esse campo é
**sempre `undefined` num app instalado**, com ou sem chave. Logo o detector
classificava 100% dos aparelhos Android como "chave ausente" — inclusive os que
estavam com o mapa desenhando ruas normalmente. Cadeia:

- `Constants.expoConfig` no Android sai do asset `app.config` empacotado no APK
  — `node_modules/expo-constants/android/src/main/java/expo/modules/constants/ConstantsService.kt:18,45,73-84`.
  (Os outros dois caminhos do getter, `ExpoUpdates` e `EXDevLauncher`, não valem
  para o build de produção: **`expo-updates` não é dependência deste projeto**;
  ver `node_modules/expo-constants/build/Constants.js:9-46,101-118`.)
- Esse asset é gerado no `preBuild` do Gradle por
  `node_modules/expo-constants/scripts/get-app-config-android.gradle:41`, que
  chama `node_modules/expo-constants/scripts/getAppConfig.js`.
- Esse script chama `getConfig(projectRoot, { isPublicConfig: true })`.
- E `isPublicConfig` **apaga o bloco inteiro**:
  `node_modules/@expo/config/build/Config.js:251-256`
  — `delete configWithDefaultValues.exp.ios.config` e
  `delete configWithDefaultValues.exp.android.config`.
  É deliberado: é ali que moram as chaves privadas, e esse JSON é feito para ser
  publicado.

Ou seja: o app NUNCA enxerga a chave nativa. A chave chega ao aparelho pelo
AndroidManifest (via plugin, em tempo de prebuild), que o JS não lê.

Rodar o script real com uma chave falsa no ambiente confirma: o `app.config`
gerado sai sem `android.config` e sem nenhum rastro da chave. É exatamente isso
que `plugins/__tests__/configEmbutidaMapsAndroid.test.ts` executa e verifica, para
que ninguém reintroduza o mesmo palpite.

## Como investigar de verdade quando voltar

O sinal está fora do app, não dentro:

- `adb logcat | grep -i "Google Maps Android API\|Authorization failure"` no
  aparelho que reproduz — separa (1)/(2)/(3) em um comando.
- Console do Google Cloud: API habilitada, faturamento ativo, e o par
  `com.goxl.app` + SHA-1 da assinatura efetiva (o do Play App Signing, não o do
  keystore de upload) cadastrado na chave.
- `npx eas env:list --environment production` para confirmar que
  `EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY` existe no environment que o profile usa.

Nada disto foi reproduzido em campo por quem escreveu este documento: não há
acesso aos aparelhos do dono nem ao console do Google Cloud dele.
