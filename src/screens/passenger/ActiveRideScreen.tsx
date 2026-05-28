import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity, Platform,
} from 'react-native';
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { RootStackParamList, Ride, RideStatus } from '../../types';
import { Colors } from '../../constants/colors';
import { supabase } from '../../lib/supabase';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'ActiveRide'>;
  route: RouteProp<RootStackParamList, 'ActiveRide'>;
};

const STATUS_LABELS: Record<RideStatus, string> = {
  requesting: 'Procurando motorista...',
  accepted: 'Motorista confirmado!',
  driver_en_route: 'Motorista a caminho',
  in_progress: 'Corrida em andamento',
  completed: 'Corrida concluída!',
  cancelled: 'Corrida cancelada',
};

export function ActiveRideScreen({ navigation, route }: Props) {
  const [ride, setRide] = useState<Ride>(route.params.ride);
  const [driverName, setDriverName] = useState('Motorista');

  useEffect(() => {
    if (ride.driver_id) {
      supabase
        .from('profiles')
        .select('full_name')
        .eq('id', ride.driver_id)
        .single()
        .then(({ data }) => {
          if (data) setDriverName(data.full_name);
        });
    }
  }, [ride.driver_id]);

  useEffect(() => {
    const channel = supabase
      .channel(`active-ride-${ride.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rides', filter: `id=eq.${ride.id}` },
        (payload) => {
          const updated = payload.new as Ride;
          setRide(updated);
          if (updated.status === 'completed') {
            navigation.replace('RateRide', { ride: updated });
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [ride.id]);

  const origin = ride.origin ?? { lat: -27.5969, lng: -48.5495 };
  const dest = ride.destination ?? { lat: -27.6697, lng: -48.5487 };

  return (
    <View style={styles.container}>
      <MapView
        style={styles.map}
        provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined}
        initialRegion={{
          latitude: (origin.lat + dest.lat) / 2,
          longitude: (origin.lng + dest.lng) / 2,
          latitudeDelta: Math.abs(origin.lat - dest.lat) * 2 + 0.02,
          longitudeDelta: Math.abs(origin.lng - dest.lng) * 2 + 0.02,
        }}
      >
        <Marker coordinate={{ latitude: origin.lat, longitude: origin.lng }}>
          <View style={styles.markerOrigin} />
        </Marker>
        <Marker coordinate={{ latitude: dest.lat, longitude: dest.lng }}>
          <View style={styles.markerDest} />
        </Marker>
      </MapView>

      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <View style={styles.statusBanner}>
          <View style={styles.statusDot} />
          <Text style={styles.statusText}>{STATUS_LABELS[ride.status]}</Text>
        </View>
      </SafeAreaView>

      <View style={styles.bottomSheet}>
        <View style={styles.handle} />

        <View style={styles.driverCard}>
          <View style={styles.driverAvatar}>
            <Text style={styles.driverAvatarText}>{driverName[0]}</Text>
          </View>
          <View style={styles.driverInfo}>
            <Text style={styles.driverName}>{driverName}</Text>
            <Text style={styles.driverCategory}>Executive XL</Text>
            <View style={styles.ratingRow}>
              <Text style={styles.star}>★</Text>
              <Text style={styles.ratingText}>4.9</Text>
            </View>
          </View>
          <View style={styles.driverActions}>
            <TouchableOpacity style={styles.actionBtn}>
              <Text style={styles.actionIcon}>📞</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.actionBtn}>
              <Text style={styles.actionIcon}>💬</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.tripDetails}>
          <View style={styles.detailRow}>
            <Text style={styles.detailIcon}>🏁</Text>
            <Text style={styles.detailText} numberOfLines={1}>{dest.address}</Text>
          </View>
          <View style={styles.detailDivider} />
          <View style={styles.detailRow}>
            <Text style={styles.detailIcon}>💰</Text>
            <Text style={styles.detailText}>R$ {Number(ride.price).toFixed(2)}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0 },
  statusBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: 16,
    backgroundColor: Colors.primary,
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  statusDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.success, marginRight: 10 },
  statusText: { color: Colors.white, fontSize: 15, fontWeight: '600' },
  bottomSheet: {
    backgroundColor: Colors.white,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 8,
    paddingBottom: 32,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.1,
    shadowRadius: 16,
  },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: Colors.gray[300], alignSelf: 'center', marginBottom: 20 },
  driverCard: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, marginBottom: 20 },
  driverAvatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
  },
  driverAvatarText: { color: Colors.accent, fontSize: 22, fontWeight: '800' },
  driverInfo: { flex: 1 },
  driverName: { fontSize: 17, fontWeight: '700', color: Colors.primary },
  driverCategory: { fontSize: 12, color: Colors.gray[500], marginTop: 2 },
  ratingRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  star: { color: Colors.accent, fontSize: 14, marginRight: 3 },
  ratingText: { fontSize: 13, fontWeight: '600', color: Colors.gray[600] },
  driverActions: { flexDirection: 'row', gap: 8 },
  actionBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: Colors.gray[100],
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionIcon: { fontSize: 18 },
  tripDetails: {
    marginHorizontal: 20,
    backgroundColor: Colors.gray[100],
    borderRadius: 14,
    padding: 16,
  },
  detailRow: { flexDirection: 'row', alignItems: 'center' },
  detailIcon: { fontSize: 16, marginRight: 10 },
  detailText: { flex: 1, fontSize: 14, color: Colors.gray[700] },
  detailDivider: { height: 1, backgroundColor: Colors.gray[200], marginVertical: 10, marginLeft: 26 },
  markerOrigin: { width: 12, height: 12, borderRadius: 6, backgroundColor: Colors.accent, borderWidth: 2, borderColor: Colors.white },
  markerDest: { width: 12, height: 12, borderRadius: 2, backgroundColor: Colors.primary, borderWidth: 2, borderColor: Colors.white },
});
