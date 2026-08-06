import 'react-native-gesture-handler';
import React from 'react';
import { LogBox } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppNavigator } from './src/navigation/AppNavigator';
import { I18nProvider } from './src/i18n';
import { AuthProvider } from './src/contexts/AuthContext';
import { AppErrorBoundary } from './src/components/common/AppErrorBoundary';
import { installNetworkErrorGuard } from './src/lib/networkErrorGuard';
import { preloadDriverMarkerAssets } from './src/lib/preloadAssets';
import { registerBackgroundRevocationTask } from './src/lib/backgroundNotifications';

// Mantém a splash nativa visível até o AuthContext terminar o check de sessão
// (AppNavigator chama SplashScreen.hideAsync() quando `loading` vira false).
// Sem isso, a splash some assim que o JS monta — antes da autenticação
// resolver — e o usuário vê uma piscada (splash → tela em branco → loading).
SplashScreen.preventAutoHideAsync().catch(() => {});

// Engole rejeições de promise de rede transitórias (auto-refresh de sessão /
// realtime do Supabase) para não virarem o toast vermelho do Expo Go.
installNetworkErrorGuard();

// Decodifica a logo do marcador de motorista o quanto antes (ver
// preloadAssets.ts) — evita o marcador "congelar" no ícone padrão do mapa
// antes da imagem customizada estar pronta.
preloadDriverMarkerAssets();

// Registra a task de notificação em background (Camada 2 — revogação em
// background/lockscreen). Idempotente e best-effort: no-op no Expo Go/web,
// só ativa em build nativo. A task em si foi definida no import de index.ts.
registerBackgroundRevocationTask();

// Reforço em dev: oculta o overlay de log para essas mensagens benignas.
// Nunca aparece em build de produção.
if (__DEV__) {
  LogBox.ignoreLogs([
    'Network request failed',
    'TypeError: Network request failed',
  ]);
}

export default function App() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AppErrorBoundary>
          <I18nProvider>
            <AuthProvider>
              <StatusBar style="light" />
              <AppNavigator />
            </AuthProvider>
          </I18nProvider>
        </AppErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
