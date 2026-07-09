/**
 * Cadastro Expresso — ativado quando um passageiro NOVO escaneia o QR do motorista.
 *
 * Decisão de produto: para a 1ª corrida sair o mais rápido possível, pede-se
 * SÓ O CARTÃO. A conta é criada com um nome provisório e sem telefone; o
 * cadastro completo (nome / e-mail / telefone) é cobrado depois, quando o
 * passageiro for agendar ou pedir a 2ª viagem.
 *
 * Fluxo:
 *   1. Adiciona cartão via Stripe (browser)
 *   2. Corrida é solicitada automaticamente, travada no motorista do QR
 */

import React, { useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity,
  ActivityIndicator, Alert,
} from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-aware-scroll-view';
import * as WebBrowser from 'expo-web-browser';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { RootStackParamList } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import { AppTheme } from '../../constants/theme';
import { supabase } from '../../lib/supabase';
import { setPendingExpressRide } from '../../lib/expressRide';
import { EXPRESS_PLACEHOLDER_NAME } from '../../lib/onboarding';
import { useTranslation } from '../../i18n';

const SUPABASE_URL    = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SETUP_CARD_URL  = `${SUPABASE_URL}/functions/v1/setup-card`;

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'ExpressRegister'>;
  route:      RouteProp<RootStackParamList, 'ExpressRegister'>;
};

