import React, { useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity,
  ActivityIndicator, Alert,
} from 'react-native';
import * as WebBrowser from 'expo-web-browser';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../types';
import { useTheme } from '../hooks/useTheme';
import { useAuth } from '../hooks/useAuth';
import { supabase } from '../lib/supabase';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Payment'> };

const SUPABASE_URL    = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const SETUP_CARD_URL  = `${SUPABASE_URL}/functions/v1/setup-card`;

const BRAND_LABEL: Record<string, string> = {
  visa:       'Visa',
  mastercard: 'Mastercard',
  amex:       'Amex',
  discover:   'Discover',
  jcb:        'JCB',
  diners:     'Diners',
  unionpay:   'UnionPay',
};

export function PaymentScreen({ navigation }: Props) {
  const { profile, refreshProfile } = useAuth();
  const { colors } = useTheme();
  const [loading, setLoading] = useState(false);

  const styles = makeStyles(colors);
  const hasCard = !!profile?.stripe_payment_method_id;
  const brandLabel = profile?.card_brand ? (BRAND_LABEL[profile.card_brand] ?? profile.card_brand.toUpperCase()) : 'CARTÃO';

  async function handleAddCard() {
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) { Alert.alert('Erro', 'Sessão expirada. Faça login novamente.'); return; }

      const res = await fetch(SETUP_CARD_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({}),
      });

      const json = await res.json() as { url?: string; error?: string };
      if (!json.url) {
        Alert.alert('Erro', json.error ?? 'Não foi possível abrir o formulário de pagamento.');
        return;
      }

      // Abre o Stripe Checkout no navegador do aparelho
      await WebBrowser.openBrowserAsync(json.url);

      // Aguarda o webhook do Stripe gravar o cartão (normalmente < 2s)
      await new Promise<void>((r) => setTimeout(r, 2500));
      await refreshProfile();
    } catch {
      Alert.alert('Erro', 'Não foi possível configurar o pagamento. Tente novamente.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* ── Cabeçalho ── */}
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.back}>
          <Text style={styles.backText}>←</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Pagamento</Text>
      </View>

      <View style={styles.content}>
        <View style={styles.card}>
          {hasCard ? (
            /* ── Cartão salvo ── */
            <>
              <Text style={styles.cardEmoji}>💳</Text>
              <Text style={styles.cardBrandText}>{brandLabel}</Text>
              <Text style={styles.cardNumber}>•••• •••• •••• {profile?.card_last4}</Text>
              <Text style={styles.cardInfo}>
                Seu cartão é debitado automaticamente quando o motorista aceitar a corrida.
              </Text>
              <TouchableOpacity
                style={styles.changeBtn}
                onPress={handleAddCard}
                disabled={loading}
              >
                {loading
                  ? <ActivityIndicator color={colors.primary} />
                  : <Text style={styles.changeBtnText}>Alterar cartão</Text>}
              </TouchableOpacity>
            </>
          ) : (
            /* ── Sem cartão ── */
            <>
              <Text style={[styles.cardEmoji, styles.cardEmojiMuted]}>💳</Text>
              <Text style={styles.noCardTitle}>Nenhum cartão salvo</Text>
              <Text style={styles.noCardSub}>
                Adicione um cartão para pedir corridas. O pagamento é feito automaticamente no momento em que o motorista aceita.
              </Text>
              <TouchableOpacity
                style={styles.addBtn}
                onPress={handleAddCard}
                disabled={loading}
              >
                {loading
                  ? <ActivityIndicator color={colors.white} />
                  : <Text style={styles.addBtnText}>Adicionar cartão</Text>}
              </TouchableOpacity>
            </>
          )}
        </View>

        <Text style={styles.secureNote}>🔒 Dados processados com segurança pelo Stripe</Text>
      </View>
    </SafeAreaView>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface },

    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 16,
      paddingVertical: 12,
      backgroundColor: colors.card,
      borderBottomWidth: 1,
      borderBottomColor: colors.gray[100],
    },
    back: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
    backText: { fontSize: 24, color: colors.primary },
    title: { fontSize: 18, fontWeight: '700', color: colors.text, marginLeft: 4 },

    content: { flex: 1, padding: 20, justifyContent: 'center' },

    card: {
      backgroundColor: colors.card,
      borderRadius: 20,
      padding: 28,
      alignItems: 'center',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.08,
      shadowRadius: 16,
      elevation: 4,
    },

    cardEmoji:     { fontSize: 52, marginBottom: 14 },
    cardEmojiMuted:{ opacity: 0.25 },

    cardBrandText: {
      fontSize: 13,
      fontWeight: '800',
      color: colors.gray[500],
      letterSpacing: 3,
      marginBottom: 6,
    },
    cardNumber: {
      fontSize: 22,
      fontWeight: '700',
      color: colors.text,
      letterSpacing: 4,
      marginBottom: 16,
    },
    cardInfo: {
      fontSize: 13,
      color: colors.gray[500],
      textAlign: 'center',
      lineHeight: 18,
      marginBottom: 24,
    },

    changeBtn: {
      paddingVertical: 12,
      paddingHorizontal: 28,
      borderRadius: 12,
      borderWidth: 1.5,
      borderColor: colors.primary,
      minWidth: 160,
      alignItems: 'center',
    },
    changeBtnText: { fontSize: 15, fontWeight: '700', color: colors.primary },

    noCardTitle: { fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 10 },
    noCardSub: {
      fontSize: 14,
      color: colors.gray[500],
      textAlign: 'center',
      lineHeight: 20,
      marginBottom: 28,
      paddingHorizontal: 8,
    },

    addBtn: {
      backgroundColor: colors.primary,
      paddingVertical: 14,
      paddingHorizontal: 36,
      borderRadius: 14,
      minWidth: 200,
      alignItems: 'center',
    },
    addBtnText: { color: colors.white, fontSize: 16, fontWeight: '700' },

    secureNote: {
      marginTop: 20,
      fontSize: 12,
      color: colors.gray[400],
      textAlign: 'center',
    },
  });
}
