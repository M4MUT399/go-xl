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

module.exports = {
  expo: {
    name: 'Go XL',
    slug: 'go-xl',
    version: '1.0.4',
    scheme: 'goxl',
    orientation: 'portrait',
    icon: './assets/icon.png',
    userInterfaceStyle: 'automatic',
    splash: {
      image: './assets/icon.png',
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
          'O Go XL usa sua localização em segundo plano, só durante uma corrida ativa e com sua autorização explícita, para o passageiro continuar vendo sua posição mesmo com o app minimizado.',
        NSCameraUsageDescription:
          'O Go XL usa a câmera para escanear QR Codes e tirar fotos de perfil e do veículo.',
        NSPhotoLibraryUsageDescription:
          'O Go XL acessa suas fotos para você anexar a foto de perfil e as fotos do veículo.',
        UIBackgroundModes: ['remote-notification', 'location'],
        ITSAppUsesNonExemptEncryption: false,
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
      'expo-splash-screen',
      '@react-native-community/datetimepicker',
      'expo-audio',
      'expo-asset',
      'expo-localization',
    ],
    extra: {
      eas: {
        projectId: '96c80736-799c-4980-af78-ca091e87d3d3',
      },
    },
    owner: 'mmt99',
  },
};
