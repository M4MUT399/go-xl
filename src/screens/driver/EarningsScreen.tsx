import React from 'react';
import { View, Text, StyleSheet, SafeAreaView, ScrollView, RefreshControl, FlatList } from 'react-native';
import { Colors } from '../../constants/colors';
import { useAuth } from '../../hooks/useAuth';
import { useDriverEarnings, useRideHistory } from '../../hooks/useRideHistory';
import type { RideRecord } from '../../types';

export function EarningsScreen() {
  const { profile } = useAuth();
  const { earnings, loading, refresh } = useDriverEarnings(profile?.id);
  const { rides, refresh: refreshHistory } = useRideHistory(profile?.id, 'driver');

  const completed = rides.filter((r) => r.status === 'completed');

  function onRefresh() {
    refresh();
    refreshHistory();
  }

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={styles.scroll}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={onRefresh} tintColor={Colors.accent} />}
      >
        <Text style={styles.title}>Seus ganhos</Text>

        <View style={styles.heroCard}>
          <Text style={styles.heroLabel}>HOJE</Text>
          <Text style={styles.heroValue}>R$ {earnings.todayEarnings.toFixed(2)}</Text>
          <Text style={styles.heroSub}>
            {earnings.todayRides} {earnings.todayRides === 1 ? 'corrida' : 'corridas'} hoje
          </Text>
        </View>

        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>R$ {earnings.totalEarnings.toFixed(2)}</Text>
            <Text style={styles.statLabel}>Total acumulado</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{earnings.totalRides}</Text>
            <Text style={styles.statLabel}>Corridas totais</Text>
          </View>
        </View>

        <View style={styles.statCardWide}>
          <Text style={styles.statValueAccent}>R$ {earnings.avgPerRide.toFixed(2)}</Text>
          <Text style={styles.statLabel}>Média por corrida</Text>
        </View>

        <Text style={styles.sectionTitle}>Corridas recentes</Text>

        {completed.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyEmoji}>💰</Text>
            <Text style={styles.emptyText}>Suas corridas concluídas aparecerão aqui</Text>
          </View>
        ) : (
          <View style={styles.historyList}>
            {completed.slice(0, 10).map((ride) => (
              <EarningRow key={ride.id} ride={ride} />
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

function EarningRow({ ride }: { ride: RideRecord }) {
  const date = new Date(ride.completed_at ?? ride.created_at);
  return (
    <View style={styles.row}>
      <View style={styles.rowIcon}>
        <Text style={{ fontSize: 16 }}>🚗</Text>
      </View>
      <View style={styles.rowInfo}>
        <Text style={styles.rowAddr} numberOfLines={1}>{ride.destination_address}</Text>
        <Text style={styles.rowDate}>
          {date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' })}
          {' • '}
          {Number(ride.distance_km).toFixed(1)} km
        </Text>
      </View>
      <Text style={styles.rowPrice}>+ R$ {Number(ride.price).toFixed(2)}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.offWhite },
  scroll: { padding: 16, paddingTop: 12, paddingBottom: 24 },
  title: { fontSize: 28, fontWeight: '800', color: Colors.primary, marginBottom: 16 },
  heroCard: {
    backgroundColor: Colors.primary,
    borderRadius: 20,
    padding: 24,
    alignItems: 'center',
    marginBottom: 12,
  },
  heroLabel: { fontSize: 12, color: Colors.accent, letterSpacing: 1.5, fontWeight: '700' },
  heroValue: { fontSize: 44, fontWeight: '900', color: Colors.white, marginVertical: 6, letterSpacing: -1 },
  heroSub: { fontSize: 14, color: Colors.gray[400] },
  statsRow: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  statCard: {
    flex: 1,
    backgroundColor: Colors.white,
    borderRadius: 16,
    padding: 18,
    alignItems: 'center',
  },
  statCardWide: {
    backgroundColor: Colors.white,
    borderRadius: 16,
    padding: 18,
    alignItems: 'center',
    marginBottom: 24,
  },
  statValue: { fontSize: 20, fontWeight: '800', color: Colors.primary },
  statValueAccent: { fontSize: 22, fontWeight: '800', color: Colors.accent },
  statLabel: { fontSize: 12, color: Colors.gray[500], marginTop: 4 },
  sectionTitle: { fontSize: 17, fontWeight: '700', color: Colors.primary, marginBottom: 12 },
  historyList: { backgroundColor: Colors.white, borderRadius: 16, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: Colors.gray[100],
  },
  rowIcon: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: Colors.gray[100],
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  rowInfo: { flex: 1 },
  rowAddr: { fontSize: 14, fontWeight: '600', color: Colors.gray[800] },
  rowDate: { fontSize: 12, color: Colors.gray[500], marginTop: 2 },
  rowPrice: { fontSize: 15, fontWeight: '800', color: Colors.success },
  empty: { alignItems: 'center', paddingVertical: 40 },
  emptyEmoji: { fontSize: 44, marginBottom: 12 },
  emptyText: { fontSize: 14, color: Colors.gray[500], textAlign: 'center' },
});
