import React, { useEffect, useRef } from 'react';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import {
  Text, View, ActivityIndicator, StyleSheet,
  Animated, TouchableOpacity, SafeAreaView, Image,
} from 'react-native';
import * as ExpoLinking from 'expo-linking';
import * as SplashScreen from 'expo-splash-screen';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabase';

import { RootStackParamList } from '../types';
import { useAuth } from '../hooks/useAuth';
import { useTheme } from '../hooks/useTheme';
import { AppTheme } from '../constants/theme';
import { useNotifications, InAppMessage } from '../hooks/useNotifications';
import { useDriverReminderScheduler } from '../hooks/useDriverReminderScheduler';
import { usePassengerReminderScheduler } from '../hooks/usePassengerReminderScheduler';
import { setNotifyHandler } from '../lib/inAppNotify';
import { useTranslation, type Lang } from '../i18n';

import { WelcomeScreen } from '../screens/auth/WelcomeScreen';
import { LoginScreen } from '../screens/auth/LoginScreen';
import { ForgotPasswordScreen } from '../screens/auth/ForgotPasswordScreen';
import { ResetPasswordScreen } from '../screens/auth/ResetPasswordScreen';
import { RegisterScreen } from '../screens/auth/RegisterScreen';
import { ExpressRegisterScreen } from '../screens/passenger/ExpressRegisterScreen';
import { AddCardOnboardingScreen } from '../screens/passenger/AddCardOnboardingScreen';
import { CompleteRegistrationScreen } from '../screens/passenger/CompleteRegistrationScreen';
import { consumePendingExpressRide } from '../lib/expressRide';
import { HomeScreen } from '../screens/passenger/HomeScreen';
import { RequestRideScreen } from '../screens/passenger/RequestRideScreen';
import { FindingDriverScreen } from '../screens/passenger/FindingDriverScreen';
import { ActiveRideScreen } from '../screens/passenger/ActiveRideScreen';
import { RateRideScreen } from '../screens/passenger/RateRideScreen';
import { TripHistoryScreen } from '../screens/passenger/TripHistoryScreen';
import { ScheduledRidesScreen } from '../screens/passenger/ScheduledRidesScreen';
import { DriverHomeScreen } from '../screens/driver/DriverHomeScreen';
import { DriverNavigateScreen } from '../screens/driver/DriverNavigateScreen';
import { DriverScheduledRidesScreen } from '../screens/driver/DriverScheduledRidesScreen';
import { EarningsScreen } from '../screens/driver/EarningsScreen';
import { DriverReminderSettingsScreen } from '../screens/driver/DriverReminderSettingsScreen';
import { ProfileScreen } from '../screens/ProfileScreen';
// Telas secundárias (não fazem parte do fluxo "quente" de login → corrida):
// carregadas sob demanda via getComponent, para não pesar o bundle inicial.
import { DriverRideProvider } from '../contexts/DriverRideContext';
import { GlobalDriverRideOverlay } from '../components/driver/GlobalDriverRideOverlay';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator();

/** Ref global — permite navegar de fora do NavigationContainer (ex: banner de
 *  notificação, ou o overlay global de chamada de corrida do motorista). */
export const navigationRef = createNavigationContainerRef<RootStackParamList>();

// ─── Banner in-app ────────────────────────────────────────────────────────────
// Aparece sobre qualquer tela, independente de permissão de notificação.
function NotificationBanner({
  message,
  onDismiss,
}: {
  message: InAppMessage;
  onDismiss: () => void;
}) {
  const { colors } = useTheme();
  const bannerStyles = makeBannerStyles(colors);
  const translateY = useRef(new Animated.Value(-120)).current;
  const isChat = !!message.rideId && !!message.chatTitle;

  useEffect(() => {
    Animated.sequence([
      Animated.spring(translateY, {
        toValue: 0,
        useNativeDriver: true,
        speed: 20,
        bounciness: 6,
      }),
      Animated.delay(4000),
      Animated.timing(translateY, {
        toValue: -120,
        duration: 300,
        useNativeDriver: true,
      }),
    ]).start(onDismiss);
  }, []);

  function handlePress() {
    onDismiss();
    if (message.rideId && navigationRef.isReady()) {
      navigationRef.navigate('Chat', {
        rideId: message.rideId,
        title: message.chatTitle ?? 'Chat',
      });
    }
  }

  return (
    <Animated.View style={[bannerStyles.wrapper, { transform: [{ translateY }] }]}>
      <SafeAreaView>
        <TouchableOpacity style={bannerStyles.card} onPress={handlePress} activeOpacity={0.9}>
          <View style={bannerStyles.iconBox}>
            <Text style={bannerStyles.icon}>{isChat ? '💬' : '🗓️'}</Text>
          </View>
          <View style={bannerStyles.textBox}>
            <Text style={bannerStyles.title}>{message.title}</Text>
            <Text style={bannerStyles.body} numberOfLines={2}>{message.body}</Text>
          </View>
          {isChat && (
            <Text style={bannerStyles.chevron}>›</Text>
          )}
        </TouchableOpacity>
      </SafeAreaView>
    </Animated.View>
  );
}

