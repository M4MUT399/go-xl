import React, { useState } from 'react';
import { View, Text, StyleSheet, SafeAreaView, TouchableOpacity, ScrollView, ActivityIndicator, Alert } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import { useTranslation } from '../../i18n';
import { useDriverOnboardingGate } from '../../hooks/useDriverOnboardingGate';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Disclosure'> };

/**
 * DriverDisclosureScreen — termo de divulgação legal do motorista (Bloco 3,
 * compliance TNC F.S. 627.748): explica, em linguagem simples, os pontos que
 * a jurisdição exige que o motorista reconheça antes de ficar online
 * (background check periódico + bane vitalício para certos achados, cobertura
 * de seguro por período, tolerância zero, uso de dados). O aceite é gravado de
 * forma append-only em `driver_disclosure_acceptances` via a RPC
 * `accept_driver_disclosure` (migration 0059) — histórico nunca é apagado nem
 * sobrescrito, mesmo quando a versão do texto muda.
 *
 * Mesmos moldes visuais da DriverInsuranceScreen (Bloco 1): título, subtítulo
 * "atualizado em", intro, cartões e rodapé legal — aqui com um botão de aceite
 * no final em vez de um badge de status ao vivo.
 */
export function DriverDisclosureScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { disclosureAccepted, disclosureVersion, acceptDisclosure } = useDriverOnboardingGate();
  const [accepting, setAccepting] = useState(false);
  const styles = makeStyles(colors);

  async function handleAccept() {
    setAccepting(true);
    const ok = await acceptDisclosure();
    setAccepting(false);
    if (!ok) {
      Alert.alert(t('common.error', 'Error'), t('common.tryAgain', 'Please try again.'));
      return;
    }
    navigation.goBack();
  }

  const points = [1, 2, 3, 4] as const;

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>← {t('common.back')}</Text>
        </TouchableOpacity>

        <Text style={styles.title}>{t('disclosure.title')}</Text>
        <Text style={styles.updated}>{t('disclosure.updated')}</Text>
        <Text style={styles.intro}>{t('disclosure.intro')}</Text>

        {points.map((n) => (
          <View key={n} style={styles.card}>
            <Text style={styles.cardTitle}>{t(`disclosure.point${n}Title`)}</Text>
            <Text style={styles.cardBody}>{t(`disclosure.point${n}Body`)}</Text>
          </View>
        ))}

        <Text style={styles.legal}>{t('disclosure.legal')}</Text>
        <Text style={styles.footer}>{t('disclosure.footer')}</Text>

        {disclosureAccepted ? (
          <View style={styles.acceptedBadge}>
            <Text style={styles.acceptedText}>✓ {t('disclosure.acceptedLabel')} (v{disclosureVersion})</Text>
          </View>
        ) : (
          <TouchableOpacity
            style={[styles.acceptButton, accepting && { opacity: 0.6 }]}
            onPress={handleAccept}
            disabled={accepting}
          >
            {accepting ? <ActivityIndicator color="#fff" /> : <Text style={styles.acceptButtonText}>{t('disclosure.accept')}</Text>}
          </TouchableOpacity>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    scroll: { padding: 24, paddingBottom: 40 },
    back: { marginBottom: 20, alignSelf: 'flex-start' },
    backText: { color: colors.primary, fontSize: 15, fontWeight: '600' },
    title: { fontSize: 26, fontWeight: '800', color: colors.text, marginBottom: 6 },
    updated: { fontSize: 13, color: colors.gray[400], marginBottom: 14 },
    intro: { fontSize: 14, color: colors.textSecondary, lineHeight: 21, marginBottom: 20 },
    card: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 14,
      padding: 16,
      marginBottom: 14,
      backgroundColor: colors.card,
    },
    cardTitle: { fontSize: 16, fontWeight: '700', color: colors.text, marginBottom: 6 },
    cardBody: { fontSize: 13.5, color: colors.textSecondary, lineHeight: 20 },
    legal: { fontSize: 12, color: colors.gray[400], marginTop: 10, fontStyle: 'italic' },
    footer: { fontSize: 12, color: colors.gray[400], marginTop: 12, marginBottom: 24, lineHeight: 18 },
    acceptButton: {
      backgroundColor: colors.primary,
      borderRadius: 14,
      paddingVertical: 16,
      alignItems: 'center',
    },
    acceptButtonText: { color: '#fff', fontSize: 16, fontWeight: '700' },
    acceptedBadge: {
      backgroundColor: colors.success,
      borderRadius: 14,
      paddingVertical: 16,
      alignItems: 'center',
    },
    acceptedText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  });
}
