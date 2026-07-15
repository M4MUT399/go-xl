import React from 'react';
import { View, Text, StyleSheet, SafeAreaView, TouchableOpacity, ScrollView } from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import { useTranslation } from '../../i18n';
import { useDriverRideContext } from '../../contexts/DriverRideContext';
import type { DriverPeriod } from '../../lib/driverPeriodMachine';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'Insurance'> };

/**
 * DriverInsuranceScreen — resumo de cobertura de seguro por período P0-P3
 * (compliance TNC, F.S. 627.748 — ver Bloco 1 em docs/bloco1-compliance-periodos.md).
 *
 * Nos mesmos moldes da tela "Insurance" do app do motorista da Uber: um
 * badge de status ao vivo no topo ("você está agora em: ...") seguido de um
 * cartão por período explicando quando ele se aplica e qual cobertura vale.
 *
 * O badge ao vivo NÃO depende da flag `period_tracking_v1_enabled` (que só
 * liga a GRAVAÇÃO da trilha de auditoria em driver_period_transitions — ver
 * useDriverPeriodTracker.ts). Aqui usamos a máquina server-truth quando ela
 * está habilitada e, quando não está (rollout ainda não chegou à jurisdição
 * do motorista), aproximamos o período a partir do mesmo estado que já
 * dirige a UI hoje (`isOnline` + `activeRide.status`) — o motorista sempre
 * vê um resumo correto do que está coberto, independente do rollout interno.
 */
export function DriverInsuranceScreen({ navigation }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { isOnline, activeRide, driverPeriod, driverPeriodEnabled } = useDriverRideContext();
  const styles = makeStyles(colors);

  const currentPeriod: DriverPeriod = driverPeriodEnabled
    ? driverPeriod
    : !isOnline
      ? 'P0_OFFLINE'
      : activeRide
        ? (activeRide.status === 'in_progress' ? 'P3_ONTRIP' : 'P2_ENROUTE')
        : 'P1_AVAILABLE';

  const periods: { key: DriverPeriod; badgeColor: string }[] = [
    { key: 'P0_OFFLINE', badgeColor: colors.gray[400] },
    { key: 'P1_AVAILABLE', badgeColor: colors.warning },
    { key: 'P2_ENROUTE', badgeColor: colors.accent },
    { key: 'P3_ONTRIP', badgeColor: colors.success },
  ];

  const sectionKey = (p: DriverPeriod) =>
    p === 'P0_OFFLINE' ? 'p0' : p === 'P1_AVAILABLE' ? 'p1' : p === 'P2_ENROUTE' ? 'p2' : 'p3';

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView contentContainerStyle={styles.scroll}>
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()}>
          <Text style={styles.backText}>← {t('common.back')}</Text>
        </TouchableOpacity>

        <Text style={styles.title}>{t('insurance.title')}</Text>
        <Text style={styles.updated}>{t('insurance.updated')}</Text>
        <Text style={styles.intro}>{t('insurance.intro')}</Text>

        {/* Badge de status ao vivo — mesmo espírito do "You're covered" da Uber. */}
        <View style={[styles.liveBadge, { borderColor: periods.find((p) => p.key === currentPeriod)?.badgeColor }]}>
          <View style={[styles.liveDot, { backgroundColor: periods.find((p) => p.key === currentPeriod)?.badgeColor }]} />
          <View style={{ flex: 1 }}>
            <Text style={styles.liveLabel}>{t('insurance.currentLabel')}</Text>
            <Text style={styles.livePeriod}>{t(`insurance.${sectionKey(currentPeriod)}.title`)}</Text>
          </View>
        </View>

        {periods.map(({ key, badgeColor }) => {
          const sk = sectionKey(key);
          const active = key === currentPeriod;
          return (
            <View key={key} style={[styles.card, active && { borderColor: badgeColor, borderWidth: 2 }]}>
              <View style={styles.cardHeader}>
                <View style={[styles.dot, { backgroundColor: badgeColor }]} />
                <Text style={styles.cardTitle}>{t(`insurance.${sk}.title`)}</Text>
              </View>
              <Text style={styles.cardCoverage}>{t(`insurance.${sk}.coverage`)}</Text>
              <Text style={styles.cardBody}>{t(`insurance.${sk}.body`)}</Text>
            </View>
          );
        })}

        <Text style={styles.legal}>{t('insurance.legal')}</Text>
        <Text style={styles.footer}>{t('insurance.footer')}</Text>
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
    liveBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      borderWidth: 1.5,
      borderRadius: 14,
      padding: 14,
      marginBottom: 24,
      backgroundColor: colors.surface,
    },
    liveDot: { width: 12, height: 12, borderRadius: 6, marginRight: 12 },
    liveLabel: { fontSize: 12, color: colors.textMuted, marginBottom: 2 },
    livePeriod: { fontSize: 17, fontWeight: '700', color: colors.text },
    card: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 14,
      padding: 16,
      marginBottom: 14,
      backgroundColor: colors.card,
    },
    cardHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
    dot: { width: 10, height: 10, borderRadius: 5, marginRight: 8 },
    cardTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
    cardCoverage: { fontSize: 14, fontWeight: '600', color: colors.accent, marginBottom: 6 },
    cardBody: { fontSize: 13.5, color: colors.textSecondary, lineHeight: 20 },
    legal: { fontSize: 12, color: colors.gray[400], marginTop: 10, fontStyle: 'italic' },
    footer: { fontSize: 12, color: colors.gray[400], marginTop: 12, lineHeight: 18 },
  });
}
