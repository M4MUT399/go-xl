import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity,
  ActivityIndicator, Share, Alert, ScrollView,
} from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme } from '../../hooks/useTheme';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../hooks/useAuth';
import { useTranslation } from '../../i18n';
import type { RootStackParamList } from '../../types';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'QRCode'>;
};

/**
 * Deriva um código de 6 letras/números a partir do UUID do motorista.
 * Determinístico: mesmo ID → mesmo código. Único porque UUIDs são únicos.
 * Não precisa de consulta ao banco para verificar unicidade.
 */
function codeFromId(id: string): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const hex = id.replace(/-/g, '');
  let result = '';
  for (let i = 0; i < 6; i++) {
    const byte = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
    result += chars[byte % chars.length];
  }
  return result;
}

export function QRCodeScreen({ navigation }: Props) {
  const { profile, refreshProfile } = useAuth();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [code, setCode] = useState<string | null>(profile?.driver_code ?? null);
  const [saving, setSaving] = useState(false);

  const styles = makeStyles(colors);

  // Gera e salva o código na primeira vez que o motorista abre esta tela
  useEffect(() => {
    if (code || !profile?.id) return;

    const newCode = codeFromId(profile.id);
    setSaving(true);

    supabase
      .from('profiles')
      .update({ driver_code: newCode })
      .eq('id', profile.id)
      .then(({ error }) => {
        if (!error) {
          setCode(newCode);
          refreshProfile?.();
        } else {
          // Mesmo com erro no save, exibe o QR com o código derivado
          console.warn('[QRCode] erro ao salvar driver_code:', error.message);
          setCode(newCode);
        }
        setSaving(false);
      });
  }, [profile?.id]);

  /** URL que o QR code vai codificar.
   *
   *  Agora é uma landing **https** (goxl.app/qr?driver=CODE) em vez do custom
   *  scheme direto. Motivo: a câmera nativa (iOS/Android) e qualquer leitor de
   *  QR abrem https sem atrito, mesmo em quem **não** tem o app. A landing:
   *   • se o app está instalado → faz o "bounce" para goxl://ride?driver=CODE
   *     (mesmo padrão da página /track), e o AppNavigator trava a corrida;
   *   • se NÃO está instalado → grava `goxl-ride:CODE` no clipboard (deferred
   *     deep link) e manda para a loja; no 1º open o app lê o clipboard e trava
   *     a corrida no motorista dono do QR.
   *  Ver src/lib/deferredDeepLink.ts e go-xl-site/qr/index.html.
   */
  const deepLink = code ? `https://goxl.app/qr?driver=${code}` : null;

  const handleShare = useCallback(async () => {
    if (!deepLink || !code) return;
    try {
      await Share.share({
        message: t('qr.shareMessage')
          .replace('{code}', code)
          .replace('{deepLink}', deepLink),
        title: t('qr.shareTitle'),
      });
    } catch {
      // usuário cancelou
    }
  }, [deepLink, code]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.back}>
          <Text style={styles.backText}>←</Text>
        </TouchableOpacity>
        <Text style={styles.title}>{t('qr.title')}</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll}>
        <View style={styles.card}>
          {/* Título do card */}
          <Text style={styles.cardTitle}>Go<Text style={{ color: colors.accent }}>XL</Text></Text>
          <Text style={styles.cardSub}>Executive XL</Text>

          {/* QR Code */}
          <View style={styles.qrWrapper}>
            {saving ? (
              <ActivityIndicator color={colors.accent} size="large" />
            ) : deepLink ? (
              <QRCode
                value={deepLink}
                size={200}
                color={colors.primary}
                backgroundColor={colors.white}
                logo={undefined}
              />
            ) : null}
          </View>

          {/* Código legível */}
          {code && (
            <View style={styles.codeBox}>
              <Text style={styles.codeLabel}>{t('qr.codeLabel')}</Text>
              <Text style={styles.codeValue}>{code}</Text>
            </View>
          )}

          {/* Motorista */}
          <Text style={styles.driverName}>{profile?.full_name}</Text>
          <Text style={styles.category}>Executive XL — Go XL</Text>
        </View>

        {/* Instruções */}
        <View style={styles.instructions}>
          <Text style={styles.instrTitle}>{t('qr.howItWorks')}</Text>

          <View style={styles.instrItem}>
            <Text style={styles.instrIcon}>📱</Text>
            <Text style={styles.instrText}>
              {t('qr.step1')}
            </Text>
          </View>

          <View style={styles.instrItem}>
            <Text style={styles.instrIcon}>⬇️</Text>
            <Text style={styles.instrText}>
              {t('qr.step2')}
            </Text>
          </View>

          <View style={styles.instrItem}>
            <Text style={styles.instrIcon}>🔒</Text>
            <Text style={styles.instrText}>
              {t('qr.step3')}
            </Text>
          </View>

          <View style={styles.instrItem}>
            <Text style={styles.instrIcon}>✅</Text>
            <Text style={styles.instrText}>
              {t('qr.step4')}
            </Text>
          </View>
        </View>

        {/* Botão compartilhar */}
        <TouchableOpacity style={styles.shareBtn} onPress={handleShare} disabled={!code}>
          <Text style={styles.shareBtnText}>📤  {t('qr.shareButton')}</Text>
        </TouchableOpacity>

        <Text style={styles.note}>
          {t('qr.note')}
        </Text>
      </ScrollView>
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
    back: { marginRight: 16, padding: 4 },
    backText: { fontSize: 24, color: colors.primary },
    title: { fontSize: 20, fontWeight: '700', color: colors.text },
    scroll: { padding: 16, alignItems: 'center' },

    card: {
      backgroundColor: colors.card,
      borderRadius: 24,
      padding: 28,
      alignItems: 'center',
      width: '100%',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.08,
      shadowRadius: 16,
      elevation: 4,
      marginBottom: 24,
    },
    cardTitle: { fontSize: 28, fontWeight: '900', color: colors.text, letterSpacing: -1 },
    cardSub: { fontSize: 12, color: colors.accent, fontWeight: '600', marginBottom: 20, letterSpacing: 1 },

    qrWrapper: {
      padding: 16,
      backgroundColor: colors.white,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.gray[100],
      marginBottom: 20,
      minWidth: 232,
      minHeight: 232,
      alignItems: 'center',
      justifyContent: 'center',
    },

    codeBox: {
      backgroundColor: colors.primary,
      borderRadius: 12,
      paddingHorizontal: 24,
      paddingVertical: 10,
      alignItems: 'center',
      marginBottom: 16,
    },
    codeLabel: { fontSize: 10, color: colors.accent, fontWeight: '700', letterSpacing: 2, marginBottom: 2 },
    codeValue: { fontSize: 28, fontWeight: '900', color: colors.white, letterSpacing: 6 },

    driverName: { fontSize: 16, fontWeight: '700', color: colors.text },
    category: { fontSize: 12, color: colors.gray[500], marginTop: 4 },

    instructions: {
      backgroundColor: colors.card,
      borderRadius: 16,
      padding: 20,
      width: '100%',
      marginBottom: 20,
    },
    instrTitle: { fontSize: 15, fontWeight: '800', color: colors.text, marginBottom: 14 },
    instrItem: { flexDirection: 'row', marginBottom: 12, alignItems: 'flex-start' },
    instrIcon: { fontSize: 18, marginRight: 12, lineHeight: 24 },
    instrText: { flex: 1, fontSize: 13, color: colors.gray[600], lineHeight: 20 },

    shareBtn: {
      backgroundColor: colors.accent,
      borderRadius: 16,
      paddingVertical: 16,
      paddingHorizontal: 32,
      width: '100%',
      alignItems: 'center',
      marginBottom: 14,
    },
    shareBtnText: { fontSize: 15, fontWeight: '800', color: colors.primary },

    note: { fontSize: 12, color: colors.gray[400], textAlign: 'center', paddingHorizontal: 24 },
  });
}
