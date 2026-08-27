import 'react-native-gesture-handler';
import React, { useCallback, useState } from 'react';
import { LogBox } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppNavigator } from './src/navigation/AppNavigator';
import { I18nProvider } from './src/i18n';
import { AuthProvider } from './src/contexts/AuthContext';
import { AppErrorBoundary } from './src/components/common/AppErrorBoundary';
import { BrandSplash } from './src/components/BrandSplash';
import { useAuth } from './src/hooks/useAuth';
import { installNetworkErrorGuard } from './src/lib/networkErrorGuard';
import { preloadDriverMarkerAssets } from './src/lib/preloadAssets';
import { registerBackgroundRevocationTask } from './src/lib/backgroundNotifications';
import { setMetricsSink, consoleMetricsSink } from './src/lib/fieldMetrics';

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

// Em dev, as métricas de campo saem no console do `expo start`. Em produção
// não há destino: as amostras ficam só em memória até alguém plugar um sink
// de verdade (ver src/lib/fieldMetrics.ts).
if (__DEV__) setMetricsSink(consoleMetricsSink);

// Reforço em dev: oculta o overlay de log para essas mensagens benignas.
// Nunca aparece em build de produção.
if (__DEV__) {
  LogBox.ignoreLogs([
    'Network request failed',
    'TypeError: Network request failed',
  ]);
}

/**
 * A abertura de marca, entre o splash NATIVO e o app.
 *
 * Precisa viver dentro do AuthProvider porque o sinal de "app pronto" é o
 * `loading` do auth — o mesmo que o AppNavigator usa. E precisa ser o ÚLTIMO
 * filho para pintar por cima do navegador.
 *
 * Quem esconde o splash nativo é o `onVisivel`, não o AppNavigator: a troca
 * acontece quando esta tela já existe em pixels, então o navy nunca sai da
 * tela e não há piscada entre as duas. A chamada do AppNavigator continua lá e
 * vira no-op — esconder duas vezes não quebra nada, e removê-la mexeria num
 * arquivo de 1.800 linhas sem necessidade.
 */
function AberturaDeMarca() {
  const { loading } = useAuth();
  const [naTela, setNaTela] = useState(true);

  const esconderNativa = useCallback(() => {
    SplashScreen.hideAsync().catch(() => {});
  }, []);

  if (!naTela) return null;

  return (
    <BrandSplash
      pronto={!loading}
      onVisivel={esconderNativa}
      onDone={() => setNaTela(false)}
    />
  );
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
              <AberturaDeMarca />
            </AuthProvider>
          </I18nProvider>
        </AppErrorBoundary>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
