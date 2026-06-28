import 'react-native-gesture-handler';
import React from 'react';
import { LogBox } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AppNavigator } from './src/navigation/AppNavigator';
import { I18nProvider } from './src/i18n';
import { AuthProvider } from './src/contexts/AuthContext';
import { installNetworkErrorGuard } from './src/lib/networkErrorGuard';

// Engole rejeições de promise de rede transitórias (auto-refresh de sessão /
// realtime do Supabase) para não virarem o toast vermelho do Expo Go.
installNetworkErrorGuard();

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
        <I18nProvider>
          <AuthProvider>
            <StatusBar style="light" />
            <AppNavigator />
          </AuthProvider>
        </I18nProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
