import React, { useEffect, useState, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Platform, Alert, ScrollView,
} from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useIsFocused } from '@react-navigation/native';
import { RootStackParamList, Ride, RideStatus } from '../../types';
import { Colors } from '../../constants/colors';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../hooks/useAuth';
import { usePassengerRide } from '../../hooks/useRide';
import { useDriverVehicle } from '../../hooks/useVehicle';
import { useRoute as useRideRoute } from '../../hooks/useRoute';
import { useChatAlert } from '../../hooks/useChatAlert';
import { KM_TO_MILES } from '../../lib/format';
import { CarMarker } from '../../components/common/CarMarker';
import { rideOrigin, rideDestination } from '../../lib/ride';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'ActiveRide'>;
  route: RouteProp<RootStackParamList, 'ActiveRide'>;
};

const STATUS_LABELS: Record<RideStatus, string> = {
  scheduled: 'Aguardando confirmação do motorista',
  requesting: 'Procurando motorista...',
  accepted: 'Motorista confirmado!',
  driver_en_route: 'Motorista a caminho',
  in_progress: 'Corrida em andamento',
  completed: 'Corrida concluída!',
  cancelled: 'Corrida cancelada',
};

export function ActiveRideScreen({ navigation, route }: Props) {
  const { profile } = useAuth();
  const { cancelRide } = usePassengerRide(profile?.id);
  const isFocused = useIsFocused();
  const [ride, setRide] = useState<Ride>(route.params.ride);
  const [driverLoc, setDriverLoc] = useState<{ lat: number; lng: number; heading?: number } | null>(null);
  // Controla o snapshot do marcador customizado: precisa ficar `true` por um
  // instante a cada atualização para o ícone do carro realmente pintar no iOS.
  const [tracksCar, setTracksCar] = useState(true);
  const mapRef = useRef<MapView>(null);

  useChatAlert(ride.id, profile?.id, isFocused, 'Motorista');
  const [driverName, setDriverName] = useState('Motorista');
  const vehicle = useDriverVehicle(ride.driver_id);

  const canCancel = ride.status === 'accepted' || ride.status === 'driver_en_route';

  function handleCancel() {
    Alert.alert('Cancelar corrida', 'Tem certeza que deseja cancelar? O motorista será avisado.', [
      { text: 'Não', style: 'cancel' },
      {
        text: 'Sim, cancelar',
        style: 'destructive',
        onPress: async () => {
          await cancelRide(ride.id);
          navigation.reset({ index: 0, routes: [{ name: 'PassengerTabs' }] });
        },
      },
    ]);
  }

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

  // Telemetria do motorista vem gravada na PRÓPRIA corrida (rides.driver_lat/lng
  // + driver_eta_min/km), que o passageiro sempre consegue ler via RLS. Isso
  // garante posição e ETA idênticos aos do motorista, sem depender de
  // driver_locations (que pode ser bloqueado por RLS/realtime no Expo Go).
  useEffect(() => {
    if (ride.driver_lat != null && ride.driver_lng != null) {
      setDriverLoc({ lat: ride.driver_lat, lng: ride.driver_lng });
    }
  }, [ride.driver_lat, ride.driver_lng]);

  // Polling da linha da corrida (realtime é instável no Expo Go) → mantém a
  // telemetria do motorista sempre fresca para o passageiro.
  // IMPORTANTE: lemos a TABELA `rides` diretamente, NÃO a view
  // rides_with_locations. A view foi definida com `select r.*`, que o Postgres
  // expande para a lista de colunas existentes NO MOMENTO da criação — como ela
  // foi criada antes da migration 0011, NÃO inclui driver_lat/lng/eta_*. Ler a
  // tabela garante que os campos de telemetria realmente cheguem.
  useEffect(() => {
    if (!ride.id) return;
    if (ride.status === 'completed' || ride.status === 'cancelled') return;

    async function fetchTelemetry() {
      const { data } = await supabase
        .from('rides')
        .select('driver_lat,driver_lng,driver_eta_min,driver_eta_km,status,driver_id')
        .eq('id', ride.id)
        .maybeSingle();
      if (data) setRide((prev) => ({ ...prev, ...data }));
    }

    fetchTelemetry();
    const interval = setInterval(fetchTelemetry, 4000);
    return () => clearInterval(interval);
  }, [ride.id, ride.status]);

  // Sempre que a posição muda, reativa o redesenho do marcador por um instante
  // (garante que o ícone do carro pinte e acompanhe o movimento no iOS).
  useEffect(() => {
    if (!driverLoc) return;
    setTracksCar(true);
    const t = setTimeout(() => setTracksCar(false), 1000);
    return () => clearTimeout(t);
  }, [driverLoc?.lat, driverLoc?.lng, driverLoc?.heading]);

  useEffect(() => {
    const channel = supabase
      .channel(`active-ride-${ride.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rides', filter: `id=eq.${ride.id}` },
        (payload) => {
          const updated = payload.new as Ride;
          // Merge (não substitui) para preservar origin/destination aninhados e
          // absorver a telemetria (driver_lat/lng/eta_*) que vem na linha.
          setRide((prev) => ({ ...prev, ...updated }));
          if (updated.status === 'completed') {
            navigation.replace('RateRide', { ride: updated });
          } else if (updated.status === 'cancelled') {
            Alert.alert('Corrida cancelada', 'O motorista cancelou a corrida.');
            navigation.reset({ index: 0, routes: [{ name: 'PassengerTabs' }] });
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [ride.id]);

  const origin = rideOrigin(ride);
  const dest = rideDestination(ride);

  // Rota completa: origem → destino (polyline base no mapa)
  const { route: fullPath } = useRideRoute(
    { lat: origin.lat, lng: origin.lng },
    { lat: dest.lat, lng: dest.lng }
  );

  // Rota motorista → embarque (accepted / driver_en_route)
  const toPickupOrigin = (ride.status === 'accepted' || ride.status === 'driver_en_route') && driverLoc
    ? { lat: driverLoc.lat, lng: driverLoc.lng }
    : null;
  const { route: toPickupPath } = useRideRoute(
    toPickupOrigin,
    toPickupOrigin ? { lat: origin.lat, lng: origin.lng } : null
  );

  // Rota motorista → destino (in_progress)
  const toDestOrigin = ride.status === 'in_progress' && driverLoc
    ? { lat: driverLoc.lat, lng: driverLoc.lng }
    : null;
  const { route: remainingPath } = useRideRoute(
    toDestOrigin,
    toDestOrigin ? { lat: dest.lat, lng: dest.lng } : null
  );

  // ETA exibido ao passageiro. Prioridade: telemetria gravada pelo motorista na
  // corrida (driver_eta_min/km) — assim o número é IDÊNTICO ao da tela dele.
  // Fallback: rota calculada localmente (driver→embarque / driver→destino).
  const localPath =
    ride.status === 'in_progress' ? (remainingPath ?? fullPath) :
    toPickupPath ?? fullPath;

  const hasDriverEta =
    (ride.status === 'accepted' || ride.status === 'driver_en_route' || ride.status === 'in_progress') &&
    ride.driver_eta_min != null;

  const etaMin = hasDriverEta ? ride.driver_eta_min! : localPath?.durationMin;
  const etaKm = hasDriverEta ? ride.driver_eta_km : localPath?.distanceKm;
  const hasEta = etaMin != null;

  // Horário estimado de chegada
  const etaArrival = hasEta
    ? new Date(Date.now() + etaMin! * 60 * 1000)
    : null;

  // Polyline exibida no mapa
  const path = fullPath;

  // Recentraliza o mapa: driver + embarque (a caminho) ou driver + embarque + destino (em andamento)
  useEffect(() => {
    if (!driverLoc || !mapRef.current) return;
    const base = [
      { latitude: driverLoc.lat, longitude: driverLoc.lng },
      { latitude: origin.lat, longitude: origin.lng },
    ];
    const coords = ride.status === 'in_progress'
      ? [...base, { latitude: dest.lat, longitude: dest.lng }]
      : base;
    mapRef.current.fitToCoordinates(coords, {
      edgePadding: { top: 140, right: 60, bottom: 300, left: 60 },
      animated: true,
    });
  }, [driverLoc, ride.status]);

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={styles.map}
        provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined}
        initialRegion={{
          latitude: (origin.lat + dest.lat) / 2,
          longitude: (origin.lng + dest.lng) / 2,
          latitudeDelta: Math.abs(origin.lat - dest.lat) * 2 + 0.02,
          longitudeDelta: Math.abs(origin.lng - dest.lng) * 2 + 0.02,
        }}
      >
        {path && (
          <Polyline coordinates={path.coordinates} strokeColor={Colors.accent} strokeWidth={4} />
        )}
        <Marker coordinate={{ latitude: origin.lat, longitude: origin.lng }}>
          <View style={styles.markerOrigin} />
        </Marker>
        <Marker coordinate={{ latitude: dest.lat, longitude: dest.lng }}>
          <View style={styles.markerDest} />
        </Marker>
        {driverLoc && (
          <Marker
            coordinate={{ latitude: driverLoc.lat, longitude: driverLoc.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            rotation={driverLoc.heading ?? 0}
            tracksViewChanges={tracksCar}
          >
            <CarMarker scale={0.75} />
          </Marker>
        )}
      </MapView>

      <View style={styles.bottomSheet}>
        <View style={styles.handle} />

        {/* ── Caixa preta ETA (idêntica à do motorista) ── */}
        <View style={styles.etaCard}>
          <View style={styles.etaMain}>
            <Text style={styles.etaMinutes}>
              {hasEta ? String(etaMin) : '—'}
            </Text>
            <Text style={styles.etaUnit}>min</Text>
            <View style={styles.etaSep} />
            <Text style={styles.etaDist}>
              {etaKm != null ? (etaKm * KM_TO_MILES).toFixed(1) : '—'}
            </Text>
            <Text style={styles.etaDistUnit}>mi</Text>
          </View>
          <Text style={styles.etaArrival}>
            {etaArrival
              ? `${ride.status === 'in_progress' ? 'Chegada estimada' : 'Chegada ao embarque'}: ${etaArrival.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
              : ride.status === 'accepted' || ride.status === 'driver_en_route' || ride.status === 'in_progress'
                ? 'Calculando rota...'
                : STATUS_LABELS[ride.status]}
          </Text>
        </View>

        {/* ── Endereço (embarque ou destino) ── */}
        <View style={styles.addressCard}>
          <Text style={styles.addressLabel}>
            {ride.status === 'in_progress' ? 'Destino final' : 'Local de embarque'}
          </Text>
          <Text style={styles.addressText} numberOfLines={2}>
            {ride.status === 'in_progress' ? dest.address : origin.address}
          </Text>
        </View>

        {/* ── Motorista ── */}
        <View style={styles.driverRow}>
          <View style={styles.driverAvatar}>
            <Text style={styles.driverAvatarText}>{driverName[0]}</Text>
          </View>
          <View style={styles.driverInfo}>
            <Text style={styles.driverName}>{driverName}</Text>
            <View style={styles.ratingRow}>
              <Text style={styles.star}>★</Text>
              <Text style={styles.ratingText}>{profile?.rating ?? '4.9'}</Text>
            </View>
          </View>
          {vehicle && (
            <View style={styles.plateBox}>
              <Text style={styles.plateText}>{vehicle.plate}</Text>
            </View>
          )}
          <View style={styles.driverActions}>
            <TouchableOpacity style={styles.actionBtn}>
              <Text style={styles.actionIcon}>📞</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.actionBtn}
              onPress={() => navigation.navigate('Chat', { rideId: ride.id, title: driverName })}
            >
              <Text style={styles.actionIcon}>💬</Text>
            </TouchableOpacity>
          </View>
        </View>

        {vehicle && (
          <Text style={styles.vehicleLabel}>{vehicle.model} • {vehicle.color}</Text>
        )}

        {canCancel && (
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

  // ── Bottom sheet ──────────────────────────────────────────────────────────
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
  handle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Colors.gray[300],
    alignSelf: 'center',
    marginBottom: 14,
  },

  // ── Caixa preta ETA (igual ao motorista) ─────────────────────────────────
  etaCard: {
    backgroundColor: Colors.primary,
    borderRadius: 16,
    padding: 16,
    marginBottom: 14,
    alignItems: 'center',
  },
  etaMain: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
    marginBottom: 6,
  },
  etaMinutes: {
    fontSize: 48,
    fontWeight: '900',
    color: Colors.white,
    letterSpacing: -2,
  },
  etaUnit: {
    fontSize: 18,
    fontWeight: '600',
    color: Colors.accent,
    marginBottom: 4,
  },
  etaSep: {
    width: 1,
    height: 32,
    backgroundColor: 'rgba(255,255,255,0.2)',
    marginHorizontal: 8,
  },
  etaDist: {
    fontSize: 20,
    fontWeight: '700',
    color: Colors.gray[300],
  },
  etaDistUnit: {
    fontSize: 18,
    fontWeight: '600',
    color: Colors.accent,
    marginBottom: 4,
  },
  etaArrival: {
    fontSize: 13,
    color: Colors.gray[400],
    fontWeight: '600',
  },

  // ── Endereço ──────────────────────────────────────────────────────────────
  addressCard: {
    backgroundColor: Colors.gray[100],
    borderRadius: 12,
    padding: 14,
    marginBottom: 14,
  },
  addressLabel: {
    fontSize: 11,
    color: Colors.gray[400],
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  addressText: {
    fontSize: 15,
    color: Colors.primary,
    fontWeight: '600',
  },

  // ── Motorista ─────────────────────────────────────────────────────────────
  driverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  driverAvatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  driverAvatarText: { color: Colors.accent, fontSize: 18, fontWeight: '800' },
  driverInfo: { flex: 1 },
  driverName: { fontSize: 15, fontWeight: '700', color: Colors.primary },
  ratingRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
  star: { color: Colors.accent, fontSize: 13, marginRight: 2 },
  ratingText: { fontSize: 12, color: Colors.gray[500] },
  plateBox: {
    backgroundColor: Colors.primary,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginRight: 8,
  },
  plateText: { color: Colors.white, fontSize: 13, fontWeight: '800', letterSpacing: 1 },
  driverActions: { flexDirection: 'row', gap: 8 },
  actionBtn: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: Colors.gray[100],
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionIcon: { fontSize: 18 },
  vehicleLabel: {
    fontSize: 12,
    color: Colors.gray[400],
    marginBottom: 14,
    marginLeft: 58,
  },

  // ── Cancelar ──────────────────────────────────────────────────────────────
  cancelBtn: { alignItems: 'center', paddingVertical: 12, marginTop: 4 },
  cancelBtnText: { color: Colors.error, fontSize: 15, fontWeight: '700' },

  // ── Marcadores no mapa ────────────────────────────────────────────────────
  markerOrigin: {
    width: 12, height: 12, borderRadius: 6,
    backgroundColor: Colors.accent, borderWidth: 2, borderColor: Colors.white,
  },
  markerDest: {
    width: 12, height: 12, borderRadius: 2,
    backgroundColor: Colors.primary, borderWidth: 2, borderColor: Colors.white,
  },
});
