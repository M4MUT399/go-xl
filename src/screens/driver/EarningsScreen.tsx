import React, { useState, useMemo } from 'react';
import { View, Text, StyleSheet, SafeAreaView, ScrollView, RefreshControl, TouchableOpacity } from 'react-native';
import { Colors } from '../../constants/colors';
import { useAuth } from '../../hooks/useAuth';
import { useDriverStats, CompletedRide } from '../../hooks/useRideHistory';
import { formatCurrency, formatDistance, kmToMiles } from '../../lib/format';

type Period = 'today' | 'week' | 'month' | 'all';

const PERIODS: { key: Period; label: string }[] = [
  { key: 'today', label: 'Hoje' },
  { key: 'week', label: '7 dias' },
  { key: 'month', label: '30 dias' },
  { key: 'all', label: 'Tudo' },
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
  const { profile } = useAuth();
  const { rides, loading, refresh } = useDriverStats(profile?.id);
  const [period, setPeriod] = useState<Period>('week');

  const filtered = useMemo(() => {
    const from = startOf(period);
    return rides.filter((r) => r.completed_at && new Date(r.completed_at).getTime() >= from);
  }, [rides, period]);

  const stats = useMemo(() => {
    const earnings = filtered.reduce((s, r) => s + (Number(r.price) || 0), 0);
    const distance = filtered.reduce((s, r) => s + (Number(r.distance_km) || 0), 0);
    return {
      earnings,
      rides: filtered.length,
      avg: filtered.length ? earnings / filtered.length : 0,
      miles: kmToMiles(distance),
    };
  }, [filtered]);

  // Série dos últimos 7 dias para o gráfico
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
        .reduce((s, r) => s + (Number(r.price) || 0), 0);
      days.push({ label: d.toLocaleDateString('en-US', { weekday: 'short' })[0], value });
    }
    return days;
  }, [rides]);

  const maxChart = Math.max(1, ...chart.map((d) => d.value));

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} tintColor={Colors.accent} />}
      >
        <Text style={styles.title}>Seus ganhos</Text>

        <View style={styles.tabs}>
          {PERIODS.map((p) => (
            <TouchableOpacity
              key={p.key}
              style={[styles.tab, period === p.key && styles.tabActive]}
              onPress={() => setPeriod(p.key)}
            >
              <Text style={[styles.tabText, period === p.key && styles.tabTextActive]}>{p.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <View style={styles.heroCard}>
          <Text style={styles.heroLabel}>{PERIODS.find((p) => p.key === period)?.label.toUpperCase()}</Text>
          <Text style={styles.heroValue}>{formatCurrency(stats.earnings)}</Text>
          <Text style={styles.heroSub}>
            {stats.rides} {stats.rides === 1 ? 'corrida' : 'corridas'} • {stats.miles.toFixed(1)} mi
          </Text>
        </View>

        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{formatCurrency(stats.avg)}</Text>
            <Text style={styles.statLabel}>Média por corrida</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{rides.length}</Text>
            <Text style={styles.statLabel}>Corridas totais</Text>
          </View>
        </View>

        <View style={styles.chartCard}>
          <Text style={styles.chartTitle}>Últimos 7 dias</Text>
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

        <Text style={styles.sectionTitle}>Corridas no período</Text>
        {filtered.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyEmoji}>💰</Text>
            <Text style={styles.emptyText}>Nenhuma corrida concluída neste período.</Text>
          </View>
        ) : (
          <View style={styles.historyList}>
            {filtered.slice(0, 20).map((ride) => (
              <EarningRow key={ride.id} ride={ride} />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function EarningRow({ ride }: { ride: CompletedRide }) {
  const date = new Date(ride.completed_at);
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
      <Text style={styles.rowPrice}>+ {formatCurrency(ride.price)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.offWhite },
  scroll: { padding: 16, paddingTop: 12, paddingBottom: 24 },
  title: { fontSize: 28, fontWeight: '800', color: Colors.primary, marginBottom: 16 },
  tabs: { flexDirection: 'row', backgroundColor: Colors.white, borderRadius: 12, padding: 4, marginBottom: 16 },
  tab: { flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: 'center' },
  tabActive: { backgroundColor: Colors.primary },
  tabText: { fontSize: 13, fontWeight: '600', color: Colors.gray[500] },
  tabTextActive: { color: Colors.white },
  heroCard: { backgroundColor: Colors.primary, borderRadius: 20, padding: 24, alignItems: 'center', marginBottom: 12 },
  heroLabel: { fontSize: 12, color: Colors.accent, letterSpacing: 1.5, fontWeight: '700' },
  heroValue: { fontSize: 44, fontWeight: '900', color: Colors.white, marginVertical: 6, letterSpacing: -1 },
  heroSub: { fontSize: 14, color: Colors.gray[400] },
  statsRow: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  statCard: { flex: 1, backgroundColor: Colors.white, borderRadius: 16, padding: 18, alignItems: 'center' },
  statValue: { fontSize: 20, fontWeight: '800', color: Colors.primary },
  statLabel: { fontSize: 12, color: Colors.gray[500], marginTop: 4 },
  chartCard: { backgroundColor: Colors.white, borderRadius: 16, padding: 18, marginBottom: 24 },
  chartTitle: { fontSize: 15, fontWeight: '700', color: Colors.primary, marginBottom: 16 },
  chart: { flexDirection: 'row', alignItems: 'flex-end', height: 120, gap: 8 },
  chartCol: { flex: 1, alignItems: 'center' },
  barWrap: { width: '100%', height: 100, justifyContent: 'flex-end', backgroundColor: Colors.gray[100], borderRadius: 6, overflow: 'hidden' },
  bar: { width: '100%', backgroundColor: Colors.accent, borderRadius: 6, minHeight: 3 },
  chartLabel: { fontSize: 11, color: Colors.gray[500], marginTop: 6 },
  sectionTitle: { fontSize: 17, fontWeight: '700', color: Colors.primary, marginBottom: 12 },
  historyList: { backgroundColor: Colors.white, borderRadius: 16, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: Colors.gray[100] },
  rowIcon: { width: 38, height: 38, borderRadius: 19, backgroundColor: Colors.gray[100], alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  rowInfo: { flex: 1 },
  rowAddr: { fontSize: 14, fontWeight: '600', color: Colors.gray[800] },
  rowDate: { fontSize: 12, color: Colors.gray[500], marginTop: 2 },
  rowPrice: { fontSize: 15, fontWeight: '800', color: Colors.success },
  empty: { alignItems: 'center', paddingVertical: 40 },
  emptyEmoji: { fontSize: 44, marginBottom: 12 },
  emptyText: { fontSize: 14, color: Colors.gray[500], textAlign: 'center' },
});
