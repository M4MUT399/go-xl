import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, SafeAreaView, TouchableOpacity, Switch, Platform, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../types';
import { Colors } from '../../constants/colors';
import { useAuth } from '../../hooks/useAuth';
import { useLocation } from '../../hooks/useLocation';
import { useDriverRide } from '../../hooks/useRide';
import { formatCurrency, formatDistance } from '../../lib/format';
import { rideOrigin, rideDestination } from '../../lib/ride';
import { supabase } from '../../lib/supabase';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'DriverTabs'> };

export function DriverHomeScreen({ navigation }: Props) {
  const { profile } = useAuth();
  const [isOnline, setIsOnline] = useState(false);
  // watch: true → posição contínua enquanto online (banco atualiza a cada ≥15 m)
  const { location } = useLocation({ watch: isOnline });
  const { pendingRide, pendingScheduledRide, setPendingRide, setPendingScheduledRide, acceptRide, confirmScheduledRide } = useDriverRide(profile?.id);
  // true após carregar o valor persistido — evita gravar is_online=false no banco antes de ler o AsyncStorage
  const [onlineLoaded, setOnlineLoaded] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Carrega o status online salvo ao montar (persiste entre sessões)
  useEffect(() => {
    AsyncStorage.getItem('driver_is_online').then((val) => {
      if (val === 'true') setIsOnline(true);
      setOnlineLoaded(true);
    });
  }, []);

  // Sincroniza localização + status online no banco (só após carregar o valor persistido)
  useEffect(() => {
    if (!location || !profile?.id || !onlineLoaded) return;
    supabase.from('driver_locations').upsert({
      driver_id: profile.id,
      lat: location.lat,
      lng: location.lng,
      is_online: isOnline,
      updated_at: new Date().toISOString(),
    });
  }, [location, isOnline, profile?.id, onlineLoaded]);

  // Alterna online/offline e persiste a escolha
  function handleOnlineChange(val: boolean) {
    setIsOnline(val);
    AsyncStorage.setItem('driver_is_online', val ? 'true' : 'false');
  }

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

  async function handleConfirmScheduled() {
    if (!pendingScheduledRide) return;
    setConfirming(true);
    const ok = await confirmScheduledRide(pendingScheduledRide.id);
    setConfirming(false);
    if (ok) {
      Alert.alert('✅ Corrida confirmada!', 'O passageiro foi notificado que você irá buscá-lo.');
    } else {
      Alert.alert('Ops', 'Essa corrida já foi confirmada por outro motorista.');
      setPendingScheduledRide(null);
    }
  }

  const firstName = profile?.full_name?.split(' ')[0] ?? 'Motorista';

  return (
    <View style={styles.container}>
      <MapView
        style={styles.map}
        provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined}
        initialRegion={{
          latitude: location?.lat ?? 28.5383,
          longitude: location?.lng ?? -81.3792,
          latitudeDelta: 0.015,
          longitudeDelta: 0.015,
        }}
        showsUserLocation
        customMapStyle={darkMapStyle}
      />

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
              onValueChange={handleOnlineChange}
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

      {pendingScheduledRide && !pendingRide && (
        <View style={styles.rideRequestSheet}>
          <View style={styles.requestHandle} />

          <View style={styles.scheduledHeader}>
            <Text style={styles.scheduledIcon}>🗓️</Text>
            <View>
              <Text style={styles.requestTitle}>Corrida agendada!</Text>
              {pendingScheduledRide.scheduled_for && (
                <Text style={styles.scheduledWhen}>
                  {new Date(pendingScheduledRide.scheduled_for).toLocaleDateString('en-US', { day: '2-digit', month: 'short' })}
                  {' às '}
                  {new Date(pendingScheduledRide.scheduled_for).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                </Text>
              )}
            </View>
          </View>

          <View style={styles.requestDetails}>
            <View style={styles.requestRow}>
              <Text style={styles.requestIcon}>📍</Text>
              <View>
                <Text style={styles.requestLabel}>Origem</Text>
                <Text style={styles.requestAddr} numberOfLines={1}>{rideOrigin(pendingScheduledRide).address}</Text>
              </View>
            </View>
            <View style={styles.requestDivider} />
            <View style={styles.requestRow}>
              <Text style={styles.requestIcon}>🏁</Text>
              <View>
                <Text style={styles.requestLabel}>Destino</Text>
                <Text style={styles.requestAddr} numberOfLines={1}>{rideDestination(pendingScheduledRide).address}</Text>
              </View>
            </View>
          </View>

          <View style={styles.requestMeta}>
            <View style={styles.metaItem}>
              <Text style={styles.metaValue}>{formatDistance(pendingScheduledRide.distance_km)}</Text>
              <Text style={styles.metaLabel}>Distância</Text>
            </View>
            <View style={styles.metaDivider} />
            <View style={styles.metaItem}>
              <Text style={styles.metaValue}>{pendingScheduledRide.duration_min} min</Text>
              <Text style={styles.metaLabel}>Duração est.</Text>
            </View>
            <View style={styles.metaDivider} />
            <View style={styles.metaItem}>
              <Text style={[styles.metaValue, styles.priceValue]}>{formatCurrency(pendingScheduledRide.price)}</Text>
              <Text style={styles.metaLabel}>Valor</Text>
            </View>
          </View>

          <View style={styles.requestActions}>
            <TouchableOpacity
              style={styles.declineBtn}
              onPress={() => setPendingScheduledRide(null)}
            >
              <Text style={styles.declineText}>Recusar</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.acceptBtn, confirming && { opacity: 0.7 }]}
              onPress={handleConfirmScheduled}
              disabled={confirming}
            >
              <Text style={styles.acceptText}>{confirming ? 'Confirmando...' : 'Confirmar'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {pendingRide && (isOnline || !!pendingRide.driver_id) && (
        <View style={styles.rideRequestSheet}>
          <View style={styles.requestHandle} />
          {pendingRide.driver_id ? (
            <View style={styles.qrRideBadge}>
              <Text style={styles.qrRideBadgeText}>📲 Corrida via QR Code — reservada para você</Text>
            </View>
          ) : null}
          <Text style={styles.requestTitle}>Nova corrida!</Text>

          <View style={styles.requestDetails}>
            <View style={styles.requestRow}>
              <Text style={styles.requestIcon}>📍</Text>
              <View>
                <Text style={styles.requestLabel}>Origem</Text>
                <Text style={styles.requestAddr} numberOfLines={1}>{rideOrigin(pendingRide).address}</Text>
              </View>
            </View>
            <View style={styles.requestDivider} />
            <View style={styles.requestRow}>
              <Text style={styles.requestIcon}>🏁</Text>
              <View>
                <Text style={styles.requestLabel}>Destino</Text>
                <Text style={styles.requestAddr} numberOfLines={1}>{rideDestination(pendingRide).address}</Text>
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
  scheduledBtn: {
    marginHorizontal: 16,
    marginTop: 10,
    backgroundColor: 'rgba(201,168,76,0.15)',
    borderRadius: 12,
    padding: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(201,168,76,0.4)',
  },
  scheduledBtnText: { color: Colors.accent, fontSize: 14, fontWeight: '700' },
  rideRequestSheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
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
  qrRideBadge: {
    backgroundColor: 'rgba(201,168,76,0.15)',
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: 'rgba(201,168,76,0.4)',
  },
  qrRideBadgeText: { color: Colors.accent, fontSize: 13, fontWeight: '700', textAlign: 'center' },
  scheduledHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  scheduledIcon: { fontSize: 32 },
  scheduledWhen: { fontSize: 14, color: Colors.accent, fontWeight: '700', marginTop: 2 },
  requestTitle: { fontSize: 22, fontWeight: '800', color: Colors.primary },
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
