import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, SafeAreaView, TouchableOpacity, Switch, Platform, Alert } from 'react-native';
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../types';
import { Colors } from '../../constants/colors';
import { useAuth } from '../../hooks/useAuth';
import { useLocation } from '../../hooks/useLocation';
import { useDriverRide } from '../../hooks/useRide';
import { formatCurrency, formatDistance } from '../../lib/format';
import { supabase } from '../../lib/supabase';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'DriverTabs'> };

export function DriverHomeScreen({ navigation }: Props) {
  const { profile } = useAuth();
  const { location } = useLocation();
  const { pendingRide, setPendingRide, acceptRide } = useDriverRide(profile?.id);
  const [isOnline, setIsOnline] = useState(false);
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    if (!location || !profile?.id) return;
    supabase.from('driver_locations').upsert({
      driver_id: profile.id,
      lat: location.lat,
      lng: location.lng,
      is_online: isOnline,
      updated_at: new Date().toISOString(),
    });
  }, [location, isOnline, profile?.id]);

  async function handleAccept() {
    if (!pendingRide) return;
    setAccepting(true);
    const ride = await acceptRide(pendingRide.id);
    setAccepting(false);
    if (ride) {
      navigation.navigate('DriverNavigate', { ride });
    } else {
      Alert.alert('Ops', 'Corrida já foi aceita por outro motorista.');
      setPendingRide(null);
    }
  }

  const firstName = profile?.full_name?.split(' ')[0] ?? 'Motorista';

  return (
    <View style={styles.container}>
      {location ? (
        <MapView
          style={styles.map}
          provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined}
          initialRegion={{
            latitude: location.lat,
            longitude: location.lng,
            latitudeDelta: 0.015,
            longitudeDelta: 0.015,
          }}
          showsUserLocation
          customMapStyle={darkMapStyle}
        />
      ) : (
        <View style={[styles.map, { backgroundColor: Colors.primaryLight }]} />
      )}

      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <View style={styles.topBar}>
          <View>
            <Text style={styles.greeting}>Olá, {firstName}</Text>
            <Text style={styles.role}>Motorista Executive XL</Text>
          </View>
          <View style={styles.onlineToggle}>
            <Text style={[styles.onlineLabel, isOnline && styles.onlineLabelActive]}>
              {isOnline ? 'Online' : 'Offline'}
            </Text>
            <Switch
              value={isOnline}
              onValueChange={setIsOnline}
              trackColor={{ false: Colors.gray[400], true: Colors.success }}
              thumbColor={Colors.white}
            />
          </View>
        </View>

        {!isOnline && (
          <View style={styles.offlineBanner}>
            <Text style={styles.offlineBannerText}>
              Ative o modo Online para receber corridas
            </Text>
          </View>
        )}
      </SafeAreaView>

      {pendingRide && isOnline && (
        <View style={styles.rideRequestSheet}>
          <View style={styles.requestHandle} />
          <Text style={styles.requestTitle}>Nova corrida!</Text>

          <View style={styles.requestDetails}>
            <View style={styles.requestRow}>
              <Text style={styles.requestIcon}>📍</Text>
              <View>
                <Text style={styles.requestLabel}>Origem</Text>
                <Text style={styles.requestAddr} numberOfLines={1}>{pendingRide.origin?.address ?? '—'}</Text>
              </View>
            </View>
            <View style={styles.requestDivider} />
            <View style={styles.requestRow}>
              <Text style={styles.requestIcon}>🏁</Text>
              <View>
                <Text style={styles.requestLabel}>Destino</Text>
                <Text style={styles.requestAddr} numberOfLines={1}>{pendingRide.destination?.address ?? '—'}</Text>
              </View>
            </View>
          </View>

          <View style={styles.requestMeta}>
            <View style={styles.metaItem}>
              <Text style={styles.metaValue}>{formatDistance(pendingRide.distance_km)}</Text>
              <Text style={styles.metaLabel}>Distância</Text>
            </View>
            <View style={styles.metaDivider} />
            <View style={styles.metaItem}>
              <Text style={styles.metaValue}>{pendingRide.duration_min} min</Text>
              <Text style={styles.metaLabel}>Duração est.</Text>
            </View>
            <View style={styles.metaDivider} />
            <View style={styles.metaItem}>
              <Text style={[styles.metaValue, styles.priceValue]}>{formatCurrency(pendingRide.price)}</Text>
              <Text style={styles.metaLabel}>Valor</Text>
            </View>
          </View>

          <View style={styles.requestActions}>
            <TouchableOpacity
              style={styles.declineBtn}
              onPress={() => setPendingRide(null)}
            >
              <Text style={styles.declineText}>Recusar</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.acceptBtn, accepting && { opacity: 0.7 }]}
              onPress={handleAccept}
              disabled={accepting}
            >
              <Text style={styles.acceptText}>{accepting ? 'Aceitando...' : 'Aceitar'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
    </View>
  );
}

