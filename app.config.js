// Substitui o antigo app.json estático (item #81).
//
// Por quê: o app.json estático não consegue ler process.env — por isso as
// duas chaves nativas do Google Maps (Android e iOS) estavam hardcoded como
// literais no arquivo, e ERAM A MESMA chave usada também pelas chamadas REST
// de Places/Geocoding em src/lib/geocoding.ts. Como o Google Cloud só aceita
// UM tipo de restrição de aplicativo por chave, uma chave compartilhada entre
// Maps Android + Maps iOS + REST nunca poderia ter restrição nenhuma —
// ficava aberta e extraível de qualquer AAB/IPA publicado.
//
// Agora cada uso tem sua própria chave, injetada via env (EAS "env" por
// profile em eas.json, mesmo padrão já usado para o Supabase):
//   • EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY → restrita a "Apps Android"
//     (pacote com.goxl.app + SHA-1 de assinatura) e à API "Maps SDK for Android"
//   • EXPO_PUBLIC_GOOGLE_MAPS_IOS_KEY     → restrita a "Apps iOS"
//     (bundle ID com.goxl.app) e à API "Maps SDK for iOS"
// A chave de Places/Geocoding NÃO existe mais no cliente — foi movida para a
// Edge Function `places-search` (ver supabase/functions/places-search/index.ts).
//
// Se a env não estiver setada (ex.: dev local sem o .env.local preenchido), o
// campo fica undefined e o Expo simplesmente não builda a chave — o app roda
// normal, só o mapa nativo não renderiza tiles do Google.

const { IOS_QUERY_SCHEMES } = require('./plugins/externalNavSchemes');

