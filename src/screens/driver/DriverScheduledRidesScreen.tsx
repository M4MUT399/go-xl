import React, { useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, SectionList, TouchableOpacity,
  ActivityIndicator, RefreshControl, Alert,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { RootStackParamList, RideRecord, Ride } from '../../types';
import { Colors } from '../../constants/colors';
import { useAuth } from '../../hooks/useAuth';
import { useDriverScheduledRides } from '../../hooks/useDriverScheduledRides';
import { useScheduledRides } from '../../hooks/useRide';
import { formatCurrency, formatDistance } from '../../lib/format';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'DriverScheduledRides'> };

export function DriverScheduledRidesScreen({ navigation }: Props) {
  const { profile } = useAuth();
  const { available, claimed, loading, refresh } = useDriverScheduledRides(profile?.id);
  const { claimScheduledRide, activate } = useScheduledRides(profile?.id);
  const [claiming, setClaiming] = useState<string | null>(null);

  useFocusEffect(
    React.useCallback(() => { refresh(); }, [refresh])
  );

  async function handleClaim(ride: RideRecord) {
    Alert.alert(
      'Confirmar corrida agendada',
      `Confirmar que você buscará o passageiro em:\n${ride.origin_address}\n\nData: ${formatDate(ride.scheduled_for)}`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Confirmar',
          onPress: async () => {
            if (!profile?.id) return;
            setClaiming(ride.id);
            const ok = await claimScheduledRide(ride.id, profile.id);
            setClaiming(null);
            if (ok) {
              Alert.alert('✅ Confirmado!', 'O passageiro será notificado que você irá buscá-lo.');
              refresh();
            } else {
              Alert.alert('Ops', 'Essa corrida já foi confirmada por outro motorista.');
            }
          },
        },
      ]
    );
  }

  async function handleStartClaimed(ride: RideRecord) {
    const activated = await activate(ride.id);
    if (activated) {
      navigation.navigate('DriverNavigate', { ride: activated as Ride });
    }
  }

  const sections = [
    ...(claimed.length > 0 ? [{ title: 'Minhas confirmadas', data: claimed, type: 'claimed' as const }] : []),
    ...(available.length > 0 ? [{ title: 'Disponíveis', data: available, type: 'available' as const }] : []),
  ];

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.back}>
          <Text style={styles.backText}>←</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Corridas Agendadas</Text>
      </View>

      {loading && sections.length === 0 ? (
        <ActivityIndicator color={Colors.accent} style={{ marginTop: 40 }} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} tintColor={Colors.accent} />}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyEmoji}>🗓️</Text>
              <Text style={styles.emptyTitle}>Nenhuma corrida agendada</Text>
              <Text style={styles.emptyText}>Passageiros que agendarem corridas aparecerão aqui.</Text>
            </View>
          }
          renderSectionHeader={({ section }) => (
            <Text style={styles.sectionHeader}>{section.title}</Text>
          )}
          renderItem={({ item, section }) => (
            <ScheduledCard
              ride={item}
              type={section.type}
              claiming={claiming === item.id}
              onClaim={handleClaim}
              onStart={handleStartClaimed}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}

function ScheduledCard({
  ride, type, claiming, onClaim, onStart,
}: {
  ride: RideRecord;
  type: 'available' | 'claimed';
  claiming: boolean;
  onClaim: (r: RideRecord) => void;
  onStart: (r: RideRecord) => void;
}) {
  const when = ride.scheduled_for ? new Date(ride.scheduled_for) : null;
  const isDue = when ? when.getTime() <= Date.now() : false;

  return (
    <View style={[styles.card, type === 'claimed' && styles.cardClaimed]}>
      <View style={styles.cardTop}>
        <Text style={styles.cardDate}>{formatDate(ride.scheduled_for)}</Text>
        {type === 'claimed' ? (
          <View style={styles.confirmedBadge}><Text style={styles.confirmedText}>✓ Confirmada</Text></View>
        ) : isDue ? (
          <View style={styles.dueBadge}><Text style={styles.dueText}>No horário</Text></View>
        ) : (
          <View style={styles.availBadge}><Text style={styles.availText}>Disponível</Text></View>
        )}
      </View>

      <View style={styles.route}>
        <View style={styles.routeIcons}>
          <View style={styles.dotOrigin} />
          <View style={styles.routeLine} />
          <View style={styles.dotDest} />
        </View>
        <View style={styles.routeAddrs}>
          <Text style={styles.addr} numberOfLines={1}>{ride.origin_address}</Text>
          <Text style={[styles.addr, styles.addrDest]} numberOfLines={1}>{ride.destination_address}</Text>
        </View>
      </View>

      <View style={styles.meta}>
        <Text style={styles.metaText}>{formatDistance(ride.distance_km)} • {ride.duration_min} min</Text>
        <Text style={styles.metaPrice}>{formatCurrency(ride.price)}</Text>
      </View>

      {type === 'available' && (
        <TouchableOpacity
          style={[styles.claimBtn, claiming && { opacity: 0.7 }]}
          onPress={() => onClaim(ride)}
          disabled={claiming}
        >
          {claiming
            ? <ActivityIndicator size="small" color={Colors.primary} />
            : <Text style={styles.claimBtnText}>Confirmar esta corrida</Text>
          }
        </TouchableOpacity>
      )}

      {type === 'claimed' && isDue && (
        <TouchableOpacity style={styles.startBtn} onPress={() => onStart(ride)}>
          <Text style={styles.startBtnText}>Iniciar corrida agora</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

function formatDate(iso?: string): string {
  if (!iso) return 'Sem horário';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-US', { day: '2-digit', month: 'short' })} • ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.offWhite },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 },
  back: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backText: { fontSize: 24, color: Colors.primary },
  title: { fontSize: 22, fontWeight: '800', color: Colors.primary, marginLeft: 4 },
  list: { paddingHorizontal: 16, paddingBottom: 32, flexGrow: 1 },
  sectionHeader: { fontSize: 13, fontWeight: '700', color: Colors.gray[500], textTransform: 'uppercase', letterSpacing: 0.8, marginTop: 16, marginBottom: 8 },
  card: { backgroundColor: Colors.white, borderRadius: 16, padding: 16, marginBottom: 10 },
  cardClaimed: { borderLeftWidth: 4, borderLeftColor: Colors.success },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  cardDate: { fontSize: 15, fontWeight: '700', color: Colors.primary },
  confirmedBadge: { backgroundColor: 'rgba(34,197,94,0.12)', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  confirmedText: { color: Colors.success, fontSize: 11, fontWeight: '700' },
  dueBadge: { backgroundColor: 'rgba(201,168,76,0.18)', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  dueText: { color: Colors.accent, fontSize: 11, fontWeight: '700' },
  availBadge: { backgroundColor: Colors.gray[100], borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  availText: { color: Colors.gray[600], fontSize: 11, fontWeight: '700' },
  route: { flexDirection: 'row', marginBottom: 12 },
  routeIcons: { width: 16, alignItems: 'center', paddingTop: 4 },
  dotOrigin: { width: 9, height: 9, borderRadius: 5, backgroundColor: Colors.accent },
  routeLine: { flex: 1, width: 2, backgroundColor: Colors.gray[200], marginVertical: 3 },
  dotDest: { width: 9, height: 9, borderRadius: 2, backgroundColor: Colors.primary },
  routeAddrs: { flex: 1, marginLeft: 12 },
  addr: { fontSize: 14, color: Colors.gray[800], fontWeight: '500' },
  addrDest: { marginTop: 14 },
  meta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: Colors.gray[100],
    marginBottom: 14,
  },
  metaText: { fontSize: 13, color: Colors.gray[500] },
  metaPrice: { fontSize: 16, fontWeight: '800', color: Colors.primary },
  claimBtn: { backgroundColor: Colors.accent, borderRadius: 12, height: 46, alignItems: 'center', justifyContent: 'center' },
  claimBtnText: { color: Colors.primary, fontSize: 15, fontWeight: '800' },
  startBtn: { backgroundColor: Colors.primary, borderRadius: 12, height: 46, alignItems: 'center', justifyContent: 'center' },
  startBtnText: { color: Colors.white, fontSize: 15, fontWeight: '800' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  emptyEmoji: { fontSize: 48, marginBottom: 16 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: Colors.primary, marginBottom: 6 },
  emptyText: { fontSize: 14, color: Colors.gray[500], textAlign: 'center', paddingHorizontal: 32 },
});
