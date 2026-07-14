const { withAndroidManifest, withAppBuildGradle, withDangerousMod, withMainApplication } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

/**
 * Config plugin custom para Android Auto (Car App Library).
 *
 * Por que isto existe: não há uma lib React Native madura equivalente ao
 * `react-native-carplay` para Android Auto — a integração exige código
 * Kotlin nativo real (androidx.car.app) rodando num serviço próprio
 * (`CarAppService`), fora da árvore RN. Este plugin injeta esse código
 * durante o `expo prebuild` (rodado automaticamente pelo EAS Build), mantendo
 * o projeto em Continuous Native Generation — sem comitar `android/` (ver
 * .gitignore) e sem sair do fluxo managed padrão do Expo.
 *
 * Escopo desta primeira versão (skeleton): só declara o serviço e mostra uma
 * tela placeholder ("Aguardando corrida..."). A ponte real com o estado de
 * corrida ativa do motorista (useDriverRide/DriverRideContext) é uma etapa
 * separada — ver plano de "ponte de dados" no backlog do projeto.
 *
 * IMPORTANTE (pendência de segurança/permissão, decisão do usuário):
 * `android.permission.FOREGROUND_SERVICE_LOCATION` está deliberadamente
 * BLOQUEADA em app.json (android.blockedPermissions). Por isso o serviço
 * abaixo NÃO declara `android:foregroundServiceType="location"` ainda — a
 * navegação real dentro do carro (mostrar posição/rota ao vivo) vai exigir
 * decidir e desbloquear essa permissão antes de ir para produção. Não foi
 * removida da lista de bloqueio automaticamente por este plugin.
 */

const PACKAGE_PATH = 'com/goxl/app/carapp';
const SOURCE_DIR = path.join(__dirname, 'android-auto-src');

function withAndroidAutoManifest(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults;
    const app = manifest.manifest.application[0];

    // uses-permission necessária para usar NavigationTemplate (androidx.car.app)
    if (!manifest.manifest['uses-permission']) {
      manifest.manifest['uses-permission'] = [];
    }
    const permissions = manifest.manifest['uses-permission'];
    const navPermName = 'androidx.car.app.NAVIGATION_TEMPLATES';
    if (!permissions.some((p) => p.$['android:name'] === navPermName)) {
      permissions.push({ $: { 'android:name': navPermName } });
    }

    if (!app.service) app.service = [];
    const serviceName = 'com.goxl.app.carapp.GoXlCarAppService';
    const alreadyDeclared = app.service.some((s) => s.$['android:name'] === serviceName);
    if (!alreadyDeclared) {
      app.service.push({
        $: {
          'android:name': serviceName,
          'android:exported': 'true',
        },
        'intent-filter': [
          {
            action: [{ $: { 'android:name': 'androidx.car.app.CarAppService' } }],
            category: [{ $: { 'android:name': 'androidx.car.app.category.NAVIGATION' } }],
          },
        ],
      });
    }

    if (!app['meta-data']) app['meta-data'] = [];
    const metaName = 'com.google.android.gms.car.application';
    if (!app['meta-data'].some((m) => m.$['android:name'] === metaName)) {
      app['meta-data'].push({
        $: {
          'android:name': metaName,
          'android:resource': '@xml/automotive_app_desc',
        },
      });
    }

    return config;
  });
}

function withAndroidAutoSourceFiles(config) {
  return withDangerousMod(config, [
    'android',
    (config) => {
      const projectRoot = config.modRequest.platformProjectRoot;

      const javaDestDir = path.join(projectRoot, 'app/src/main/java', PACKAGE_PATH);
      fs.mkdirSync(javaDestDir, { recursive: true });
      const kotlinSourceDir = path.join(SOURCE_DIR, PACKAGE_PATH);
      for (const file of fs.readdirSync(kotlinSourceDir)) {
        fs.copyFileSync(path.join(kotlinSourceDir, file), path.join(javaDestDir, file));
      }

      const xmlDestDir = path.join(projectRoot, 'app/src/main/res/xml');
      fs.mkdirSync(xmlDestDir, { recursive: true });
      fs.copyFileSync(
        path.join(SOURCE_DIR, 'xml/automotive_app_desc.xml'),
        path.join(xmlDestDir, 'automotive_app_desc.xml')
      );

      return config;
    },
  ]);
}

function withAndroidAutoGradleDependency(config) {
  return withAppBuildGradle(config, (config) => {
    const marker = 'androidx.car.app:app:';
    if (!config.modResults.contents.includes(marker)) {
      config.modResults.contents = config.modResults.contents.replace(
        /dependencies\s*{/,
        `dependencies {\n    implementation("androidx.car.app:app:1.4.0")`
      );
    }
    return config;
  });
}

/**
 * Registra o CarRideBridgePackage (ponte JS -> Android Auto, ver
 * CarRideBridgeModule.kt) em MainApplication — necessário porque é um
 * módulo nativo manual, fora do autolinking padrão do Expo/RN. Suporta
 * tanto o MainApplication.kt (Kotlin, padrão em projetos Expo recentes)
 * quanto .java (fallback), usando o marcador que o próprio template do
 * Expo já deixa no arquivo para "pacotes que não podem ser autolinkados".
 */
function withCarRideBridgePackage(config) {
  return withMainApplication(config, (config) => {
    const marker = 'com.goxl.app.carapp.CarRideBridgePackage()';
    if (config.modResults.contents.includes(marker)) return config;

    const isKotlin = config.modResults.language === 'kt';
    const registration = isKotlin ? `add(${marker})` : `packages.add(new ${marker});`;

    // Kotlin (template atual do Expo): "PackageList(this).packages.apply { ... }"
    //   — dentro do .apply {} o receiver é implícito, então é `add(...)`, não `packages.add(...)`.
    // Java:   "List<ReactPackage> packages = new PackageList(this).getPackages();"
    const anchor = isKotlin
      ? /PackageList\(this\)\.packages\.apply\s*\{/
      : /List<ReactPackage> packages = new PackageList\(this\)\.getPackages\(\);/;

    if (anchor.test(config.modResults.contents)) {
      config.modResults.contents = config.modResults.contents.replace(
        anchor,
        (match) => `${match}\n          ${registration}`
      );
    } else {
      console.warn(
        '[withAndroidAuto] Não encontrei o marcador padrão de getPackages() em MainApplication — ' +
        'CarRideBridgePackage NÃO foi registrado automaticamente. Adicione manualmente: ' +
        registration
      );
    }

    return config;
  });
}

module.exports = function withAndroidAuto(config) {
  config = withAndroidAutoManifest(config);
  config = withAndroidAutoSourceFiles(config);
  config = withAndroidAutoGradleDependency(config);
  config = withCarRideBridgePackage(config);
  return config;
};
