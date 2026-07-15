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
import { useCameraController } from '../../hooks/useCameraController';
import { KM_TO_MILES } from '../../lib/format';
import { CarMarker } from '../../components/common/CarMarker';
import { rideOrigin, rideDestination } from '../../lib/ride';
import { useTranslation } from '../../i18n';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'ActiveRide'>;
  route: RouteProp<RootStackParamList, 'ActiveRide'>;
};

const STATUS_LABEL_KEYS: Record<RideStatus, string> = {
  scheduled: 'activeRide.statusScheduled',
  requesting: 'activeRide.statusRequesting',
  accepted: 'activeRide.statusAccepted',
  driver_en_route: 'activeRide.statusDriverEnRoute',
  in_progress: 'activeRide.statusInProgress',
  completed: 'activeRide.statusCompleted',
  cancelled: 'activeRide.statusCancelled',
};

export function ActiveRideScreen({ navigation, route }: Props) {
  const { t } = useTranslation();
  const { profile } = useAuth();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { cancelRide } = usePassengerRide(profile?.id, profile?.jurisdiction);
  const isFocused = useIsFocused();
  const [ride, setRide] = useState<Ride>(route.params.ride);
  const [driverLoc, setDriverLoc] = useState<{ lat: number; lng: number; heading?: number } | null>(null);
  // Controla o snapshot do marcador customizado: precisa ficar `true` por um
  // instante a cada atualização para o ícone do carro realmente pintar no iOS.
  const [tracksCar, setTracksCar] = useState(true);
  const mapRef = useRef<MapView>(null);
  // Bloco 1: câmera passa pelo CameraController (sanitiza coords antes do fit).
  const cam = useCameraController(mapRef, 'PassengerActiveRide');
  // `fitToCoordinates` chamado ANTES do MapView nativo terminar seu layout
  // inicial pode calcular uma região absurda (mapa mostrando o continente
  // inteiro) — bug conhecido do react-native-maps. `onMapReady` garante que só
  // recentralizamos depois que o mapa está de fato pronto para receber câmera.
  const [mapReady, setMapReady] = useState(false);

  const styles = makeStyles(colors);

  useChatAlert(ride.id, profile?.id, isFocused, t('activeRide.driverFallback'));
  const [driverName, setDriverName] = useState(t('activeRide.driverFallback'));
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
      Alert.alert(t('activeRide.shareTripTitle'), t('activeRide.shareLinkFailed'));
      return;
    }
    try {
      // Envio SEMPRE pelo share sheet nativo — a escolha do contato e o envio
      // são ações do próprio passageiro. O app nunca envia sozinho.
      await Share.share({
        message: t('activeRide.shareMessage').replace('{url}', share.url),
        url: share.url,
      });
    } catch {
      // usuário fechou o share sheet — link continua válido para reenvio
    }
  }

  function handleStopSharing() {
    Alert.alert(
      t('activeRide.stopSharingTitle'),
      t('activeRide.stopSharingMessage'),
      [
        { text: t('activeRide.back'), style: 'cancel' },
        {
          text: t('activeRide.stop'),
          style: 'destructive',
          onPress: async () => {
            const ok = await revokeShare();
            if (!ok) Alert.alert(t('activeRide.shareTripTitle'), t('activeRide.stopSharingFailed'));
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
        t('activeRide.shareTripTitle'),
        t('activeRide.autoShareMessage'),
        [
          { text: t('activeRide.notNow'), style: 'cancel' },
          {
            text: t('activeRide.share'),
            onPress: () => {
              Share.share({
                message: t('activeRide.shareMessage').replace('{url}', share.url),
                url: share.url,
              }).catch(() => {});
            },
          },
        ],
      );
    })();
  }, [profile?.trip_autoshare, profile?.trip_autoshare_contact_id, canShare, createShare]);

  function handleCancel() {
    Alert.alert(t('activeRide.cancelRideTitle'), t('activeRide.cancelRideMessage'), [
      { text: t('activeRide.no'), style: 'cancel' },
      {
        text: t('activeRide.yesCancel'),
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
        .from('profiles_public')
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
    const timeout = setTimeout(() => setTracksCar(false), 1000);
    return () => clearTimeout(timeout);
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
          // A NAVEGAÇÃO para o status terminal não acontece aqui — fica só no
          // efeito abaixo, que reage a `ride.status` (ver comentário lá).
          setRide((prev) => ({ ...prev, ...updated }));
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [ride.id]);

  // Sai da tela quando a corrida chega a um status terminal — de QUALQUER
  // fonte que atualize `ride.status` (o evento realtime acima OU o polling de
  // telemetria a cada 4s, logo abaixo).
  //
  // IMPORTANTE: a navegação pode ser silenciosamente engolida pelo SO quando
  // um overlay nativo está por cima da tela no exato momento em que o
  // motorista finaliza — ex.: a folha nativa de compartilhamento
  // (`Share.share`, ver `handleShareTrip`) ou um `Alert.alert` de
  // parar/auto-compartilhar (ver `handleStopSharing` e o efeito de
  // auto-share). Nesse caso `navigation.replace`/`reset` não tem efeito
  // visual e, com uma trava de "só uma tentativa", o passageiro ficava preso
  // na tela mesmo com a corrida já concluída no banco.
  //
  // Correção: em vez de tentar navegar uma única vez, insistimos a cada
  // ~1.2s até a tela realmente perder o foco (o que só acontece quando a
  // navegação de fato aconteceu). O Alert de "corrida cancelada" é mostrado
  // uma única vez (via `cancelAlertShownRef`), mas o `navigation.reset` em si
  // pode ser reemitido com segurança a cada tentativa.
  const cancelAlertShownRef = useRef(false);
  useEffect(() => {
    if (ride.status !== 'completed' && ride.status !== 'cancelled') return;

    let stopped = false;

    function attemptNavigateAway() {
      if (stopped) return;
      // Se a tela já perdeu o foco, a navegação anterior deu certo — encerra.
      if (!navigation.isFocused()) {
        stopped = true;
        return;
      }
      if (ride.status === 'completed') {
        navigation.replace('RateRide', { ride });
      } else {
        if (!cancelAlertShownRef.current) {
          cancelAlertShownRef.current = true;
          Alert.alert(
            t('activeRide.rideCancelledTitle'),
            t('activeRide.rideCancelledByDriver'),
          );
        }
        navigation.reset({ index: 0, routes: [{ name: 'PassengerTabs' }] });
      }
    }

    attemptNavigateAway();
    const retry = setInterval(attemptNavigateAway, 1200);
    return () => {
      stopped = true;
      clearInterval(retry);
    };
  }, [ride.status]);

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
    if (!mapReady || !driverLoc) return;
    fitToRide();
  }, [mapReady, driverLoc, ride.status]);

  function fitToRide() {
    if (!driverLoc) return;
    const coords = ride.status === 'in_progress'
      ? [
          { lat: driverLoc.lat, lng: driverLoc.lng },
          { lat: dest.lat, lng: dest.lng },
        ]
      : [
          { lat: driverLoc.lat, lng: driverLoc.lng },
          { lat: origin.lat, lng: origin.lng },
        ];
    cam.fit(coords, {
      edgePadding: { top: 140, right: 60, bottom: 300, left: 60 },
      animated: true,
    });
  }

  function recenter() {
    fitToRide();
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
        onMapReady={() => {
          cam.setReady(true);
          setMapReady(true);
        }}
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
              ? `${ride.status === 'in_progress' ? t('activeRide.estimatedArrival') : t('activeRide.arrivalAtPickup')}: ${etaArrival.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
              : ride.status === 'accepted' || ride.status === 'driver_en_route' || ride.status === 'in_progress'
                ? t('activeRide.calculatingRoute')
                : t(STATUS_LABEL_KEYS[ride.status])}
          </Text>
        </View>

        {/* ── Endereço (embarque ou destino) ── */}
        <View style={styles.addressCard}>
          <Text style={styles.addressLabel}>
            {ride.status === 'in_progress' ? t('activeRide.finalDestination') : t('activeRide.pickupLocation')}
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
              {shareActive ? t('activeRide.shareLinkAgain') : t('activeRide.shareTripTitle')}
            </Text>
          </TouchableOpacity>
        )}

        {canShare && shareActive && (
          <TouchableOpacity style={styles.stopShareBtn} onPress={handleStopSharing}>
            <Text style={styles.stopShareText}>{t('activeRide.stopSharingTitle')}</Text>
          </TouchableOpacity>
        )}

        {canCancel && (
          <TouchableOpacity style={styles.cancelBtn} onPress={handleCancel}>
            <Text style={styles.cancelBtnText}>{t('activeRide.cancelRideTitle')}</Text>
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