export function ExpressRegisterScreen({ navigation, route }: Props) {
  const { driverCode } = route.params;
  const { colors } = useTheme();
  const { t } = useTranslation();

  const [loading, setLoading] = useState(false);
  const [step,    setStep]    = useState<'card' | 'done'>('card');

  const styles = makeStyles(colors);

  async function handleContinue() {
    setLoading(true);
    try {
      // ── 1. Busca o motorista pelo código ───────────────────────────────────
      const { data: driver } = await supabase
        .from('profiles')
        .select('id, full_name')
        .eq('driver_code', driverCode)
        .eq('type', 'driver')
        .maybeSingle();

      const driverId   = (driver as { id: string; full_name: string } | null)?.id ?? null;
      const driverName = (driver as { id: string; full_name: string } | null)?.full_name ?? '';

      if (!driverId) {
        Alert.alert(t('express.invalidCodeTitle'), t('express.invalidCodeMessage'));
        return;
      }

      // ── 2. Cria conta expressa no Supabase ────────────────────────────────
      // E-mail interno único (o passageiro informa o e-mail real depois, no
      // cadastro completo). Senha aleatória — não é necessária agora.
      const ts    = Date.now();
      const email = `express_${ts}@goxl.express`;
      const password = `${Math.random().toString(36).slice(2)}${ts.toString(36)}`;

      const { data: authData, error: authError } = await supabase.auth.signUp({ email, password });
      if (authError || !authData.user) {
        throw authError ?? new Error(t('express.errorCreateAccount'));
      }

      const userId = authData.user.id;

      // ── 3. Cria o perfil provisório (sem telefone = cadastro incompleto) ──
      await supabase.from('profiles').insert({
        id:         userId,
        full_name:  EXPRESS_PLACEHOLDER_NAME,
        phone:      '',
        email,
        type:       'passenger',
      });

      // ── 4. Registra corrida expressa pendente (antes do redirect de auth) ─
      setPendingExpressRide(driverId, driverName);

      // ── 5. Abre Stripe Checkout para adicionar cartão ─────────────────────
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error(t('express.errorNoSession'));

      const res  = await fetch(SETUP_CARD_URL, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({}),
      });

      const json = await res.json() as { url?: string; error?: string };
      if (!json.url) {
        throw new Error(json.error ?? t('express.errorPaymentForm'));
      }

      await WebBrowser.openBrowserAsync(json.url);

      // Aguarda o webhook salvar o cartão (~2,5 s)
      await new Promise<void>((r) => setTimeout(r, 2500));
      setStep('done');

      // A partir daqui o AppNavigator detecta a sessão e dispara a corrida
      // expressa via consumePendingExpressRide() → RequestRide travado no motorista.

    } catch (e: unknown) {
      const err = e as { message?: string };
      Alert.alert(t('express.errorTitle'), err?.message ?? t('express.errorGeneric'));
      setStep('card');
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAwareScrollView
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="handled"
        enableOnAndroid
        extraScrollHeight={20}
      >

          {/* Logo */}
          <Text style={styles.logo}>
            Go<Text style={{ color: colors.accent }}>XL</Text>
          </Text>

          <Text style={styles.title}>{t('express.title')}</Text>
          <Text style={styles.subtitle}>{t('express.subtitle')}</Text>

          {/* Steps indicator (2 passos) */}
          <View style={styles.steps}>
            <View style={[styles.step, styles.stepActive]}>
              <Text style={styles.stepNum}>1</Text>
              <Text style={styles.stepLabel}>{t('express.stepCard')}</Text>
            </View>
            <View style={styles.stepLine} />
            <View style={[styles.step, step === 'done' && styles.stepActive]}>
              <Text style={[styles.stepNum, step !== 'done' && styles.stepNumInactive]}>2</Text>
              <Text style={[styles.stepLabel, step !== 'done' && styles.stepLabelInactive]}>{t('express.stepRide')}</Text>
            </View>
          </View>

          {/* Cartão de destaque */}
          <View style={styles.cardBox}>
            <Text style={styles.cardEmoji}>💳</Text>
            <Text style={styles.cardTitle}>{t('express.cardTitle')}</Text>
            <Text style={styles.cardText}>{t('express.cardText')}</Text>
          </View>

          <TouchableOpacity
            style={[styles.btn, (loading || step === 'done') && { opacity: 0.7 }]}
            onPress={handleContinue}
            disabled={loading || step === 'done'}
          >
            {loading ? (
              <ActivityIndicator color={colors.primary} />
            ) : step === 'done' ? (
              <Text style={styles.btnText}>{t('express.btnDone')}</Text>
            ) : (
              <Text style={styles.btnText}>{t('express.btnSubmit')}</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.loginLink}
            onPress={() => navigation.navigate('Login')}
            disabled={loading}
          >
            <Text style={styles.loginLinkText}>{t('express.loginLink')}</Text>
          </TouchableOpacity>

          <Text style={styles.legalNote}>{t('express.legalNote')}</Text>
      </KeyboardAwareScrollView>
    </SafeAreaView>
  );
}

function makeStyles(colors: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    scroll:    { flexGrow: 1, paddingHorizontal: 28, paddingVertical: 32, alignItems: 'center' },

    logo:     { fontSize: 36, fontWeight: '900', color: colors.text, marginBottom: 8 },
    title:    { fontSize: 24, fontWeight: '800', color: colors.text, textAlign: 'center', marginBottom: 8 },
    subtitle: { fontSize: 14, color: colors.gray[500], textAlign: 'center', lineHeight: 20, marginBottom: 28 },

    // Steps
    steps: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 32,
      width: '100%',
      justifyContent: 'center',
    },
    step:      { alignItems: 'center' },
    stepLine:  { flex: 1, height: 2, backgroundColor: colors.gray[200], marginHorizontal: 8 },
    stepActive: {},
    stepNum:   { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.accent, textAlign: 'center', lineHeight: 32, fontSize: 14, fontWeight: '800', color: colors.primary, overflow: 'hidden' },
    stepNumInactive: { backgroundColor: colors.gray[200], color: colors.gray[400] },
    stepLabel: { fontSize: 11, fontWeight: '700', color: colors.text, marginTop: 4 },
    stepLabelInactive: { color: colors.gray[400] },

    // Card box
    cardBox: {
      width: '100%',
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 22,
      alignItems: 'center',
      marginBottom: 28,
    },
    cardEmoji: { fontSize: 40, marginBottom: 10 },
    cardTitle: { fontSize: 16, fontWeight: '800', color: colors.text, textAlign: 'center', marginBottom: 8 },
    cardText:  { fontSize: 13, color: colors.gray[500], textAlign: 'center', lineHeight: 20 },

    btn: {
      backgroundColor: colors.accent,
      borderRadius: 14,
      paddingVertical: 16,
      width: '100%',
      alignItems: 'center',
      marginBottom: 16,
    },
    btnText: { fontSize: 16, fontWeight: '800', color: colors.primary },

    loginLink:     { marginBottom: 24 },
    loginLinkText: { fontSize: 14, color: colors.text, fontWeight: '600', textDecorationLine: 'underline' },

    legalNote: { fontSize: 11, color: colors.gray[400], textAlign: 'center', lineHeight: 16 },
  });
}
