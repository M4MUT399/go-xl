import React, { useEffect, useState, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Platform, Alert, ScrollView, Share,
} from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useIsFocused } from '@react-navigation/native';
import { RootStackParamList, Ride, RideStatus } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import { AppTheme } from '../../constants/theme';
import { supabase } from '../../lib/supabase';
import { useAuth } from '../../hooks/useAuth';
import { usePassengerRide } from '../../hooks/useRide';
import { useDriverVehicle } from '../../hooks/useVehicle';
import { useRoute as useRideRoute } from '../../hooks/useRoute';
import { useChatAlert } from '../../hooks/useChatAlert';
import { useTripShare } from '../../hooks/useTripShare';
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
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { cancelRide } = usePassengerRide(profile?.id);
  const isFocused = useIsFocused();
  const [ride, setRide] = useState<Ride>(route.params.ride);
  const [driverLoc, setDriverLoc] = useState<{ lat: number; lng: number; heading?: number } | null>(null);
  // Controla o snapshot do marcador customizado: precisa ficar `true` por um
  // instante a cada atualização para o ícone do carro realmente pintar no iOS.
  const [tracksCar, setTracksCar] = useState(true);
  const mapRef = useRef<MapView>(null);
  // `fitToCoordinates` chamado ANTES do MapView nativo terminar seu layout
  // inicial pode calcular uma região absurda (mapa mostrando o continente
  // inteiro) — bug conhecido do react-native-maps. `onMapReady` garante que só
  // recentralizamos depois que o mapa está de fato pronto para receber câmera.
  const [mapReady, setMapReady] = useState(false);

  const styles = makeStyles(colors);

  useChatAlert(ride.id, profile?.id, isFocused, 'Motorista');
  const [driverName, setDriverName] = useState('Motorista');
  const vehicle = useDriverVehicle(ride.driver_id);

  const canCancel = ride.status === 'accepted' || ride.status === 'driver_en_route';

  // ── Compartilhar viagem ao vivo (Tarefa 1) ────────────────────────────────
  const { creating: sharingBusy, active: shareActive, createShare, revokeShare } = useTripShare(ride.id);
  // Só faz sentido compartilhar enquanto a viagem está de fato acontecendo.
  const canShare =
    ride.status === 'accepted' || ride.status === 'driver_en_route' || ride.status === 'in_progress';
  // Garante que o convite de auto-compartilhamento apareça no máximo uma vez por
  // corrida (o passageiro pode recusar sem ser incomodado de novo).
  const autoSharePromptedRef = useRef(false);

  async function handleShareTrip() {
    const share = await createShare();
    if (!share) {
      Alert.alert('Compartilhar viagem', 'Não foi possível gerar o link agora. Tente novamente.');
      return;
    }
    try {
      // Envio SEMPRE pelo share sheet nativo — a escolha do contato e o envio
      // são ações do próprio passageiro. O app nunca envia sozinho.
      await Share.share({
        message: `Acompanhe minha viagem Go XL ao vivo: ${share.url}`,
        url: share.url,
      });
    } catch {
      // usuário fechou o share sheet — link continua válido para reenvio
    }
  }

  function handleStopSharing() {
    Alert.alert(
      'Parar de compartilhar',
      'O link deixará de mostrar sua localização. Você pode gerar um novo quando quiser.',
      [
        { text: 'Voltar', style: 'cancel' },
        {
          text: 'Parar',
          style: 'destructive',
          onPress: async () => {
            const ok = await revokeShare();
            if (!ok) Alert.alert('Compartilhar viagem', 'Não foi possível parar agora. Tente novamente.');
          },
        },
      ],
    );
  }

  // Auto-compartilhar: se o passageiro ativou a preferência, ao iniciar a
  // corrida oferecemos abrir o share sheet para o contato escolhido — em um
  // toque, mas NUNCA de forma silenciosa (o envio exige a ação do passageiro).
  useEffect(() => {
    if (autoSharePromptedRef.current) return;
    if (!profile?.trip_autoshare) return;
    if (!canShare) return;
    autoSharePromptedRef.current = true;
    (async () => {
      const share = await createShare(profile.trip_autoshare_contact_id ?? null);
      if (!share) return;
      Alert.alert(
        'Compartilhar viagem',
        'Deseja enviar o link de acompanhamento ao vivo para seu contato de confiança?',
        [
          { text: 'Agora não', style: 'cancel' },
          {
            text: 'Compartilhar',
            onPress: () => {
              Share.share({
                message: `Acompanhe minha viagem Go XL ao vivo: ${share.url}`,
                url: share.url,
              }).catch(() => {});
            },
          },
        ],
      );
    })();
  }, [profile?.trip_autoshare, profile?.trip_autoshare_contact_id, canShare, createShare]);

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
      setDriverLoc({ lat: ride.driver_lat, lng: ride.driver_lng, heading: ride.driver_heading ?? undefined });
    }
  }, [ride.driver_lat, ride.driver_lng, ride.driver_heading]);

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
        .select('driver_lat,driver_lng,driver_heading,driver_eta_min,driver_eta_km,status,driver_id')
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
            Alert.alert(
              'Corrida cancelada',
              'O motorista cancelou a corrida. O valor cobrado será estornado automaticamente para o seu cartão.',
            );
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

  // Polyline ativa: trecho que o motorista ainda vai percorrer
  //   • accepted / driver_en_route → motorista a caminho do embarque
  //   • in_progress               → percurso restante até o destino (IGUAL à tela do motorista)
  const activePolyline =
    ride.status === 'in_progress' ? remainingPath :
    (ride.status === 'accepted' || ride.status === 'driver_en_route') ? toPickupPath :
    null;

  // Recentraliza o mapa conforme fase da corrida:
  //   • a caminho do embarque → motorista + ponto de embarque
  //   • in_progress (corrida em andamento) → motorista + destino final
  useEffect(() => {
    if (!mapReady || !driverLoc || !mapRef.current) return;
    const coords = ride.status === 'in_progress'
      ? [
          { latitude: driverLoc.lat, longitude: driverLoc.lng },
          { latitude: dest.lat, longitude: dest.lng },
        ]
      : [
          { latitude: driverLoc.lat, longitude: driverLoc.lng },
          { latitude: origin.lat, longitude: origin.lng },
        ];
    mapRef.current.fitToCoordinates(coords, {
      edgePadding: { top: 140, right: 60, bottom: 300, left: 60 },
      animated: true,
    });
  }, [mapReady, driverLoc, ride.status]);

  function recenter() {
    if (!mapReady || !driverLoc || !mapRef.current) return;
    const coords = ride.status === 'in_progress'
      ? [
          { latitude: driverLoc.lat, longitude: driverLoc.lng },
          { latitude: dest.lat, longitude: dest.lng },
        ]
      : [
          { latitude: driverLoc.lat, longitude: driverLoc.lng },
          { latitude: origin.lat, longitude: origin.lng },
        ];
    mapRef.current.fitToCoordinates(coords, {
      edgePadding: { top: 140, right: 60, bottom: 300, left: 60 },
      animated: true,
    });
  }

  return (
    <View style={styles.container}>
      <View style={styles.mapArea}>
      <MapView
        ref={mapRef}
        style={styles.map}
        provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined}
        // Força o mapa CLARO em ambas as plataformas. No iOS, sem
        // `userInterfaceStyle`, o Apple Maps segue o modo escuro do sistema
        // (comportamento "automatic") — não é claro por padrão como o
        // comentário antigo assumia.
        customMapStyle={Platform.OS === 'android' ? [] : undefined}
        userInterfaceStyle="light"
        onMapReady={() => setMapReady(true)}
        initialRegion={{
          latitude: (origin.lat + dest.lat) / 2,
          longitude: (origin.lng + dest.lng) / 2,
          latitudeDelta: Math.abs(origin.lat - dest.lat) * 2 + 0.02,
          longitudeDelta: Math.abs(origin.lng - dest.lng) * 2 + 0.02,
        }}
      >
        {/* Rota completa em plano de fundo — contexto visual da viagem */}
        {fullPath && (
          <Polyline
            coordinates={fullPath.coordinates}
            strokeColor="rgba(120,140,200,0.30)"
            strokeWidth={3}
            lineDashPattern={[5, 4]}
          />
        )}
        {/* Rota ativa: motorista a caminho do embarque ou do destino */}
        {(activePolyline ?? fullPath) && (
          <Polyline
            coordinates={(activePolyline ?? fullPath)!.coordinates}
            strokeColor={colors.accent}
            strokeWidth={5}
          />
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
            tracksViewChanges={tracksCar}
          >
            <CarMarker scale={0.75} heading={driverLoc.heading ?? 0} />
          </Marker>
        )}
      </MapView>

      {driverLoc && (
        <TouchableOpacity style={styles.recenterBtn} onPress={recenter}>
          <Text style={styles.recenterIcon}>◎</Text>
        </TouchableOpacity>
      )}
      </View>

      <View style={[styles.bottomSheet, Platform.OS === 'android' && { paddingBottom: 32 + insets.bottom }]}>
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

        {canShare && (
          <TouchableOpacity
            style={styles.shareBtn}
            onPress={handleShareTrip}
            disabled={sharingBusy}
            activeOpacity={0.85}
          >
            <Text style={styles.shareIcon}>📍</Text>
            <Text style={styles.shareBtnText}>
              {shareActive ? 'Compartilhar link novamente' : 'Compartilhar viagem'}
            </Text>
          </TouchableOpacity>
        )}

        {canShare && shareActive && (
          <TouchableOpacity style={styles.stopShareBtn} onPress={handleStopSharing}>
            <Text style={styles.stopShareText}>Parar de compartilhar</Text>
          </TouchableOpacity>
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

function makeStyles(colors: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1 },
    mapArea: { flex: 1 },
    map: { flex: 1 },
    recenterBtn: {
      position: 'absolute',
      right: 16,
      bottom: 16,
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: colors.card,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.2,
      shadowRadius: 6,
      elevation: 5,
    },
    recenterIcon: { fontSize: 22, color: colors.primary },

    // ── Bottom sheet ──────────────────────────────────────────────────────────
    bottomSheet: {
      backgroundColor: colors.card,
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
      backgroundColor: colors.gray[300],
      alignSelf: 'center',
      marginBottom: 14,
    },

    // ── Caixa preta ETA (igual ao motorista) ─────────────────────────────────
    etaCard: {
      backgroundColor: colors.primary,
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
      color: colors.white,
      letterSpacing: -2,
    },
    etaUnit: {
      fontSize: 18,
      fontWeight: '600',
      color: colors.accent,
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
      color: colors.gray[300],
    },
    etaDistUnit: {
      fontSize: 18,
      fontWeight: '600',
      color: colors.accent,
      marginBottom: 4,
    },
    etaArrival: {
      fontSize: 13,
      color: colors.gray[400],
      fontWeight: '600',
    },

    // ── Endereço ──────────────────────────────────────────────────────────────
    addressCard: {
      backgroundColor: colors.gray[100],
      borderRadius: 12,
      padding: 14,
      marginBottom: 14,
    },
    addressLabel: {
      fontSize: 11,
      color: colors.gray[400],
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginBottom: 4,
    },
    addressText: {
      fontSize: 15,
      color: colors.text,
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
      backgroundColor: colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 12,
    },
    driverAvatarText: { color: colors.accent, fontSize: 18, fontWeight: '800' },
    driverInfo: { flex: 1 },
    driverName: { fontSize: 15, fontWeight: '700', color: colors.text },
    ratingRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
    star: { color: colors.accent, fontSize: 13, marginRight: 2 },
    ratingText: { fontSize: 12, color: colors.gray[500] },
    plateBox: {
      backgroundColor: colors.primary,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
      marginRight: 8,
    },
    plateText: { color: colors.white, fontSize: 13, fontWeight: '800', letterSpacing: 1 },
    driverActions: { flexDirection: 'row', gap: 8 },
    actionBtn: {
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: colors.gray[100],
      alignItems: 'center',
      justifyContent: 'center',
    },
    actionIcon: { fontSize: 18 },
    vehicleLabel: {
      fontSize: 12,
      color: colors.gray[400],
      marginBottom: 14,
      marginLeft: 58,
    },

    // ── Compartilhar viagem ─────────────────────────────────────────────────────
    shareBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      backgroundColor: colors.gray[100],
      borderRadius: 12,
      paddingVertical: 14,
      borderWidth: 1,
      borderColor: colors.gray[200],
    },
    shareIcon: { fontSize: 16 },
    shareBtnText: { color: colors.primary, fontSize: 15, fontWeight: '700' },
    stopShareBtn: { alignItems: 'center', paddingVertical: 10, marginTop: 2 },
    stopShareText: { color: colors.gray[500], fontSize: 13, fontWeight: '600' },

    // ── Cancelar ──────────────────────────────────────────────────────────────
    cancelBtn: { alignItems: 'center', paddingVertical: 12, marginTop: 4 },
    cancelBtnText: { color: colors.error, fontSize: 15, fontWeight: '700' },

    // ── Marcadores no mapa ────────────────────────────────────────────────────
    markerOrigin: {
      width: 12, height: 12, borderRadius: 6,
      backgroundColor: colors.accent, borderWidth: 2, borderColor: colors.white,
    },
    markerDest: {
      width: 12, height: 12, borderRadius: 2,
      backgroundColor: colors.primary, borderWidth: 2, borderColor: colors.white,
    },
  });
}
