/**
 * Cadastro Expresso — ativado quando um passageiro NOVO escaneia o QR do motorista.
 * Fluxo:
 *   1. Informa nome + telefone
 *   2. Adiciona cartão via Stripe (browser)
 *   3. Corrida é solicitada automaticamente vinculada ao motorista do QR
 *
 * O cadastro completo (e-mail / senha) pode ser feito depois, no Perfil.
 */

import React, { useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity,
  TextInput, ActivityIndicator, Alert,
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

const SUPABASE_URL    = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SETUP_CARD_URL  = `${SUPABASE_URL}/functions/v1/setup-card`;

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'ExpressRegister'>;
  route:      RouteProp<RootStackParamList, 'ExpressRegister'>;
};

export function ExpressRegisterScreen({ navigation, route }: Props) {
  const { driverCode } = route.params;
  const { colors } = useTheme();

  const [name,    setName]    = useState('');
  const [phone,   setPhone]   = useState('');
  const [loading, setLoading] = useState(false);
  const [step,    setStep]    = useState<'form' | 'card' | 'done'>('form');

  const styles = makeStyles(colors);

  async function handleContinue() {
    if (!name.trim()) {
      Alert.alert('Nome obrigatório', 'Por favor, informe seu nome completo.');
      return;
    }
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 10) {
      Alert.alert('Telefone inválido', 'Informe um número de telefone válido com DDD.');
      return;
    }

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
        Alert.alert('Código inválido', 'Não encontramos o motorista deste QR Code. Peça um novo ao motorista.');
        return;
      }

      // ── 2. Cria conta expressa no Supabase ────────────────────────────────
      // Email derivado do telefone (único) + sufixo para não conflitar com contas reais.
      const ts    = Date.now();
      const email = `express_${digits}_${ts}@goxl.express`;
      // Senha aleatória — o passageiro não precisa dela agora.
      // Ele pode redefinir mais tarde pelo fluxo "Esqueci a senha" (com o e-mail acima)
      // ou configurar e-mail/senha real pelo Perfil.
      const password = `${Math.random().toString(36).slice(2)}${ts.toString(36)}`;

      const { data: authData, error: authError } = await supabase.auth.signUp({ email, password });
      if (authError || !authData.user) {
        throw authError ?? new Error('Não foi possível criar a conta.');
      }

      const userId = authData.user.id;

      // ── 3. Cria o perfil ──────────────────────────────────────────────────
      await supabase.from('profiles').insert({
        id:         userId,
        full_name:  name.trim(),
        phone:      digits,
        email,
        type:       'passenger',
      });

      // ── 4. Registra corrida expressa pendente (antes do redirect de auth) ─
      setPendingExpressRide(driverId, driverName);

      // ── 5. Abre Stripe Checkout para adicionar cartão ─────────────────────
      setStep('card');
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Sessão não disponível.');

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
        throw new Error(json.error ?? 'Não foi possível abrir o formulário de pagamento.');
      }

      await WebBrowser.openBrowserAsync(json.url);

      // Aguarda o webhook salvar o cartão (~2,5 s)
      await new Promise<void>((r) => setTimeout(r, 2500));
      setStep('done');

      // A partir daqui o AppNavigator detecta a sessão e dispara a corrida
      // expressa via consumePendingExpressRide() → RequestRide travado no motorista.

    } catch (e: unknown) {
      const err = e as { message?: string };
      Alert.alert('Erro', err?.message ?? 'Ocorreu um erro. Tente novamente.');
      setStep('form');
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

          <Text style={styles.title}>Corrida Expressa 🚀</Text>
          <Text style={styles.subtitle}>
            Preencha seus dados e adicione um cartão.{'\n'}
            Em menos de 1 minuto você está a caminho!
          </Text>

          {/* Steps indicator */}
          <View style={styles.steps}>
            <View style={[styles.step, styles.stepActive]}>
              <Text style={styles.stepNum}>1</Text>
              <Text style={styles.stepLabel}>Dados</Text>
            </View>
            <View style={styles.stepLine} />
            <View style={[styles.step, step !== 'form' && styles.stepActive]}>
              <Text style={[styles.stepNum, step === 'form' && styles.stepNumInactive]}>2</Text>
              <Text style={[styles.stepLabel, step === 'form' && styles.stepLabelInactive]}>Cartão</Text>
            </View>
            <View style={styles.stepLine} />
            <View style={[styles.step, step === 'done' && styles.stepActive]}>
              <Text style={[styles.stepNum, step !== 'done' && styles.stepNumInactive]}>3</Text>
              <Text style={[styles.stepLabel, step !== 'done' && styles.stepLabelInactive]}>Corrida</Text>
            </View>
          </View>

          {/* Formulário */}
          <View style={styles.form}>
            <Text style={styles.label}>Nome completo</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder="Ex: João Silva"
              placeholderTextColor={colors.gray[400]}
              autoCapitalize="words"
              editable={!loading}
            />

            <Text style={styles.label}>Celular (com DDD)</Text>
            <TextInput
              style={styles.input}
              value={phone}
              onChangeText={setPhone}
              placeholder="(11) 99999-9999"
              placeholderTextColor={colors.gray[400]}
              keyboardType="phone-pad"
              editable={!loading}
            />
          </View>

          <Text style={styles.hint}>
            💳 No próximo passo você vai adicionar seu cartão de crédito.{'\n'}
            O pagamento é feito automaticamente quando o motorista aceitar.
          </Text>

          <TouchableOpacity
            style={[styles.btn, (loading || step === 'done') && { opacity: 0.7 }]}
            onPress={handleContinue}
            disabled={loading || step === 'done'}
          >
            {loading ? (
              <ActivityIndicator color={colors.primary} />
            ) : step === 'card' ? (
              <Text style={styles.btnText}>Aguardando cartão...</Text>
            ) : step === 'done' ? (
              <Text style={styles.btnText}>✓ Pronto! Carregando corrida...</Text>
            ) : (
              <Text style={styles.btnText}>Continuar → Adicionar cartão</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.loginLink}
            onPress={() => navigation.navigate('Login')}
            disabled={loading}
          >
            <Text style={styles.loginLinkText}>Já tenho conta — Entrar</Text>
          </TouchableOpacity>

          <Text style={styles.legalNote}>
            Cadastro completo (e-mail e senha) pode ser feito depois no Perfil.
            Dados protegidos com criptografia.
          </Text>
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

    // Form
    form:  { width: '100%', marginBottom: 16 },
    label: { fontSize: 13, fontWeight: '700', color: colors.gray[600], marginBottom: 6, marginTop: 16 },
    input: {
      backgroundColor: colors.gray[100],
      borderRadius: 12,
      paddingHorizontal: 16,
      paddingVertical: 14,
      fontSize: 16,
      color: colors.text,
      borderWidth: 1.5,
      borderColor: colors.gray[200],
    },

    hint: {
      fontSize: 13,
      color: colors.gray[500],
      textAlign: 'center',
      lineHeight: 20,
      marginBottom: 24,
      paddingHorizontal: 8,
    },

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