// ─── Tab navigators ───────────────────────────────────────────────────────────
function PassengerTabs() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.primary,
          borderTopColor: 'rgba(255,255,255,0.08)',
          height: 60 + insets.bottom,
          paddingBottom: insets.bottom,
        },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.gray[500],
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600', marginBottom: 4 },
      }}
    >
      <Tab.Screen
        name="Início"
        component={HomeScreen}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>🗺</Text> }}
      />
      <Tab.Screen
        name="Viagens"
        component={TripHistoryScreen}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>📋</Text> }}
      />
      <Tab.Screen
        name="Perfil"
        component={ProfileScreen}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>👤</Text> }}
      />
    </Tab.Navigator>
  );
}

function DriverTabs() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: colors.primary,
          borderTopColor: 'rgba(255,255,255,0.08)',
          height: 60 + insets.bottom,
          paddingBottom: insets.bottom,
        },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.gray[500],
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600', marginBottom: 4 },
      }}
    >
      <Tab.Screen
        name="Mapa"
        component={DriverHomeScreen}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>🗺</Text> }}
      />
      <Tab.Screen
        name="Agenda"
        component={DriverScheduledRidesScreen}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>🗓️</Text> }}
      />
      <Tab.Screen
        name="Ganhos"
        component={EarningsScreen}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>💰</Text> }}
      />
      <Tab.Screen
        name="Alertas"
        component={DriverReminderSettingsScreen}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>🔔</Text> }}
      />
      <Tab.Screen
        name="Perfil"
        component={ProfileScreen}
        options={{ tabBarIcon: ({ color }) => <Text style={{ fontSize: 20, color }}>👤</Text> }}
      />
    </Tab.Navigator>
  );
}

function LoadingScreen() {
  const { colors } = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' }}>
      <Image
        source={require('../../assets/icon.png')}
        style={{ width: 180, height: 180, borderRadius: 32 }}
        resizeMode="contain"
      />
      <ActivityIndicator color={colors.accent} style={{ marginTop: 24 }} />
    </View>
  );
}

// ─── AppNavigator ─────────────────────────────────────────────────────────────
/** Extrai os parâmetros do fragmento "#access_token=...&refresh_token=..."
 *  que o Supabase anexa ao redirectTo após o usuário confirmar o link de
 *  recuperação de senha por e-mail. */
function parseHashParams(url: string): Record<string, string> {
  const hashIndex = url.indexOf('#');
  if (hashIndex === -1) return {};
  const params = new URLSearchParams(url.substring(hashIndex + 1));
  const result: Record<string, string> = {};
  for (const [key, value] of params.entries()) result[key] = value;
  return result;
}

