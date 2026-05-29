import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, SafeAreaView, TouchableOpacity, Platform, Alert } from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { RootStackParamList, Ride, RideStatus } from '../../types';
import { Colors } from '../../constants/colors';
import { Button } from '../../components/common/Button';
import { useDriverRide } from '../../hooks/useRide';
import { useAuth } from '../../hooks/useAuth';
import { useLocation } from '../../hooks/useLocation';
import { useRoute as useRideRoute } from '../../hooks/useRoute';
import { formatCurrency } from '../../lib/format';
import { supabase } from '../../lib/supabase';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'DriverNavigate'>;
  route: RouteProp<RootStackParamList, 'DriverNavigate'>;
};

type Phase = 'pickup' | 'dropoff';

export function DriverNavigateScreen({ navigation, route }: Props) {
  const { ride } = route.params;
  const { profile } = useAuth();
  const { location } = useLocation();
  const { updateRideStatus } = useDriverRide(profile?.id);
  const [phase, setPhase] = useState<Phase>('pickup');
  const [loading, setLoading] = useState(false);

  const origin = ride.origin ?? { lat: 28.5383, lng: -81.3792, address: 'Origem' };
  const dest = ride.destination ?? { lat: 28.4312, lng: -81.3081, address: 'Destino' };
  const target = phase === 'pickup' ? origin : dest;

  // Rota real (ruas) do motorista até o alvo (embarque ou destino)
  const { route: path } = useRideRoute(
    location ? { lat: location.lat, lng: location.lng } : null,
    { lat: target.lat, lng: target.lng }
  );

  // Detecta cancelamento pelo passageiro
  useEffect(() => {
    const channel = supabase
      .channel(`driver-ride-${ride.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rides', filter: `id=eq.${ride.id}` },
        (payload) => {
          if ((payload.new as Ride).status === 'cancelled') {
            Alert.alert('Corrida cancelada', 'O passageiro cancelou a corrida.');
            navigation.reset({ index: 0, routes: [{ name: 'DriverTabs' }] });
          }
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [ride.id]);

  function handleCancel() {
    Alert.alert('Cancelar corrida', 'Tem certeza? O passageiro será avisado.', [
      { text: 'Não', style: 'cancel' },
      {
        text: 'Sim, cancelar',
        style: 'destructive',
        onPress: async () => {
          await updateRideStatus(ride.id, 'cancelled' as RideStatus);
          navigation.reset({ index: 0, routes: [{ name: 'DriverTabs' }] });
        },
      },
    ]);
  }

  async function handleNextPhase() {
    setLoading(true);
    if (phase === 'pickup') {
      await updateRideStatus(ride.id, 'in_progress' as RideStatus);
      setPhase('dropoff');
    } else {
      await updateRideStatus(ride.id, 'completed' as RideStatus);
      Alert.alert('Corrida concluída!', `Valor: ${formatCurrency(ride.price)}`, [
        { text: 'OK', onPress: () => navigation.reset({ index: 0, routes: [{ name: 'DriverTabs' }] }) },
      ]);
    }
    setLoading(false);
  }

  const buttonLabel = phase === 'pickup' ? 'Passei buscar o passageiro' : 'Finalizar corrida';

  return (
    <View style={styles.container}>
      <MapView
        style={styles.map}
        provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined}
        initialRegion={{
          latitude: target.lat,
          longitude: target.lng,
          latitudeDelta: 0.02,
          longitudeDelta: 0.02,
        }}
      >
        {location && (
          <Marker coordinate={{ latitude: location.lat, longitude: location.lng }}>
            <View style={styles.driverMarker}>
              <Text style={{ fontSize: 20 }}>🚗</Text>
            </View>
          </Marker>
        )}
        <Marker coordinate={{ latitude: target.lat, longitude: target.lng }}>
          <View style={phase === 'pickup' ? styles.markerPickup : styles.markerDropoff} />
        </Marker>
        {location && (
          <Polyline
            coordinates={
              path?.coordinates ?? [
                { latitude: location.lat, longitude: location.lng },
                { latitude: target.lat, longitude: target.lng },
              ]
            }
            strokeColor={Colors.accent}
            strokeWidth={path ? 4 : 3}
            lineDashPattern={path ? undefined : [6, 3]}
          />
        )}
      </MapView>

      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <View style={styles.phaseBanner}>
          <View style={[styles.phaseIndicator, phase === 'dropoff' && styles.phaseIndicatorActive]} />
          <Text style={styles.phaseText}>
            {phase === 'pickup' ? 'Indo buscar o passageiro' : 'Levando ao destino'}
          </Text>
        </View>
      </SafeAreaView>

      <View style={styles.bottomSheet}>
        <View style={styles.handle} />

        <View style={styles.addressCard}>
          <Text style={styles.addressLabel}>{phase === 'pickup' ? 'Local de embarque' : 'Destino final'}</Text>
          <Text style={styles.addressText}>{target.address}</Text>
        </View>

        <View style={styles.passengerRow}>
          <View style={styles.passengerAvatar}>
            <Text style={styles.passengerAvatarText}>P</Text>
          </View>
          <View style={styles.passengerInfo}>
            <Text style={styles.passengerName}>Passageiro</Text>
            <View style={styles.ratingRow}>
              <Text style={styles.star}>★</Text>
              <Text style={styles.ratingText}>4.8</Text>
            </View>
          </View>
          <View style={styles.actions}>
            <TouchableOpacity style={styles.actionBtn}>
              <Text>📞</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.actionBtn}
              onPress={() => navigation.navigate('Chat', { rideId: ride.id, title: 'Passageiro' })}
            >
              <Text>💬</Text>
            </TouchableOpacity>
          </View>
        </View>

        <Button
          title={buttonLabel}
          onPress={handleNextPhase}
          loading={loading}
          style={styles.btn}
        />
        {phase === 'pickup' && (
          <TouchableOpacity style={styles.cancelBtn} onPress={handleCancel}>
            <Text style={styles.cancelBtnText}>Cancelar corrida</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0 },
  phaseBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    margin: 16,
    backgroundColor: Colors.primary,
    borderRadius: 12,
    padding: 14,
  },
  phaseIndicator: { width: 8, height: 8, borderRadius: 4, backgroundColor: Colors.accent, marginRight: 10 },
  phaseIndicatorActive: { backgroundColor: Colors.success },
  phaseText: { color: Colors.white, fontSize: 14, fontWeight: '600' },
  bottomSheet: {
    backgroundColor: Colors.white,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 8,
    paddingHorizontal: 20,
    paddingBottom: 32,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.1,
    shadowRadius: 16,
  },
  handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: Colors.gray[300], alignSelf: 'center', marginBottom: 16 },
  addressCard: {
    backgroundColor: Colors.gray[100],
    borderRadius: 12,
    padding: 14,
    marginBottom: 16,
  },
  addressLabel: { fontSize: 11, color: Colors.gray[400], textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 },
  addressText: { fontSize: 15, color: Colors.primary, fontWeight: '600' },
  passengerRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  passengerAvatar: { width: 46, height: 46, borderRadius: 23, backgroundColor: Colors.gray[200], alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  passengerAvatarText: { fontSize: 18, fontWeight: '700', color: Colors.gray[600] },
  passengerInfo: { flex: 1 },
  passengerName: { fontSize: 15, fontWeight: '600', color: Colors.primary },
  ratingRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  star: { color: Colors.accent, fontSize: 13, marginRight: 2 },
  ratingText: { fontSize: 12, color: Colors.gray[500] },
  actions: { flexDirection: 'row', gap: 8 },
  actionBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: Colors.gray[100], alignItems: 'center', justifyContent: 'center' },
  btn: {},
  cancelBtn: { marginTop: 12, alignItems: 'center', paddingVertical: 10 },
  cancelBtnText: { color: Colors.error, fontSize: 15, fontWeight: '700' },
  driverMarker: { width: 36, height: 36, borderRadius: 18, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center' },
  markerPickup: { width: 14, height: 14, borderRadius: 7, backgroundColor: Colors.accent, borderWidth: 2, borderColor: Colors.white },
  markerDropoff: { width: 14, height: 14, borderRadius: 3, backgroundColor: Colors.primary, borderWidth: 2, borderColor: Colors.white },
});
