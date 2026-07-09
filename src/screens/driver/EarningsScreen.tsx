import React, { useState, useMemo } from 'react';
import { View, Text, StyleSheet, SafeAreaView, ScrollView, RefreshControl, TouchableOpacity, Alert, ActivityIndicator, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../hooks/useTheme';
import { AppTheme } from '../../constants/theme';
import { useAuth } from '../../hooks/useAuth';
import { useDriverStats, CompletedRide } from '../../hooks/useRideHistory';
import { usePayouts } from '../../hooks/usePayouts';
import { useConnectAccount } from '../../hooks/useConnectAccount';
import { useWaybillConfig } from '../../hooks/useWaybillConfig';
import { generateAndShareWaybill } from '../../lib/waybillExport';
import { formatCurrency, formatDistance, kmToMiles } from '../../lib/format';
import { DRIVER_SHARE } from '../../lib/split';
import { useTranslation } from '../../i18n';

type Period = 'today' | 'week' | 'month' | 'all';

const PERIODS: { key: Period; labelKey: string }[] = [
  { key: 'today', labelKey: 'earnings.periodToday' },
  { key: 'week', labelKey: 'earnings.periodWeek' },
  { key: 'month', labelKey: 'earnings.periodMonth' },
  { key: 'all', labelKey: 'earnings.periodAll' },
];

function startOf(period: Period): number {
  if (period === 'all') return 0;
  const d = new Date();
  if (period === 'today') {
    d.setHours(0, 0, 0, 0);
  } else if (period === 'week') {
    d.setDate(d.getDate() - 6);
    d.setHours(0, 0, 0, 0);
  } else {
    d.setDate(d.getDate() - 29);
    d.setHours(0, 0, 0, 0);
  }
  return d.getTime();
}

export function EarningsScreen() {
  const { t } = useTranslation();
  const { profile } = useAuth();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { rides, loading, refresh } = useDriverStats(profile?.id);
  const { payouts, pendingBalance, pendingRidesCount, loading: payoutsLoading, refresh: refreshPayouts, requestPayout } = usePayouts(profile?.id);
  const { status: connect, loading: connectLoading, onboarding, refresh: refreshConnect, startOnboarding } = useConnectAccount(profile?.id);
  const waybill = useWaybillConfig();
  const [period, setPeriod] = useState<Period>('week');
  const [requestingPayout, setRequestingPayout] = useState(false);

  const onRefresh = () => {
    refresh();
    refreshPayouts();
    refreshConnect();
  };

  async function handleOnboard() {
    const result = await startOnboarding();
    if (!result.ok) {
      Alert.alert(t('earnings.errorTitle'), result.error ?? t('earnings.onboardError'));
    }
  }

  const styles = makeStyles(colors);

  const filtered = useMemo(() => {
    const from = startOf(period);
    return rides.filter((r) => r.completed_at && new Date(r.completed_at).getTime() >= from);
  }, [rides, period]);

  const stats = useMemo(() => {
    const gross = filtered.reduce((s, r) => s + (Number(r.price) || 0), 0);
    // Usa driver_amount se disponível, fallback para gross * DRIVER_SHARE
    const net = filtered.reduce((s, r) => {
      const da = (r as CompletedRide & { driver_amount?: number }).driver_amount;
      return s + (da != null ? Number(da) : (Number(r.price) || 0) * DRIVER_SHARE);
    }, 0);
    const distance = filtered.reduce((s, r) => s + (Number(r.distance_km) || 0), 0);
    return {
      gross: Math.round(gross * 100) / 100,
      net: Math.round(net * 100) / 100,
      platformFee: Math.round((gross - net) * 100) / 100,
      rides: filtered.length,
      avg: filtered.length ? Math.round((net / filtered.length) * 100) / 100 : 0,
      miles: kmToMiles(distance),
    };
  }, [filtered]);

  async function handleRequestPayout() {
    Alert.alert(
      t('earnings.requestPayoutTitle'),
      t('earnings.requestPayoutMessage')
        .replace('{amount}', formatCurrency(pendingBalance))
        .replace('{count}', String(pendingRidesCount)),
      [
        { text: t('earnings.cancel'), style: 'cancel' },
        {
          text: t('earnings.request'),
          onPress: async () => {
            setRequestingPayout(true);
            const result = await requestPayout();
            setRequestingPayout(false);
            if (result.ok) {
              Alert.alert(t('earnings.payoutSentTitle'), t('earnings.payoutSentMessage'));
            } else {
              Alert.alert(t('earnings.errorTitle'), result.error ?? t('earnings.tryAgain'));
            }
          },
        },
      ]
    );
  }

  // Série dos últimos 7 dias para o gráfico (ganho líquido)
  const chart = useMemo(() => {
    const days: { label: string; value: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      d.setHours(0, 0, 0, 0);
      const next = d.getTime() + 24 * 60 * 60 * 1000;
      const value = rides
        .filter((r) => {
          const t = new Date(r.completed_at).getTime();
          return t >= d.getTime() && t < next;
        })
        .reduce((s, r) => {
          const da = (r as CompletedRide & { driver_amount?: number }).driver_amount;
          return s + (da != null ? Number(da) : (Number(r.price) || 0) * DRIVER_SHARE);
        }, 0);
      days.push({ label: d.toLocaleDateString('en-US', { weekday: 'short' })[0], value });
    }
    return days;
  }, [rides]);

  const maxChart = Math.max(1, ...chart.map((d) => d.value));

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={[styles.scroll, Platform.OS === 'android' && { paddingBottom: 24 + insets.bottom }]}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={onRefresh} tintColor={colors.accent} />}
      >
        <Text style={styles.title}>{t('earnings.title')}</Text>

        <View style={styles.tabs}>
          {PERIODS.map((p) => (
            <TouchableOpacity
              key={p.key}
              style={[styles.tab, period === p.key && styles.tabActive]}
              onPress={() => setPeriod(p.key)}
            >
              <Text style={[styles.tabText, period === p.key && styles.tabTextActive]}>{t(p.labelKey)}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.heroCard}>
          <Text style={styles.heroLabel}>{t('earnings.heroLabel').replace('{period}', t(PERIODS.find((p) => p.key === period)?.labelKey ?? '').toUpperCase())}</Text>
          <Text style={styles.heroValue}>{formatCurrency(stats.net)}</Text>
          <Text style={styles.heroSub}>
            {stats.rides} {stats.rides === 1 ? t('earnings.ride') : t('earnings.rides')} • {stats.miles.toFixed(1)} mi
          </Text>
          <View style={styles.heroDivider} />
          <View style={styles.heroBreakdown}>
            <View style={styles.heroBreakdownItem}>
              <Text style={styles.heroBreakdownLabel}>{t('earnings.gross')}</Text>
              <Text style={styles.heroBreakdownValue}>{formatCurrency(stats.gross)}</Text>
            </View>
            <View style={styles.heroBreakdownSep} />
            <View style={styles.heroBreakdownItem}>
              <Text style={styles.heroBreakdownLabel}>{t('earnings.platformFee')}</Text>
              <Text style={styles.heroBreakdownValue}>- {formatCurrency(stats.platformFee)}</Text>
            </View>
          </View>
        </View>

        {/* Banner de configuração de recebimento (Stripe Connect Express).
            Aparece enquanto a conta não pode receber payouts. */}
        {!connectLoading && !connect.payoutsEnabled && (
          <View style={styles.connectBanner}>
            <View style={styles.connectInfo}>
              <Text style={styles.connectTitle}>
                {connect.needsAttention ? t('earnings.connectReviewTitle') : t('earnings.connectSetupTitle')}
              </Text>
              <Text style={styles.connectSub}>
                {connect.needsAttention
                  ? t('earnings.connectReviewSub')
                  : t('earnings.connectSetupSub')}
              </Text>
            </View>
            <TouchableOpacity
              style={styles.connectBtn}
              onPress={handleOnboard}
              disabled={onboarding}
            >
              {onboarding
                ? <ActivityIndicator size="small" color={colors.primary} />
                : <Text style={styles.connectBtnText}>{connect.hasAccount ? t('earnings.continue') : t('earnings.configure')}</Text>
              }
            </TouchableOpacity>
          </View>
        )}

        {/* Card de saldo disponível para repasse */}
        <View style={styles.balanceCard}>
          <View style={styles.balanceInfo}>
            <Text style={styles.balanceLabel}>{t('earnings.balanceLabel')}</Text>
            <Text style={styles.balanceValue}>{formatCurrency(pendingBalance)}</Text>
            {pendingRidesCount > 0 && (
              <Text style={styles.balanceSub}>{t('earnings.balanceSub').replace('{count}', String(pendingRidesCount))}</Text>
            )}
            {connect.payoutsEnabled && (
              <Text style={styles.balanceOk}>{t('earnings.balanceOk')}</Text>
            )}
          </View>
          <TouchableOpacity
            style={[styles.payoutBtn, (pendingBalance <= 0 || requestingPayout || !connect.payoutsEnabled) && styles.payoutBtnDisabled]}
            onPress={handleRequestPayout}
            disabled={pendingBalance <= 0 || requestingPayout || !connect.payoutsEnabled}
          >
            {requestingPayout
              ? <ActivityIndicator size="small" color={colors.white} />
              : <Text style={styles.payoutBtnText}>{t('earnings.payoutBtn')}</Text>
            }
          </TouchableOpacity>
        </View>

        {connect.payoutsEnabled && (
          <Text style={styles.autoPayoutNote}>
            {t('earnings.autoPayoutNote')}
          </Text>
        )}

        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{formatCurrency(stats.avg)}</Text>
            <Text style={styles.statLabel}>{t('earnings.avgNetPerRide')}</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{rides.length}</Text>
            <Text style={styles.statLabel}>{t('earnings.totalRides')}</Text>
          </View>
        </View>

        <View style={styles.chartCard}>
          <Text style={styles.chartTitle}>{t('earnings.last7Days')}</Text>
          <View style={styles.chart}>
            {chart.map((d, i) => (
              <View key={i} style={styles.chartCol}>
                <View style={styles.barWrap}>
                  <View style={[styles.bar, { height: `${Math.round((d.value / maxChart) * 100)}%` }]} />
                </View>
                <Text style={styles.chartLabel}>{d.label}</Text>
              </View>
            ))}
          </View>
        </View>

        {payouts.length > 0 && (
          <>
            <Text style={styles.sectionTitle}>{t('earnings.payoutHistory')}</Text>
            <View style={[styles.historyList, { marginBottom: 24 }]}>
              {payouts.slice(0, 5).map((p) => (
                <View key={p.id} style={styles.row}>
                  <View style={styles.rowIcon}>
                    <Text style={{ fontSize: 16 }}>💸</Text>
                  </View>
                  <View style={styles.rowInfo}>
                    <Text style={styles.rowAddr}>{t('earnings.ridesCount').replace('{count}', String(p.rides_count))}</Text>
                    <Text style={styles.rowDate}>
                      {new Date(p.requested_at).toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </Text>
                  </View>
                  <View style={styles.payoutStatusWrap}>
                    <Text style={styles.rowPrice}>{formatCurrency(p.amount)}</Text>
                    <Text style={[styles.payoutStatus, p.status === 'completed' && styles.payoutDone]}>
                      {p.status === 'pending' ? t('earnings.statusPending') : p.status === 'processing' ? t('earnings.statusProcessing') : p.status === 'completed' ? t('earnings.statusCompleted') : t('earnings.statusFailed')}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          </>
        )}

        <Text style={styles.sectionTitle}>{t('earnings.ridesInPeriod')}</Text>
        {filtered.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyEmoji}>💰</Text>
            <Text style={styles.emptyText}>{t('earnings.noRidesInPeriod')}</Text>
          </View>
        ) : (
          <View style={styles.historyList}>
            {filtered.slice(0, 20).map((ride) => (
              <EarningRow
                key={ride.id}
                ride={ride}
                styles={styles}
                showWaybill={waybill.enabled}
                driverName={profile?.full_name ?? null}
                accent={colors.accent}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function EarningRow({
  ride,
  styles,
  showWaybill,
  driverName,
  accent,
}: {
  ride: CompletedRide;
  styles: ReturnType<typeof makeStyles>;
  showWaybill: boolean;
  driverName: string | null;
  accent: string;
}) {
  const { t } = useTranslation();
  const date = new Date(ride.completed_at);
  const [generating, setGenerating] = useState(false);

  async function handleWaybill() {
    if (generating) return;
    setGenerating(true);
    const result = await generateAndShareWaybill(ride.id, { driverName });
    setGenerating(false);
    if (!result.ok && result.error !== 'disabled') {
      Alert.alert(t('earnings.receiptUnavailableTitle'), t('earnings.receiptUnavailableMessage'));
    }
  }

  return (
    <View style={styles.row}>
      <View style={styles.rowIcon}>
        <Text style={{ fontSize: 16 }}>🚗</Text>
      </View>
      <View style={styles.rowInfo}>
        <Text style={styles.rowAddr} numberOfLines={1}>{ride.destination_address}</Text>
        <Text style={styles.rowDate}>
          {date.toLocaleDateString('en-US', { day: '2-digit', month: 'short' })} • {formatDistance(ride.distance_km)}
        </Text>
      </View>
      <View style={styles.rowRight}>
        <Text style={styles.rowPrice}>+ {formatCurrency(ride.price)}</Text>
        {showWaybill && (
          <TouchableOpacity
            style={styles.waybillBtn}
            onPress={handleWaybill}
            disabled={generating}
            accessibilityRole="button"
            accessibilityLabel={t('earnings.generateReceiptA11y')}
          >
            {generating
              ? <ActivityIndicator size="small" color={accent} />
              : <Text style={styles.waybillBtnText}>{t('earnings.receipt')}</Text>
            }
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

function makeStyles(colors: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface },
    scroll: { padding: 16, paddingTop: 12, paddingBottom: 24 },
    title: { fontSize: 28, fontWeight: '800', color: colors.text, marginBottom: 16 },
    tabs: { flexDirection: 'row', backgroundColor: colors.card, borderRadius: 12, padding: 4, marginBottom: 16 },
    tab: { flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: 'center' },
    tabActive: { backgroundColor: colors.primary },
    tabText: { fontSize: 13, fontWeight: '600', color: colors.gray[500] },
    tabTextActive: { color: colors.white },
    heroCard: { backgroundColor: colors.primary, borderRadius: 20, padding: 24, alignItems: 'center', marginBottom: 12 },
    heroLabel: { fontSize: 11, color: colors.accent, letterSpacing: 1.2, fontWeight: '700', textAlign: 'center' },
    heroValue: { fontSize: 44, fontWeight: '900', color: colors.white, marginVertical: 6, letterSpacing: -1 },
    heroSub: { fontSize: 14, color: colors.gray[400] },
    heroDivider: { width: '100%', height: 1, backgroundColor: 'rgba(255,255,255,0.15)', marginVertical: 14 },
    heroBreakdown: { flexDirection: 'row', width: '100%', justifyContent: 'space-around' },
    heroBreakdownItem: { alignItems: 'center' },
    heroBreakdownLabel: { fontSize: 11, color: colors.gray[400], marginBottom: 2 },
    heroBreakdownValue: { fontSize: 14, fontWeight: '700', color: colors.white },
    heroBreakdownSep: { width: 1, backgroundColor: 'rgba(255,255,255,0.2)' },
    balanceCard: {
      backgroundColor: colors.card,
      borderRadius: 16,
      padding: 18,
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 12,
      borderLeftWidth: 4,
      borderLeftColor: colors.accent,
    },
    balanceInfo: { flex: 1 },
    balanceLabel: { fontSize: 12, color: colors.gray[500], fontWeight: '600', marginBottom: 4 },
    balanceValue: { fontSize: 26, fontWeight: '900', color: colors.text },
    balanceSub: { fontSize: 11, color: colors.gray[400], marginTop: 2 },
    balanceOk: { fontSize: 11, color: colors.success, fontWeight: '700', marginTop: 4 },
    autoPayoutNote: { fontSize: 11, color: colors.gray[400], lineHeight: 15, marginTop: -6, marginBottom: 14, paddingHorizontal: 4 },
    connectBanner: {
      backgroundColor: colors.primary,
      borderRadius: 16,
      padding: 16,
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 12,
    },
    connectInfo: { flex: 1, paddingRight: 12 },
    connectTitle: { fontSize: 15, fontWeight: '800', color: colors.white, marginBottom: 4 },
    connectSub: { fontSize: 12, color: colors.gray[400], lineHeight: 16 },
    connectBtn: {
      backgroundColor: colors.accent,
      borderRadius: 12,
      paddingHorizontal: 16,
      paddingVertical: 10,
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: 92,
    },
    connectBtnText: { color: colors.primary, fontSize: 13, fontWeight: '800' },
    payoutBtn: {
      backgroundColor: colors.accent,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 10,
      alignItems: 'center',
      minWidth: 80,
    },
    payoutBtnDisabled: { backgroundColor: colors.gray[300] },
    payoutBtnText: { color: colors.primary, fontSize: 12, fontWeight: '800', textAlign: 'center' },
    payoutStatusWrap: { alignItems: 'flex-end' },
    payoutStatus: { fontSize: 11, color: colors.gray[500], fontWeight: '600', marginTop: 2 },
    payoutDone: { color: colors.success },
    statsRow: { flexDirection: 'row', gap: 12, marginBottom: 12 },
    statCard: { flex: 1, backgroundColor: colors.card, borderRadius: 16, padding: 18, alignItems: 'center' },
    statValue: { fontSize: 20, fontWeight: '800', color: colors.text },
    statLabel: { fontSize: 12, color: colors.gray[500], marginTop: 4 },
    chartCard: { backgroundColor: colors.card, borderRadius: 16, padding: 18, marginBottom: 24 },
    chartTitle: { fontSize: 15, fontWeight: '700', color: colors.text, marginBottom: 16 },
    chart: { flexDirection: 'row', alignItems: 'flex-end', height: 120, gap: 8 },
    chartCol: { flex: 1, alignItems: 'center' },
    barWrap: { width: '100%', height: 100, justifyContent: 'flex-end', backgroundColor: colors.gray[100], borderRadius: 6, overflow: 'hidden' },
    bar: { width: '100%', backgroundColor: colors.accent, borderRadius: 6, minHeight: 3 },
    chartLabel: { fontSize: 11, color: colors.gray[500], marginTop: 6 },
    sectionTitle: { fontSize: 17, fontWeight: '700', color: colors.text, marginBottom: 12 },
    historyList: { backgroundColor: colors.card, borderRadius: 16, overflow: 'hidden' },
    row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.gray[100] },
    rowIcon: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.gray[100], alignItems: 'center', justifyContent: 'center', marginRight: 12 },
    rowInfo: { flex: 1 },
    rowAddr: { fontSize: 14, fontWeight: '600', color: colors.gray[800] },
    rowDate: { fontSize: 12, color: colors.gray[500], marginTop: 2 },
    rowRight: { alignItems: 'flex-end' },
    rowPrice: { fontSize: 15, fontWeight: '800', color: colors.success },
    waybillBtn: {
      marginTop: 6,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: colors.accent,
      minWidth: 62,
      alignItems: 'center',
    },
    waybillBtnText: { fontSize: 11, fontWeight: '700', color: colors.accent },
    empty: { alignItems: 'center', paddingVertical: 40 },
    emptyEmoji: { fontSize: 44, marginBottom: 12 },
    emptyText: { fontSize: 14, color: colors.gray[500], textAlign: 'center' },
  });
}
