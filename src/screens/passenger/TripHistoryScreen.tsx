import React from 'react';
import { View, Text, StyleSheet, SafeAreaView, FlatList, RefreshControl, ActivityIndicator } from 'react-native';
import { Colors } from '../../constants/colors';
import { useAuth } from '../../hooks/useAuth';
import { useRideHistory } from '../../hooks/useRideHistory';
import type { RideRecord } from '../../types';

export function TripHistoryScreen() {
  const { profile } = useAuth();
  const { rides, loading, refresh } = useRideHistory(profile?.id, 'passenger');

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Suas viagens</Text>
        <Text style={styles.subtitle}>{rides.length} {rides.length === 1 ? 'corrida' : 'corridas'}</Text>
      </View>

      {loading && rides.length === 0 ? (
        <ActivityIndicator color={Colors.accent} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={rides}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} tintColor={Colors.accent} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyEmoji}>🚗</Text>
              <Text style={styles.emptyTitle}>Nenhuma viagem ainda</Text>
              <Text style={styles.emptyText}>Suas corridas Executive XL aparecerão aqui</Text>
            </View>
          }
          renderItem={({ item }) => <TripCard ride={item} />}
        />
      )}
    </SafeAreaView>
  );
}

function TripCard({ ride }: { ride: RideRecord }) {
  const date = new Date(ride.created_at);
  const cancelled = ride.status === 'cancelled';

  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <Text style={styles.cardDate}>
          {date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' })}
          {' • '}
          {date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
        </Text>
        <View style={[styles.statusBadge, cancelled ? styles.statusCancelled : styles.statusCompleted]}>
          <Text style={[styles.statusText, cancelled ? styles.statusTextCancelled : styles.statusTextCompleted]}>
            {cancelled ? 'Cancelada' : 'Concluída'}
          </Text>
        </View>
      </View>

      <View style={styles.route}>
        <View style={styles.routeIcons}>
          <View style={styles.dotOrigin} />
          <View style={styles.routeLine} />
          <View style={styles.dotDest} />
        </View>
        <View style={styles.routeText}>
          <Text style={styles.addr} numberOfLines={1}>{ride.origin_address}</Text>
          <Text style={[styles.addr, { marginTop: 16 }]} numberOfLines={1}>{ride.destination_address}</Text>
        </View>
      </View>

      {!cancelled && (
        <View style={styles.cardFooter}>
          <Text style={styles.distance}>{Number(ride.distance_km).toFixed(1)} km</Text>
          <Text style={styles.price}>R$ {Number(ride.price).toFixed(2)}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.offWhite },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 16 },
  title: { fontSize: 28, fontWeight: '800', color: Colors.primary },
  subtitle: { fontSize: 14, color: Colors.gray[500], marginTop: 2 },
  list: { paddingHorizontal: 16, paddingBottom: 24, flexGrow: 1 },
  card: {
    backgroundColor: Colors.white,
    borderRadius: 16,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  cardDate: { fontSize: 12, color: Colors.gray[500] },
  statusBadge: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  statusCompleted: { backgroundColor: 'rgba(34,197,94,0.12)' },
  statusCancelled: { backgroundColor: 'rgba(239,68,68,0.12)' },
  statusText: { fontSize: 11, fontWeight: '700' },
  statusTextCompleted: { color: Colors.success },
  statusTextCancelled: { color: Colors.error },
  route: { flexDirection: 'row' },
  routeIcons: { width: 16, alignItems: 'center', paddingTop: 4 },
  dotOrigin: { width: 9, height: 9, borderRadius: 5, backgroundColor: Colors.accent },
  routeLine: { flex: 1, width: 2, backgroundColor: Colors.gray[200], marginVertical: 3 },
  dotDest: { width: 9, height: 9, borderRadius: 2, backgroundColor: Colors.primary },
  routeText: { flex: 1, marginLeft: 12 },
  addr: { fontSize: 14, color: Colors.gray[800], fontWeight: '500' },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: Colors.gray[100],
  },
  distance: { fontSize: 13, color: Colors.gray[500] },
  price: { fontSize: 17, fontWeight: '800', color: Colors.primary },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  emptyEmoji: { fontSize: 48, marginBottom: 16 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: Colors.primary, marginBottom: 6 },
  emptyText: { fontSize: 14, color: Colors.gray[500], textAlign: 'center' },
});
