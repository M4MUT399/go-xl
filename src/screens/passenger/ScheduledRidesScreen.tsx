import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, FlatList, TouchableOpacity,
  ActivityIndicator, RefreshControl, Alert,
} from 'react-native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { RootStackParamList, RideRecord, Ride } from '../../types';
import { Colors } from '../../constants/colors';
import { useAuth } from '../../hooks/useAuth';
import { useScheduledRides } from '../../hooks/useRide';
import { formatCurrency, formatDistance } from '../../lib/format';
import { supabase } from '../../lib/supabase';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'ScheduledRides'> };

interface DriverInfo {
  name: string;
  vehicle?: string;
  plate?: string;
}

export function ScheduledRidesScreen({ navigation }: Props) {
  const { profile } = useAuth();
  const { rides, loading, refresh, activate, cancel } = useScheduledRides(profile?.id);
  const [driverInfoMap, setDriverInfoMap] = useState<Record<string, DriverInfo>>({});

  useFocusEffect(
    React.useCallback(() => { refresh(); }, [refresh])
  );

  // Busca informações do motorista para corridas já confirmadas
  useEffect(() => {
    const withDriver = rides.filter((r) => r.driver_id);
    if (withDriver.length === 0) return;

    withDriver.forEach(async (ride) => {
      if (!ride.driver_id || driverInfoMap[ride.driver_id]) return;
      const [{ data: p }, { data: v }] = await Promise.all([
        supabase.from('profiles').select('full_name').eq('id', ride.driver_id).single(),
        supabase.from('vehicles').select('model,plate,color').eq('driver_id', ride.driver_id).single(),
      ]);
      const info: DriverInfo = {
        name: (p as { full_name: string } | null)?.full_name ?? 'Motorista',
        vehicle: v ? `${(v as { model: string; color: string }).model} · ${(v as { color: string }).color}` : undefined,
        plate: (v as { plate: string } | null)?.plate,
      };
      setDriverInfoMap((prev) => ({ ...prev, [ride.driver_id!]: info }));
    });
  }, [rides]);

  // Realtime: detecta quando um motorista confirma uma corrida agendada
  useEffect(() => {
    if (!profile?.id) return;
    const channel = supabase
      .channel(`pax-sched-${profile.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rides', filter: `passenger_id=eq.${profile.id}` },
        (payload) => {
          const updated = payload.new as RideRecord;
          if (updated.status === 'scheduled' && updated.driver_id) {
            refresh();
          }
          // Motorista iniciou a corrida (activated → accepted)
          if (updated.status === 'accepted' && updated.driver_id) {
            refresh();
          }
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [profile?.id, refresh]);

  async function handleActivate(ride: RideRecord) {
    const activated = await activate(ride.id);
    if (!activated) {
      Alert.alert('Ops', 'Não foi possível iniciar a corrida. Tente novamente.');
      return;
    }
    if ((activated as Ride).driver_id) {
      // Motorista já confirmado → vai direto para corrida ativa
      navigation.navigate('ActiveRide', { ride: activated as Ride });
    } else {
      navigation.navigate('FindingDriver', { ride: activated as Ride });
    }
  }

  function handleCancel(ride: RideRecord) {
    Alert.alert('Cancelar agendamento', 'Deseja remover esta corrida agendada?', [
      { text: 'Não', style: 'cancel' },
      { text: 'Sim, cancelar', style: 'destructive', onPress: () => cancel(ride.id) },
    ]);
  }

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.back}>
          <Text style={styles.backText}>←</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Corridas agendadas</Text>
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
              <Text style={styles.emptyEmoji}>🗓️</Text>
              <Text style={styles.emptyTitle}>Nenhuma corrida agendada</Text>
              <Text style={styles.emptyText}>Agende uma corrida ao escolher o destino na tela inicial.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <ScheduledCard
              ride={item}
              driverInfo={item.driver_id ? driverInfoMap[item.driver_id] : undefined}
              onActivate={handleActivate}
              onCancel={handleCancel}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}

function ScheduledCard({
  ride, driverInfo, onActivate, onCancel,
}: {
  ride: RideRecord;
  driverInfo?: DriverInfo;
  onActivate: (r: RideRecord) => void;
  onCancel: (r: RideRecord) => void;
}) {
  const when = ride.scheduled_for ? new Date(ride.scheduled_for) : null;
  const isDue = when ? when.getTime() <= Date.now() : false;
  const hasDriver = !!ride.driver_id;

  return (
    <View style={[styles.card, hasDriver && styles.cardConfirmed]}>
      <View style={styles.cardTop}>
        <Text style={styles.cardDate}>
          {when
            ? `${when.toLocaleDateString('en-US', { day: '2-digit', month: 'short' })} • ${when.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
            : 'Sem horário'}
        </Text>
        {hasDriver ? (
          <View style={styles.confirmedBadge}><Text style={styles.confirmedText}>✓ Motorista confirmado</Text></View>
        ) : isDue ? (
          <View style={styles.dueBadge}><Text style={styles.dueText}>No horário</Text></View>
        ) : (
          <View style={styles.schBadge}><Text style={styles.schText}>Aguardando motorista</Text></View>
        )}
      </View>

      <View style={styles.route}>
        <View style={styles.routeIcons}>
          <View style={styles.dotOrigin} />
          <View style={styles.routeLine} />
          <View style={styles.dotDest} />
        </View>
        <View style={styles.routeText}>
          <Text style={styles.addr} numberOfLines={1}>{ride.origin_address}</Text>
          <Text style={[styles.addr, { marginTop: 14 }]} numberOfLines={1}>{ride.destination_address}</Text>
        </View>
      </View>

      {/* Card do motorista pré-confirmado */}
      {hasDriver && (
        <View style={styles.driverCard}>
          <View style={styles.driverAvatar}>
            <Text style={styles.driverAvatarText}>{(driverInfo?.name ?? 'M')[0]}</Text>
          </View>
          <View style={styles.driverInfo}>
            <Text style={styles.driverName}>{driverInfo?.name ?? 'Carregando...'}</Text>
            {driverInfo?.vehicle && (
              <Text style={styles.driverVehicle}>{driverInfo.vehicle}</Text>
            )}
          </View>
          {driverInfo?.plate && (
            <View style={styles.plateBox}>
              <Text style={styles.plateText}>{driverInfo.plate}</Text>
            </View>
          )}
        </View>
      )}

      <View style={styles.cardMeta}>
        <Text style={styles.metaText}>{formatDistance(ride.distance_km)}</Text>
        <Text style={styles.metaPrice}>{formatCurrency(ride.price)}</Text>
      </View>

      <View style={styles.cardActions}>
        <TouchableOpacity style={styles.cancelBtn} onPress={() => onCancel(ride)}>
          <Text style={styles.cancelBtnText}>Cancelar</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.activateBtn} onPress={() => onActivate(ride)}>
          <Text style={styles.activateBtnText}>
            {hasDriver ? 'Iniciar corrida' : 'Solicitar agora'}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Colors.offWhite },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 12 },
  back: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  backText: { fontSize: 24, color: Colors.primary },
  title: { fontSize: 22, fontWeight: '800', color: Colors.primary, marginLeft: 4 },
  list: { paddingHorizontal: 16, paddingBottom: 24, flexGrow: 1 },
  card: { backgroundColor: Colors.white, borderRadius: 16, padding: 16, marginBottom: 12 },
  cardConfirmed: { borderLeftWidth: 4, borderLeftColor: Colors.success },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  cardDate: { fontSize: 15, fontWeight: '700', color: Colors.primary },
  schBadge: { backgroundColor: Colors.gray[100], borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  schText: { color: Colors.gray[600], fontSize: 11, fontWeight: '700' },
  confirmedBadge: { backgroundColor: 'rgba(34,197,94,0.12)', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  confirmedText: { color: Colors.success, fontSize: 11, fontWeight: '700' },
  dueBadge: { backgroundColor: 'rgba(201,168,76,0.15)', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  dueText: { color: Colors.accent, fontSize: 11, fontWeight: '700' },
  route: { flexDirection: 'row', marginBottom: 12 },
  routeIcons: { width: 16, alignItems: 'center', paddingTop: 4 },
  dotOrigin: { width: 9, height: 9, borderRadius: 5, backgroundColor: Colors.accent },
  routeLine: { flex: 1, width: 2, backgroundColor: Colors.gray[200], marginVertical: 3 },
  dotDest: { width: 9, height: 9, borderRadius: 2, backgroundColor: Colors.primary },
  routeText: { flex: 1, marginLeft: 12 },
  addr: { fontSize: 14, color: Colors.gray[800], fontWeight: '500' },
  driverCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.gray[100],
    borderRadius: 12,
    padding: 12,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(34,197,94,0.2)',
  },
  driverAvatar: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: Colors.primary,
    alignItems: 'center', justifyContent: 'center',
    marginRight: 12,
  },
  driverAvatarText: { color: Colors.accent, fontSize: 18, fontWeight: '800' },
  driverInfo: { flex: 1 },
  driverName: { fontSize: 15, fontWeight: '700', color: Colors.primary },
  driverVehicle: { fontSize: 12, color: Colors.gray[500], marginTop: 2 },
  plateBox: {
    backgroundColor: Colors.primary, borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 5,
  },
  plateText: { color: Colors.white, fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  cardMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: Colors.gray[100],
    marginBottom: 14,
  },
  metaText: { fontSize: 13, color: Colors.gray[500] },
  metaPrice: { fontSize: 16, fontWeight: '800', color: Colors.primary },
  cardActions: { flexDirection: 'row', gap: 10 },
  cancelBtn: { flex: 1, height: 44, borderRadius: 12, borderWidth: 1.5, borderColor: Colors.gray[200], alignItems: 'center', justifyContent: 'center' },
  cancelBtnText: { color: Colors.gray[600], fontSize: 14, fontWeight: '700' },
  activateBtn: { flex: 2, height: 44, borderRadius: 12, backgroundColor: Colors.accent, alignItems: 'center', justifyContent: 'center' },
  activateBtnText: { color: Colors.primary, fontSize: 14, fontWeight: '800' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  emptyEmoji: { fontSize: 48, marginBottom: 16 },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: Colors.primary, marginBottom: 6 },
  emptyText: { fontSize: 14, color: Colors.gray[500], textAlign: 'center', paddingHorizontal: 32 },
});
