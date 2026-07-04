import React, { useEffect, useRef } from 'react';
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import {
  Text, View, ActivityIndicator, StyleSheet,
  Animated, TouchableOpacity, SafeAreaView, Image,
} from 'react-native';
import * as ExpoLinking from 'expo-linking';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { supabase } from '../lib/supabase';

import { RootStackParamList } from '../types';
import { useAuth } from '../hooks/useAuth';
import { useTheme } from '../hooks/useTheme';
import { AppTheme } from '../constants/theme';
import { useNotifications, InAppMessage } from '../hooks/useNotifications';
import { useDriverReminderScheduler } from '../hooks/useDriverReminderScheduler';
import { setNotifyHandler } from '../lib/inAppNotify';
import { useTranslation, type Lang } from '../i18n';

import { WelcomeScreen } from '../screens/auth/WelcomeScreen';
import { LoginScreen } from '../screens/auth/LoginScreen';
import { ForgotPasswordScreen } from '../screens/auth/ForgotPasswordScreen';
import { ResetPasswordScreen } from '../screens/auth/ResetPasswordScreen';
import { RegisterScreen } from '../screens/auth/RegisterScreen';
import { ExpressRegisterScreen } from '../screens/passenger/ExpressRegisterScreen';
import { AddCardOnboardingScreen } from '../screens/passenger/AddCardOnboardingScreen';
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
import { VehicleFormScreen } from '../screens/driver/VehicleFormScreen';
import { DriverVerificationScreen } from '../screens/driver/DriverVerificationScreen';
import { ProfileScreen } from '../screens/ProfileScreen';
import { EditProfileScreen } from '../screens/profile/EditProfileScreen';
import { NotificationSettingsScreen } from '../screens/profile/NotificationSettingsScreen';
import { SupportScreen } from '../screens/profile/SupportScreen';
import { TermsScreen } from '../screens/profile/TermsScreen';
import { PaymentScreen } from '../screens/profile/PaymentScreen';
import { ChatScreen } from '../screens/ChatScreen';
import { QRCodeScreen } from '../screens/driver/QRCodeScreen';

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator();

/** Ref global — permite navegar de fora do NavigationContainer (ex: banner de notificação) */
const navigationRef = createNavigationContainerRef<RootStackParamList>();

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

  const { inAppMessage, clearInAppMessage, showBanner } = useNotifications(
    session?.user.id,
    profile?.type as 'passenger' | 'driver' | undefined
  );

  // Lembretes escalonados (2h/1h/30m/15m) das corridas agendadas do motorista.
  // Dispara mesmo com o app fechado; no-op para passageiro / perfil não carregado.
  useDriverReminderScheduler(profile?.type === 'driver' ? profile.id : undefined);

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
  /** Indica se a sessão já está pronta (autenticada) — usado pelo listener de URL. */
  const isAuthedRef = useRef(false);

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
      .from('profiles')
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

  // Escuta deep links (cold start + warm start)
  useEffect(() => {
    ExpoLinking.getInitialURL().then((url: string | null) => { if (url) captureDeepLink(url); });
    const sub = ExpoLinking.addEventListener('url', ({ url }: { url: string }) => captureDeepLink(url));
    return () => sub.remove();
  }, []);

  if (loading) return <LoadingScreen />;

  const isAuthenticated = !!session;
  const isDriver = profile?.type === 'driver';
  // Passageiro sem cartão cadastrado → obriga onboarding antes de entrar no app.
  // IMPORTANTE: só força a tela quando o perfil JÁ carregou e de fato não tem
  // cartão. Se o perfil ainda não veio (null por falha/lentidão de rede), NÃO
  // prende quem já é cadastrado e tem cartão na tela de "adicionar cartão" — o
  // usuário com cadastro completo entra direto no app.
  const needsCard = isAuthenticated && !isDriver && !!profile && !profile.stripe_payment_method_id;

  return (
    <View style={{ flex: 1 }}>
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
            </>
          ) : isDriver ? (
            <>
              <Stack.Screen name="DriverTabs" component={DriverTabs} />
              <Stack.Screen name="DriverNavigate" component={DriverNavigateScreen} />
              <Stack.Screen name="DriverScheduledRides" component={DriverScheduledRidesScreen} />
              <Stack.Screen name="VehicleForm" component={VehicleFormScreen} />
              <Stack.Screen name="DriverVerification" component={DriverVerificationScreen} />
              <Stack.Screen name="QRCode" component={QRCodeScreen} />
              <Stack.Screen name="Chat" component={ChatScreen} />
              <Stack.Screen name="EditProfile" component={EditProfileScreen} />
              <Stack.Screen name="NotificationSettings" component={NotificationSettingsScreen} />
              <Stack.Screen name="Support" component={SupportScreen} />
              <Stack.Screen name="Terms" component={TermsScreen} />
              <Stack.Screen name="Payment" component={PaymentScreen} />
            </>
          ) : needsCard ? (
            /* Passageiro sem cartão: bloqueia no onboarding até cadastrar */
            <>
              <Stack.Screen name="AddCardOnboarding" component={AddCardOnboardingScreen} />
            </>
          ) : (
            <>
              <Stack.Screen name="PassengerTabs" component={PassengerTabs} />
              <Stack.Screen name="RequestRide" component={RequestRideScreen} />
              <Stack.Screen name="FindingDriver" component={FindingDriverScreen} />
              <Stack.Screen name="ActiveRide" component={ActiveRideScreen} />
              <Stack.Screen name="RateRide" component={RateRideScreen} />
              <Stack.Screen name="ScheduledRides" component={ScheduledRidesScreen} />
              <Stack.Screen name="Chat" component={ChatScreen} />
              <Stack.Screen name="EditProfile" component={EditProfileScreen} />
              <Stack.Screen name="NotificationSettings" component={NotificationSettingsScreen} />
              <Stack.Screen name="Support" component={SupportScreen} />
              <Stack.Screen name="Terms" component={TermsScreen} />
              <Stack.Screen name="Payment" component={PaymentScreen} />
            </>
          )}
        </Stack.Navigator>
      </NavigationContainer>

      {/* Banner in-app — aparece sobre qualquer tela, sem precisar de permissão */}
      {inAppMessage && (
        <NotificationBanner message={inAppMessage} onDismiss={clearInAppMessage} />
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
