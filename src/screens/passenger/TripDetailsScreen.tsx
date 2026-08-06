import React, { useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, ScrollView, TouchableOpacity, Platform, Alert, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { RootStackParamList, RideRecord } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import { useTranslation } from '../../i18n';
import { AppTheme } from '../../constants/theme';
import { formatCurrency, formatDistance } from '../../lib/format';
import { useAuth } from '../../hooks/useAuth';
import { useFeatureFlag } from '../../hooks/useFeatureFlag';
import { generateAndShareWaybill } from '../../lib/waybillExport';

type Props = NativeStackScreenProps<RootStackParamList, 'TripDetails'>;

// Reaproveita a mesma semântica de status do histórico para manter as cores
// e os rótulos consistentes entre o card da lista e a tela de detalhes.
function statusInfo(ride: RideRecord) {
  switch (ride.status) {
    case 'completed':
      return { labelKey: 'history.statusCompleted', style: 'completed' as const };
    case 'cancelled':
      return { labelKey: 'history.statusCancelled', style: 'cancelled' as const };
    case 'scheduled':
      return { labelKey: 'history.statusScheduled', style: 'scheduled' as const };
    default:
      return { labelKey: 'history.statusInProgress', style: 'scheduled' as const };
  }
}

function fmtDateTime(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const date = d.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  return `${date} • ${time}`;
}

function fmtDuration(min?: number | null): string | null {
  const n = Number(min);
  if (!n || n <= 0) return null;
  const h = Math.floor(n / 60);
  const m = Math.round(n % 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, '0')}min` : `${m} min`;
}

export function TripDetailsScreen({ navigation, route }: Props) {
  const { ride } = route.params;
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { profile } = useAuth();
  const insets = useSafeAreaInsets();
  const styles = makeStyles(colors);

  // Bloco 4 (compliance TNC F.S. 627.748): recibo eletrônico completo pro
  // passageiro -- reaproveita 100% a infra do waybill do motorista (mesma
  // generateAndShareWaybill/PDF, ver src/lib/waybillExport.ts). Só disponível
  // pra corrida já concluída (paga).
  const receiptEnabled = useFeatureFlag('receipt_passenger_v1_enabled', profile?.jurisdiction ?? 'global');
  const [generatingReceipt, setGeneratingReceipt] = useState(false);

  async function handleReceipt() {
    if (generatingReceipt) return;
    setGeneratingReceipt(true);
    const result = await generateAndShareWaybill(ride.id, { passengerName: profile?.full_name });
    setGeneratingReceipt(false);
    if (!result.ok && result.error !== 'disabled') {
      Alert.alert(t('tripDetails.receiptUnavailableTitle'), t('tripDetails.receiptUnavailableMessage'));
    }
  }

  const info = statusInfo(ride);
  const isCancelled = ride.status === 'cancelled';
  const scheduled = fmtDateTime(ride.scheduled_for);
  const requested = fmtDateTime(ride.created_at);
  const accepted = fmtDateTime(ride.accepted_at);
  const completed = fmtDateTime(ride.completed_at);
  const duration = fmtDuration(ride.duration_min);

  // Só renderiza linhas de metadados que existem — evita "—" espalhados.
  const rows: { label: string; value: string }[] = [];
  rows.push({ label: t('tripDetails.distance'), value: formatDistance(ride.distance_km) });
  if (duration) rows.push({ label: t('tripDetails.duration'), value: duration });
  if (scheduled) rows.push({ label: t('tripDetails.scheduledFor'), value: scheduled });
  if (requested) rows.push({ label: t('tripDetails.requestedAt'), value: requested });
  if (accepted) rows.push({ label: t('tripDetails.acceptedAt'), value: accepted });
  if (completed) rows.push({ label: t('tripDetails.completedAt'), value: completed });

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.back} onPress={() => navigation.goBack()} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Text style={styles.backText}>← {t('common.back')}</Text>
        </TouchableOpacity>
        <Text style={styles.title}>{t('tripDetails.title')}</Text>
      </View>

      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          Platform.OS === 'android' && { paddingBottom: 24 + insets.bottom },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {/* Status */}
        <View style={styles.statusRow}>
          <View style={[styles.badge, styles[`badge_${info.style}`]]}>
            <Text style={[styles.badgeText, styles[`badgeText_${info.style}`]]}>{t(info.labelKey)}</Text>
          </View>
        </View>

        {/* Trajeto */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>{t('tripDetails.routeSection')}</Text>
          <View style={styles.route}>
            <View style={styles.routeIcons}>
              <View style={styles.dotOrigin} />
              <View style={styles.routeLine} />
              <View style={styles.dotDest} />
            </View>
            <View style={styles.routeText}>
              <Text style={styles.stopLabel}>{t('tripDetails.pickup')}</Text>
              <Text style={styles.addr}>{ride.origin_address}</Text>
              <Text style={[styles.stopLabel, { marginTop: 18 }]}>{t('tripDetails.dropoff')}</Text>
              <Text style={styles.addr}>{ride.destination_address}</Text>
            </View>
          </View>
        </View>

        {/* Metadados da viagem */}
        <View style={styles.card}>
          <Text style={styles.cardLabel}>{t('tripDetails.tripSection')}</Text>
          {rows.map((r, i) => (
            <View key={r.label} style={[styles.metaRow, i > 0 && styles.metaRowDivider]}>
              <Text style={styles.metaLabel}>{r.label}</Text>
              <Text style={styles.metaValue}>{r.value}</Text>
            </View>
          ))}
        </View>

        {/* Pagamento */}
        {!isCancelled && (
          <View style={styles.card}>
            <Text style={styles.cardLabel}>{t('tripDetails.paymentSection')}</Text>
            <View style={styles.metaRow}>
              <Text style={styles.metaLabel}>{t('tripDetails.paymentStatus')}</Text>
              <Text style={[styles.payTag, ride.paid ? styles.payTagPaid : styles.payTagUnpaid]}>
                {ride.paid ? t('history.paid') : t('history.unpaid')}
              </Text>
            </View>
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>{t('tripDetails.total')}</Text>
              <Text style={styles.totalValue}>{formatCurrency(ride.price)}</Text>
            </View>

            {receiptEnabled && ride.status === 'completed' && (
              <TouchableOpacity
                style={styles.receiptBtn}
                onPress={handleReceipt}
                disabled={generatingReceipt}
                accessibilityRole="button"
                accessibilityLabel={t('tripDetails.receiptA11y')}
              >
                {generatingReceipt
                  ? <ActivityIndicator size="small" color={colors.primary} />
                  : <Text style={styles.receiptBtnText}>{t('tripDetails.downloadReceipt')}</Text>}
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Referência p/ suporte */}
        <View style={styles.idRow}>
          <Text style={styles.idLabel}>{t('tripDetails.rideId')}</Text>
          <Text style={styles.idValue}>#{ride.id.slice(0, 8).toUpperCase()}</Text>
        </View>

        <TouchableOpacity style={styles.supportBtn} onPress={() => navigation.navigate('Support')}>
          <Text style={styles.supportBtnText}>{t('tripDetails.contactSupport')}</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(colors: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface },
    header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 },
    back: { alignSelf: 'flex-start', marginBottom: 10 },
    backText: { color: colors.primary, fontSize: 15, fontWeight: '600' },
    title: { fontSize: 26, fontWeight: '800', color: colors.text },
    scroll: { paddingHorizontal: 16, paddingBottom: 32, paddingTop: 8 },

    statusRow: { flexDirection: 'row', marginBottom: 14 },
    badge: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 5 },
    badge_completed: { backgroundColor: 'rgba(34,197,94,0.12)' },
    badge_cancelled: { backgroundColor: 'rgba(239,68,68,0.12)' },
    badge_scheduled: { backgroundColor: 'rgba(201,168,76,0.15)' },
    badgeText: { fontSize: 12, fontWeight: '700' },
    badgeText_completed: { color: colors.success },
    badgeText_cancelled: { color: colors.error },
    badgeText_scheduled: { color: colors.accent },

    card: {
      backgroundColor: colors.card,
      borderRadius: 16,
      padding: 16,
      marginBottom: 12,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.05,
      shadowRadius: 8,
      elevation: 2,
    },
    cardLabel: {
      fontSize: 12, fontWeight: '700', color: colors.gray[500],
      letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 14,
    },

    route: { flexDirection: 'row' },
    routeIcons: { width: 16, alignItems: 'center', paddingTop: 6 },
    dotOrigin: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.accent },
    routeLine: { flex: 1, width: 2, backgroundColor: colors.gray[200], marginVertical: 4, minHeight: 40 },
    dotDest: { width: 10, height: 10, borderRadius: 2, backgroundColor: colors.primary },
    routeText: { flex: 1, marginLeft: 14 },
    stopLabel: { fontSize: 11, fontWeight: '700', color: colors.gray[400], letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 3 },
    addr: { fontSize: 15, color: colors.text, fontWeight: '500' },

    metaRow: {
      flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
      paddingVertical: 11,
    },
    metaRowDivider: { borderTopWidth: 1, borderTopColor: colors.gray[100] },
    metaLabel: { fontSize: 14, color: colors.gray[500] },
    metaValue: { fontSize: 14, color: colors.text, fontWeight: '600', flexShrink: 1, textAlign: 'right', marginLeft: 12 },

    payTag: { fontSize: 12, fontWeight: '700', overflow: 'hidden', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 3 },
    payTagPaid: { color: colors.success, backgroundColor: 'rgba(34,197,94,0.12)' },
    payTagUnpaid: { color: colors.gray[500], backgroundColor: colors.gray[100] },
    totalRow: {
      flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
      marginTop: 14, paddingTop: 14, borderTopWidth: 1, borderTopColor: colors.gray[100],
    },
    totalLabel: { fontSize: 15, fontWeight: '700', color: colors.text },
    totalValue: { fontSize: 22, fontWeight: '800', color: colors.primary },

    // Recibo eletrônico do passageiro (Bloco 4)
    receiptBtn: {
      marginTop: 14, paddingVertical: 12, borderRadius: 10,
      borderWidth: 1.5, borderColor: colors.primary, alignItems: 'center',
    },
    receiptBtnText: { fontSize: 14, fontWeight: '700', color: colors.primary },

    idRow: {
      flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
      paddingHorizontal: 4, paddingVertical: 6, marginBottom: 16,
    },
    idLabel: { fontSize: 12, color: colors.gray[400], textTransform: 'uppercase', letterSpacing: 0.5 },
    idValue: { fontSize: 13, fontWeight: '700', color: colors.gray[500], letterSpacing: 1 },

    supportBtn: {
      borderWidth: 1.5, borderColor: colors.gray[200], borderRadius: 12,
      paddingVertical: 15, alignItems: 'center',
    },
    supportBtnText: { fontSize: 15, fontWeight: '700', color: colors.primary },
  });
}