export function AppNavigator() {
  const { session, profile, loading, markRecovery, isRecovery } = useAuth();
  const { setLang } = useTranslation();

  // Aplica o idioma salvo no perfil do usuário assim que ele é carregado
  useEffect(() => {
    const pref = profile?.language as Lang | undefined;
    if (pref) setLang(pref);
  }, [profile?.language, setLang]);

  // Libera a splash nativa (ver App.tsx) assim que o check de sessão termina —
  // evita a piscada splash → tela em branco → LoadingScreen.
  useEffect(() => {
    if (!loading) SplashScreen.hideAsync().catch(() => {});
  }, [loading]);

  const { inAppMessage, clearInAppMessage, showBanner } = useNotifications(
    session?.user.id,
    profile?.type as 'passenger' | 'driver' | undefined
  );

  // Lembretes escalonados (2h/1h/30m/15m) das corridas agendadas do motorista.
  // Dispara mesmo com o app fechado; no-op para passageiro / perfil não carregado.
  useDriverReminderScheduler(profile?.type === 'driver' ? profile.id : undefined);

  // Mesmos lembretes para o PASSAGEIRO (corridas que ele agendou), para que ele
  // esteja pronto no embarque na hora marcada. Dispara mesmo com o app fechado;
  // no-op para motorista / perfil não carregado.
  usePassengerReminderScheduler(profile?.type === 'passenger' ? profile.id : undefined);

  // Conecta notifyInApp (usado por useChatAlert) ao banner do AppNavigator.
  // Garante que mensagens via postgres_changes também apareçam quando o broadcast falhar.
  useEffect(() => {
    setNotifyHandler((title, body, rideId, chatTitle) => {
      showBanner(title, body, rideId ?? '', chatTitle);
    });
    return () => setNotifyHandler(null);
  }, [showBanner]);
  /**
   * Guarda o driverCode bruto assim que o URL chega — síncrono, sem esperar o DB.
   * O lookup no Supabase é feito só depois que a autenticação termina.
   */
  const pendingDriverCode = useRef<string | null>(null);
  /** Token de rastreio público pendente (deep link goxl.app/track?token=…). */
  const pendingTrackToken = useRef<string | null>(null);
  /** Indica se a sessão já está pronta (autenticada) — usado pelo listener de URL. */
  const isAuthedRef = useRef(false);

  /** Navega para o rastreio público assim que o container estiver pronto. */
  function dispatchPendingTrack() {
    const tk = pendingTrackToken.current;
    if (!tk) return;
    if (!navigationRef.isReady()) { setTimeout(dispatchPendingTrack, 200); return; }
    pendingTrackToken.current = null;
    navigationRef.navigate('TrackTrip', { token: tk });
  }

  /** Extrai o driver code do URL e armazena; navega imediatamente se já autenticado. */
  function captureDeepLink(url: string) {
    const parsed = ExpoLinking.parse(url);

    // Link de recuperação de senha: goxl://reset-password#access_token=...
    if (parsed.hostname === 'reset-password' || parsed.path === 'reset-password') {
      const hash = parseHashParams(url);
      if (hash.access_token && hash.refresh_token) {
        supabase.auth
          .setSession({ access_token: hash.access_token, refresh_token: hash.refresh_token })
          .then(() => markRecovery());
      }
      return;
    }

    // Rastreio público de viagem — universal link (https://goxl.app/track?token=)
    // ou custom scheme (goxl://track?token=). Funciona SEM login: o contato de
    // confiança só precisa ter o app instalado.
    const trackToken = parsed.queryParams?.token as string | undefined;
    const isTrack =
      parsed.hostname === 'track' ||
      parsed.path === 'track' ||
      parsed.path === '/track' ||
      (typeof parsed.path === 'string' && parsed.path.replace(/^\//, '') === 'track');
    if (trackToken && isTrack) {
      pendingTrackToken.current = trackToken;
      setTimeout(dispatchPendingTrack, 300);
      return;
    }

    const driverCode = parsed.queryParams?.driver as string | undefined;
    if (!driverCode) return;

    if (isAuthedRef.current) {
      // Usuário já logado → fluxo normal (trava na corrida)
      pendingDriverCode.current = driverCode;
      setTimeout(dispatchPendingDeepLink, 300);
    } else {
      // Usuário NÃO logado → Modo Expresso (cadastro rápido)
      pendingDriverCode.current = null; // não despacha depois do login normal
      setTimeout(() => {
        if (navigationRef.isReady()) {
          navigationRef.navigate('ExpressRegister', { driverCode });
        }
      }, 500);
    }
  }

  /** Faz o lookup no DB e navega para RequestRide com o motorista travado. */
  async function dispatchPendingDeepLink() {
    const code = pendingDriverCode.current;
    if (!code) return;
    pendingDriverCode.current = null;

    const { data } = await supabase
      .from('profiles_public')
      .select('id, full_name')
      .eq('driver_code', code)
      .eq('type', 'driver')
      .maybeSingle();

    if (!data) return;
    const { id, full_name } = data as { id: string; full_name: string };

    // Ler um QR code SEMPRE vincula o passageiro ao motorista dono do QR,
    // porém apenas para ESTA viagem (a trava é um parâmetro da corrida, não
    // um estado permanente). Ao finalizar a corrida, o passageiro volta a ficar
    // livre para pedir pelo app ou ler um novo QR de outro motorista.
    navigationRef.navigate('RequestRide', {
      lockedDriverId: id,
      lockedDriverName: full_name,
    });
  }

  // Mantém a flag de sessão pronta para o listener de URL (warm start).
  useEffect(() => {
    isAuthedRef.current = !loading && !!session;
  }, [loading, session]);

  // Dispara o deep link pendente quando o usuário termina de autenticar (cold start)
  useEffect(() => {
    if (!loading && session) {
      // Prioridade 1: corrida expressa (cadastro via QR de novo passageiro)
      const express = consumePendingExpressRide();
      if (express) {
        setTimeout(() => {
          navigationRef.navigate('RequestRide', {
            lockedDriverId:   express.driverId,
            lockedDriverName: express.driverName,
            // 1ª corrida expressa: cartão já foi adicionado; o cadastro completo
            // (nome/e-mail/telefone) só será cobrado na 2ª viagem/agendamento.
            express: true,
          });
        }, 700);
        return;
      }
      // Prioridade 2: deep link de usuário já cadastrado
      if (pendingDriverCode.current) {
        setTimeout(dispatchPendingDeepLink, 600);
      }
    }
  }, [loading, session]);

  // Cold start do rastreio público: assim que o check de sessão termina (com ou
  // SEM login), despacha o token pendente. O contato de confiança não precisa
  // estar autenticado para acompanhar a viagem.
  useEffect(() => {
    if (!loading && pendingTrackToken.current) {
      setTimeout(dispatchPendingTrack, 400);
    }
  }, [loading]);

  // Escuta deep links (cold start + warm start)
  useEffect(() => {
    ExpoLinking.getInitialURL().then((url: string | null) => { if (url) captureDeepLink(url); });
    const sub = ExpoLinking.addEventListener('url', ({ url }: { url: string }) => captureDeepLink(url));
    return () => sub.remove();
  }, []);

  if (loading) return <LoadingScreen />;

  const isAuthenticated = !!session;
  const isDriver = profile?.type === 'driver';
  // Onboarding do passageiro (decisão de produto):
  //  • Download normal → cadastro (nome/e-mail/telefone) primeiro; o passageiro
  //    entra direto no app e o cartão é exigido só ao chamar a corrida.
  //  • Via QR (Expresso) → cartão primeiro; cadastro completo cobrado depois.
  // Por isso NÃO há mais "muro do cartão" aqui: o passageiro sempre entra em
  // PassengerTabs, e o gate de cartão/cadastro vive no fluxo de pedir corrida.

  const navigatorContent = (
    <>
      <NavigationContainer ref={navigationRef}>
        <Stack.Navigator screenOptions={{ headerShown: false, animation: 'slide_from_right' }} >
          {isRecovery ? (
            /* Chegou via link de "esqueci a senha": trava aqui até redefinir,
             * independente de já ter sessão autenticada ou não. */
            <Stack.Screen name="ResetPassword" component={ResetPasswordScreen} />
          ) : !isAuthenticated ? (
            <>
              <Stack.Screen name="Welcome"          component={WelcomeScreen} />
              <Stack.Screen name="Login"            component={LoginScreen} />
              <Stack.Screen name="ForgotPassword"   component={ForgotPasswordScreen} />
              <Stack.Screen name="Register"         component={RegisterScreen} />
              {/* Cadastro Expresso — ativado automaticamente via QR de novo passageiro */}
              <Stack.Screen name="ExpressRegister"  component={ExpressRegisterScreen} />
              {/* Rastreio público — contato de confiança abre o link SEM login */}
              <Stack.Screen name="TrackTrip" getComponent={() => require('../screens/TrackTripScreen').TrackTripScreen} />
            </>
          ) : isDriver ? (
            <>
              <Stack.Screen name="DriverTabs" component={DriverTabs} />
              <Stack.Screen name="DriverNavigate" component={DriverNavigateScreen} />
              <Stack.Screen name="DriverScheduledRides" component={DriverScheduledRidesScreen} />
              <Stack.Screen name="VehicleForm" getComponent={() => require('../screens/driver/VehicleFormScreen').VehicleFormScreen} />
              <Stack.Screen name="DriverVerification" getComponent={() => require('../screens/driver/DriverVerificationScreen').DriverVerificationScreen} />
              <Stack.Screen name="QRCode" getComponent={() => require('../screens/driver/QRCodeScreen').QRCodeScreen} />
              <Stack.Screen name="Chat" getComponent={() => require('../screens/ChatScreen').ChatScreen} />
              <Stack.Screen name="EditProfile" getComponent={() => require('../screens/profile/EditProfileScreen').EditProfileScreen} />
              <Stack.Screen name="NotificationSettings" getComponent={() => require('../screens/profile/NotificationSettingsScreen').NotificationSettingsScreen} />
              <Stack.Screen name="Support" getComponent={() => require('../screens/profile/SupportScreen').SupportScreen} />
              <Stack.Screen name="Terms" getComponent={() => require('../screens/profile/TermsScreen').TermsScreen} />
              <Stack.Screen name="Payment" getComponent={() => require('../screens/profile/PaymentScreen').PaymentScreen} />
              <Stack.Screen name="TrackTrip" getComponent={() => require('../screens/TrackTripScreen').TrackTripScreen} />
            </>
          ) : (
            <>
              <Stack.Screen name="PassengerTabs" component={PassengerTabs} />
              <Stack.Screen name="RequestRide" component={RequestRideScreen} />
              {/* Gates de onboarding, agora como passos DENTRO do app (não muro):
               *  cartão exigido ao chamar corrida; cadastro completo ao agendar
               *  ou pedir a 2ª viagem de uma conta expressa. */}
              <Stack.Screen name="AddCardOnboarding" component={AddCardOnboardingScreen} />
              <Stack.Screen name="CompleteRegistration" component={CompleteRegistrationScreen} />
              <Stack.Screen name="FindingDriver" component={FindingDriverScreen} />
              <Stack.Screen name="ActiveRide" component={ActiveRideScreen} />
              <Stack.Screen name="RateRide" component={RateRideScreen} />
              <Stack.Screen name="ScheduledRides" component={ScheduledRidesScreen} />
              <Stack.Screen name="TripDetails" getComponent={() => require('../screens/passenger/TripDetailsScreen').TripDetailsScreen} />
              <Stack.Screen name="Chat" getComponent={() => require('../screens/ChatScreen').ChatScreen} />
              <Stack.Screen name="EditProfile" getComponent={() => require('../screens/profile/EditProfileScreen').EditProfileScreen} />
              <Stack.Screen name="NotificationSettings" getComponent={() => require('../screens/profile/NotificationSettingsScreen').NotificationSettingsScreen} />
              <Stack.Screen name="TrustedContacts" getComponent={() => require('../screens/profile/TrustedContactsScreen').TrustedContactsScreen} />
              <Stack.Screen name="Support" getComponent={() => require('../screens/profile/SupportScreen').SupportScreen} />
              <Stack.Screen name="Terms" getComponent={() => require('../screens/profile/TermsScreen').TermsScreen} />
              <Stack.Screen name="Payment" getComponent={() => require('../screens/profile/PaymentScreen').PaymentScreen} />
              <Stack.Screen name="TrackTrip" getComponent={() => require('../screens/TrackTripScreen').TrackTripScreen} />
            </>
          )}
        </Stack.Navigator>
      </NavigationContainer>

      {/* Banner in-app — aparece sobre qualquer tela, sem precisar de permissão */}
      {inAppMessage && (
        <NotificationBanner message={inAppMessage} onDismiss={clearInAppMessage} />
      )}
    </>
  );

  return (
    <View style={{ flex: 1 }}>
      {isDriver ? (
        // Provider único para o motorista: guarda a assinatura realtime de novas
        // corridas + status online + localização, e sobrevive à navegação entre
        // TODAS as telas do driver stack. O `GlobalDriverRideOverlay` (que
        // renderiza o Modal de chamada de corrida) fica FORA da Stack.Navigator,
        // como irmão dela, para nunca ser "congelado" por react-native-screens.
        <DriverRideProvider>
          {navigatorContent}
          <GlobalDriverRideOverlay />
        </DriverRideProvider>
      ) : (
        navigatorContent
      )}
    </View>
  );
}

// ─── Style factories ──────────────────────────────────────────────────────────
function makeBannerStyles(colors: AppTheme) {
  return StyleSheet.create({
    wrapper: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 9999,
      elevation: 20,
      paddingHorizontal: 12,
    },
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.primary,
      borderRadius: 16,
      padding: 14,
      marginTop: 8,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.3,
      shadowRadius: 12,
      borderLeftWidth: 4,
      borderLeftColor: colors.accent,
    },
    iconBox: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: 'rgba(201,168,76,0.15)',
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 12,
    },
    icon: { fontSize: 22 },
    textBox: { flex: 1 },
    title: { fontSize: 15, fontWeight: '800', color: colors.white, marginBottom: 2 },
    body: { fontSize: 13, color: colors.gray[300], lineHeight: 17 },
    chevron: { color: colors.accent, fontSize: 26, fontWeight: '300', marginLeft: 8 },
  });
}