module.exports = {
  expo: {
    name: 'Go XL',
    slug: 'go-xl',
    version: '1.0.18',
    scheme: 'goxl',
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'automatic',
    // O splash NATIVO é navy puro, sem imagem, de propósito.
    //
    // Ele cobre só o carregamento do bundle JS. Quem apresenta a marca é a
    // abertura animada (src/components/BrandSplash.tsx), que monta em seguida
    // e começa justamente com meio segundo de navy.
    //
    // Antes havia `image: './assets/icon.png'` aqui, e isso produzia um salto:
    // um GX grande em `contain` desaparecia para o GX pequeno da animação
    // reaparecer logo depois. Com navy puro nos dois lados, o fundo nunca sai
    // da tela e a troca é invisível.
    //
    // Para voltar ao GX estático na tela nativa, troque a imagem transparente
    // por './assets/icon.png' — mas então vale ajustar a entrada da animação,
    // senão a marca aparece duas vezes em tamanhos diferentes.
    //
    // ── POR QUE UMA IMAGEM TRANSPARENTE E NÃO NENHUMA ──────────────────────
    //
    // Deixar `image` de fora QUEBRA A BUILD ANDROID. O plugin escreve, em
    // styles.xml, `windowSplashScreenAnimatedIcon = @drawable/splashscreen_logo`
    // sempre — mas só gera esse drawable quando há imagem. Sem ela o Gradle
    // falha em recurso inexistente, e o erro que chega da EAS é só
    // "Gradle build failed with unknown error". Foi o que derrubou a build
    // 1.0.7 (c16e6112) em 27/08/2026.
    //
    // O PNG é 288×288 e 100% transparente: dá ao plugin o que ele precisa
    // gerar, e o que o usuário vê continua sendo só o `backgroundColor`.
    splash: {
      image: './assets/splash-transparente.png',
      resizeMode: 'contain',
      backgroundColor: '#1A1A2E',
    },
    ios: {
      supportsTablet: false,
      bundleIdentifier: 'com.goxl.app',
      buildNumber: '1',
      associatedDomains: ['applinks:goxl.app'],
      infoPlist: {
        NSLocationWhenInUseUsageDescription:
          'O Go XL usa sua localização para encontrar motoristas próximos e definir o ponto de partida da corrida.',
        NSLocationAlwaysAndWhenInUseUsageDescription:
          'O Go XL usa sua localização em segundo plano, com sua autorização explícita, enquanto você está online como motorista — para receber chamadas próximas — e durante uma corrida ativa, para o passageiro continuar vendo sua posição mesmo com o app minimizado. Fica offline e o rastreamento para.',
        NSCameraUsageDescription:
          'O Go XL usa a câmera para escanear QR Codes e tirar fotos de perfil e do veículo.',
        NSPhotoLibraryUsageDescription:
          'O Go XL acessa suas fotos para você anexar a foto de perfil e as fotos do veículo.',
        UIBackgroundModes: ['remote-notification', 'location'],
        ITSAppUsesNonExemptEncryption: false,
        // Sem esta lista, `Linking.canOpenURL('comgooglemaps://')` e
        // `canOpenURL('waze://')` devolvem FALSE no iOS MESMO COM O APP
        // INSTALADO — desde o iOS 9 o sistema só responde sobre esquemas que
        // o app declarou de antemão aqui. É o que permite a barra "Google
        // Maps / Waze" da tela de navegação do motorista
        // (src/components/driver/ExternalNavBar.tsx) abrir o app de verdade
        // em vez de sempre cair no https.
        //
        // Só vale em BUILD NOVA: é Info.plist, não chega por OTA update. O
        // Android tem armadilha equivalente com OUTRA lista de esquemas — ver
        // plugins/externalNavSchemes.js, que é quem guarda as duas.
        LSApplicationQueriesSchemes: IOS_QUERY_SCHEMES,
      },
      config: {
        googleMapsApiKey: process.env.EXPO_PUBLIC_GOOGLE_MAPS_IOS_KEY,
      },
      privacyManifests: {
        NSPrivacyAccessedAPITypes: [
          {
            NSPrivacyAccessedAPIType: 'NSPrivacyAccessedAPICategoryUserDefaults',
            NSPrivacyAccessedAPITypeReasons: ['CA92.1'],
          },
        ],
      },
    },
    android: {
      package: 'com.goxl.app',
      versionCode: 1,
      intentFilters: [
        {
          action: 'VIEW',
          autoVerify: true,
          data: [
            {
              scheme: 'https',
              host: 'goxl.app',
              pathPrefix: '/track',
            },
          ],
          category: ['BROWSABLE', 'DEFAULT'],
        },
        {
          action: 'VIEW',
          autoVerify: true,
          data: [
            {
              scheme: 'https',
              host: 'goxl.app',
              pathPrefix: '/qr',
            },
          ],
          category: ['BROWSABLE', 'DEFAULT'],
        },
      ],
      permissions: [
        'ACCESS_FINE_LOCATION',
        'ACCESS_COARSE_LOCATION',
        'CAMERA',
        'VIBRATE',
        'RECEIVE_BOOT_COMPLETED',
        'POST_NOTIFICATIONS',
        'android.permission.ACCESS_COARSE_LOCATION',
        'android.permission.ACCESS_FINE_LOCATION',
        'android.permission.FOREGROUND_SERVICE_LOCATION',
      ],
      blockedPermissions: [
        'android.permission.ACCESS_BACKGROUND_LOCATION',
        'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK',
        'android.permission.RECORD_AUDIO',
      ],
      adaptiveIcon: {
        backgroundColor: '#1A1A2E',
        foregroundImage: './assets/android-icon-foreground.png',
        backgroundImage: './assets/android-icon-background.png',
        monochromeImage: './assets/android-icon-monochrome.png',
      },
      config: {
        googleMaps: {
          apiKey: process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY,
        },
      },
      predictiveBackGestureEnabled: false,
    },
    web: {
      favicon: './assets/favicon.png',
    },
    // ── ATUALIZAÇÃO POR OTA (EAS Update) ──────────────────────────────────
    //
    // POR QUE ISTO EXISTE. Em 03/09/2026 o Cadastro Expresso por QR estava
    // quebrado em todo iPhone: a App Store servia a 1.0.5, que consultava
    // `profiles_public.driver_code`, coluna que a migration 0069 removeu. O
    // conserto era UMA LINHA de JavaScript. Ele já estava pronto no HEAD havia
    // uma semana e não tinha como chegar ao usuário: sem OTA, correção de JS
    // depende de revisão da Apple. Cinco minutos de trabalho viraram dias de
    // app quebrado.
    //
    // ⚠️ ISTO NÃO CONSERTA NADA DO QUE JÁ ESTÁ INSTALADO. Só binários que
    // EMBARCAM o expo-updates recebem update — ou seja, da próxima build em
    // diante. TODAS as builds anteriores estão condenadas a nunca receber OTA:
    // 1.0.5, 1.0.6, 1.0.7, 1.0.8, 1.0.9, 1.0.10 e 1.0.11, sem exceção.
    //
    // ── ONDE MORA O RISCO ─────────────────────────────────────────────────
    //
    // O que decide se um update chega é o `runtimeVersion`, e a política
    // `fingerprint` o calcula por hash do projeto. As regras de o que entra
    // nesse hash estão em `fingerprint.config.js`, com as medições — leia esse
    // arquivo ANTES de publicar o primeiro update. O modo de falha aqui não
    // levanta erro: um runtimeVersion que build nenhuma tem simplesmente não
    // alcança ninguém, calado.
    //
    // Publique sempre por `npm run update:producao` (que força
    // `--environment production`, para a EAS injetar as mesmas variáveis da
    // build) e confira com `npm run update:confere`.
    updates: {
      url: 'https://u.expo.dev/96c80736-799c-4980-af78-ca091e87d3d3',
      enabled: true,
      // NUNCA segurar a inicialização: o app sobe na hora com o bundle que já
      // tem, baixa o novo em segundo plano e aplica na abertura seguinte.
      //
      // Os dois valores abaixo são os DEFAULTS da biblioteca — estão escritos
      // por serem requisito, não por mudarem algo hoje. A abertura de marca
      // (src/lib/splashTimeline.ts) tem piso de 3,45 s medido contra o tempo de
      // carregar o bundle; um `fallbackToCacheTimeout` maior que zero entraria
      // por baixo desse orçamento e o motorista veria a marca parada esperando
      // rede — pior no estacionamento do MCO, sinal ruim, que é onde ele mais
      // abre o app. Um teste tranca esse zero: ver
      // plugins/__tests__/otaNaoBloqueiaAberturaDeMarca.test.ts.
      checkAutomatically: 'ON_LOAD',
      fallbackToCacheTimeout: 0,
      // ⚠️ CONSEQUÊNCIA OPERACIONAL de ON_LOAD: a verificação só acontece no
      // COLD START, e o update baixado só entra no cold start SEGUINTE. Nada
      // no app chama a API de `expo-updates` hoje. Motorista que deixa o app
      // residente o turno inteiro pode passar horas sem receber o conserto.
      // Trocar isso exige decidir o que fazer com uma corrida EM ANDAMENTO —
      // recarregar o bundle no meio de uma navegação seria pior que o atraso.
    },
    runtimeVersion: {
      policy: 'fingerprint',
    },
    plugins: [
      [
        'expo-notifications',
        {
          icon: './assets/icon.png',
          color: '#C9A84C',
          sounds: ['./assets/notification.wav'],
        },
      ],
      [
        'expo-location',
        {
          locationWhenInUsePermission: 'O Go XL usa sua localização para encontrar motoristas próximos.',
          isAndroidBackgroundLocationEnabled: false,
          isAndroidForegroundServiceEnabled: true,
        },
      ],
      [
        'expo-build-properties',
        {
          ios: {
            deploymentTarget: '15.1',
          },
          android: {
            minSdkVersion: 24,
            targetSdkVersion: 36,
            compileSdkVersion: 36,
          },
        },
      ],
      'expo-web-browser',
      // Os docs da SDK 54 dizem que o plugin é preferido à chave `splash` de
      // cima, que segue suportada como legado. Configurado aqui para que a cor
      // valha mesmo se a chave legada for removida um dia.
      ['expo-splash-screen', {
        image: './assets/splash-transparente.png',
        backgroundColor: '#1A1A2E',
        resizeMode: 'contain',
      }],
      '@react-native-community/datetimepicker',
      'expo-audio',
      'expo-asset',
      'expo-localization',
      // Contraparte Android do LSApplicationQueriesSchemes acima: no Android 11+
      // o sistema esconde os apps instalados, e sem <queries> o canOpenURL de
      // `google.navigation:` e `waze://` mente dizendo que não dá para abrir.
      // Os esquemas são os do Android, não os do iOS — `comgooglemaps://` só
      // existe no iPhone.
      './plugins/withExternalNavQueries',
    ],
    extra: {
      eas: {
        projectId: '96c80736-799c-4980-af78-ca091e87d3d3',
      },
    },
    owner: 'mmt99',
  },
};