const darkMapStyle = [
  { elementType: 'geometry', stylers: [{ color: '#1a1a2e' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8ec3b9' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#16213e' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0d1b2a' }] },
];

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  overlay: { position: 'absolute', top: 0, left: 0, right: 0 },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    margin: 16,
    backgroundColor: Colors.primary,
    borderRadius: 16,
    padding: 16,
  },
  greeting: { fontSize: 17, fontWeight: '700', color: Colors.white },
  role: { fontSize: 12, color: Colors.accent, marginTop: 2 },
  onlineToggle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  onlineLabel: { fontSize: 13, color: Colors.gray[400], fontWeight: '600' },
  onlineLabelActive: { color: Colors.success },
  offlineBanner: {
    marginHorizontal: 16,
    backgroundColor: 'rgba(26,26,46,0.9)',
    borderRadius: 12,
    padding: 12,
    alignItems: 'center',
  },
  offlineBannerText: { color: Colors.gray[300], fontSize: 13, textAlign: 'center' },
  rideRequestSheet: {
    backgroundColor: Colors.white,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingTop: 8,
    paddingHorizontal: 20,
    paddingBottom: 32,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -6 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
  },
  requestHandle: { width: 36, height: 4, borderRadius: 2, backgroundColor: Colors.gray[300], alignSelf: 'center', marginBottom: 16 },
  requestTitle: { fontSize: 22, fontWeight: '800', color: Colors.primary, marginBottom: 16 },
  requestDetails: { backgroundColor: Colors.gray[100], borderRadius: 14, padding: 14, marginBottom: 16 },
  requestRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
  requestIcon: { fontSize: 18, marginRight: 12 },
  requestLabel: { fontSize: 11, color: Colors.gray[400], textTransform: 'uppercase', letterSpacing: 0.5 },
  requestAddr: { fontSize: 14, color: Colors.gray[800], fontWeight: '500', maxWidth: 240 },
  requestDivider: { height: 1, backgroundColor: Colors.gray[200], marginVertical: 8, marginLeft: 30 },
  requestMeta: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
  metaItem: { flex: 1, alignItems: 'center' },
  metaValue: { fontSize: 18, fontWeight: '800', color: Colors.primary },
  priceValue: { color: Colors.accent },
  metaLabel: { fontSize: 11, color: Colors.gray[400], marginTop: 2 },
  metaDivider: { width: 1, height: 32, backgroundColor: Colors.gray[200] },
  requestActions: { flexDirection: 'row', gap: 12 },
  declineBtn: {
    flex: 1,
    height: 54,
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: Colors.gray[300],
    alignItems: 'center',
    justifyContent: 'center',
  },
  declineText: { color: Colors.gray[600], fontSize: 16, fontWeight: '600' },
  acceptBtn: {
    flex: 2,
    height: 54,
    borderRadius: 12,
    backgroundColor: Colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  acceptText: { color: Colors.primary, fontSize: 16, fontWeight: '800' },
});
