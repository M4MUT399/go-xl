import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, SafeAreaView, TouchableOpacity, Switch, Platform, Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import { AppTheme } from '../../constants/theme';
import { useAuth } from '../../hooks/useAuth';
import { useLocation } from '../../hooks/useLocation';
import { useDriverRide } from '../../hooks/useRide';
import { formatCurrency, formatDistance } from '../../lib/format';
import { rideOrigin, rideDestination } from '../../lib/ride';
import { supabase } from '../../lib/supabase';
import { useTranslation } from '../../i18n';
import { CarMarker } from '../../components/common/CarMarker';
import { CrosshairIcon } from '../../components/common/CrosshairIcon';
import { IncomingRideCall } from '../../components/driver/IncomingRideCall';
import { ScheduledRideBanner } from '../../components/driver/ScheduledRideBanner';
import { DutyStatusBanner } from '../../components/driver/DutyStatusBanner';
import { getConfig, getConfigDefault } from '../../lib/systemConfig';
import { logRideOfferEvent } from '../../lib/rideOfferEvents';
import { useUpcomingScheduledRide } from '../../hooks/useUpcomingScheduledRide';
import { useScheduledReminderAlert } from '../../hooks/useScheduledReminderAlert';
import { useScheduledOfferAlert } from '../../hooks/useScheduledOfferAlert';
import { useDrivingLimit } from '../../hooks/useDrivingLimit';
import { useBackgroundCheck } from '../../hooks/useBackgroundCheck';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'DriverTabs'> };

export function DriverHomeScreen({ navigation }: Props) {
  const { profile } = useAuth();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const [isOnline, setIsOnline] = useState(false);
  // watch: true → posição contínua enquanto online (banco atualiza a cada ≥15 m)
  const { location } = useLocation({ watch: isOnline });
  const { pendingRide, pendingScheduledRide, setPendingRide, setPendingScheduledRide, acceptRide, confirmScheduledRide } = useDriverRide(profile?.id);
  // P2: próxima corrida agendada confirmada por mim → banner fixo + alerta sonoro.
  const upcoming = useUpcomingScheduledRide(profile?.id);
  useScheduledReminderAlert(upcoming.imminent, upcoming.ride?.id ?? null);
  // Item #4: sinal sonoro DISTINTO (arpejo) quando um novo agendamento chega.
  useScheduledOfferAlert(pendingScheduledRide?.id ?? null);
  // P3: limite de direção (12h) + descanso obrigatório (6h), configurável.
  const duty = useDrivingLimit(profile?.id);
  const bgCheck = useBackgroundCheck(profile?.id);
  // true após carregar o valor persistido — evita gravar is_online=false no banco antes de ler o AsyncStorage
  const [onlineLoaded, setOnlineLoaded] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Timeout da chamada de corrida (s) — configurável via system_config (P1).
  const [callTimeout, setCallTimeout] = useState<number>(getConfigDefault('ride_offer_timeout_seconds'));
  // Evita registrar o evento 'received' mais de uma vez para a mesma chamada.
  const loggedReceivedRef = useRef<string | null>(null);
  const mapRef = useRef<MapView>(null);
  // Mantém o marcador "ligado" por um instante a cada movimento, para o
  // ícone do carro repintar e acompanhar a posição/rotação no iOS.
  const [tracksCar, setTracksCar] = useState(true);

  const styles = makeStyles(colors);

  useEffect(() => {
    if (!location) return;
    setTracksCar(true);
    const t = setTimeout(() => setTracksCar(false), 1000);
    return () => clearTimeout(t);
  }, [location?.lat, location?.lng, location?.heading]);

  function recenter() {
    if (location && mapRef.current) {
      mapRef.current.animateCamera(
        { center: { latitude: location.lat, longitude: location.lng }, zoom: 16 },
        { duration: 300 }
      );
    }
  }

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
      heading: location.heading ?? null,
      is_online: isOnline,
      updated_at: new Date().toISOString(),
    });
  }, [location, isOnline, profile?.id, onlineLoaded]);

  // Carrega o timeout configurável da chamada de corrida (fallback local seguro).
  useEffect(() => {
    getConfig('ride_offer_timeout_seconds').then(setCallTimeout).catch(() => {});
  }, []);

  // Registra 'received' assim que uma nova chamada aparece para este motorista.
  useEffect(() => {
    const id = pendingRide?.id;
    if (id && loggedReceivedRef.current !== id) {
      loggedReceivedRef.current = id;
      logRideOfferEvent(id, profile?.id, 'received');
    }
    if (!id) loggedReceivedRef.current = null;
  }, [pendingRide?.id, profile?.id]);

  // P3: se o limite de direção estourar enquanto online, força offline e avisa
  // uma única vez por episódio de descanso. Só acontece na home (idle) — corrida
  // em andamento vive na tela de navegação, então não interrompe viagem.
  const forcedRestRef = useRef(false);
  useEffect(() => {
    if (isOnline && duty.status.mustRest) {
      if (!forcedRestRef.current) {
        forcedRestRef.current = true;
        const until = duty.status.restUntil
          ? duty.status.restUntil.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
          : '';
        Alert.alert(
          t('duty.restTitle', 'Mandatory rest'),
          `${t('duty.limitReachedBody', 'You reached the driving limit and are now offline. Back online at')} ${until}`
        );
      }
      setIsOnline(false);
      AsyncStorage.setItem('driver_is_online', 'false');
      duty.endSession();
    }
    if (!duty.status.mustRest) forcedRestRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline, duty.status.mustRest]);

  // Alterna online/offline e persiste a escolha.
  // Só permite ficar online se a verificação (selfie + documento) já tiver
  // sido aprovada pela equipe — duplo grau de conferência antes de aceitar corridas.
  function handleOnlineChange(val: boolean) {
    if (val && profile?.verification_status !== 'approved') {
      Alert.alert(
        t('driver.verificationRequiredTitle'),
        t('driver.verificationRequiredBody'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('driver.verificationGo'), onPress: () => navigation.navigate('DriverVerification') },
        ]
      );
      return;
    }
    // P7: exige background check aprovado e válido, quando a jurisdição pedir.
    // required=false (padrão) → canGoOnline sempre true, sem mudança de fluxo.
    if (val && !bgCheck.canGoOnline) {
      Alert.alert(
        t('bgcheck.requiredTitle', 'Background check required'),
        t('bgcheck.requiredBody', 'Your background check must be approved before you can go online.')
      );
      return;
    }
    // P3: bloqueia ficar online enquanto o descanso obrigatório não terminar.
    if (val && duty.status.mustRest) {
      const until = duty.status.restUntil
        ? duty.status.restUntil.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
        : '';
      Alert.alert(
        t('duty.restTitle', 'Mandatory rest'),
        `${t('duty.restBody', 'Driving limit reached. Back online at')} ${until}`
      );
      return;
    }
    setIsOnline(val);
    AsyncStorage.setItem('driver_is_online', val ? 'true' : 'false');
    // Abre/fecha a sessão de serviço que alimenta o cálculo do limite (P3).
    if (val) duty.startSession();
    else duty.endSession();
  }

  async function handleAccept() {
    if (!pendingRide) return;
    setAccepting(true);
    const ride = await acceptRide(pendingRide.id, location ? { lat: location.lat, lng: location.lng } : null);
    setAccepting(false);
    if (ride === 'payment_error') {
      Alert.alert(
        'Pagamento recusado',
        'O cartão do passageiro foi recusado. A corrida não pôde ser aceita.',
      );
      setPendingRide(null);
    } else if (ride) {
      navigation.navigate('DriverNavigate', { ride });
    } else {
      Alert.alert('Ops', 'Corrida já foi aceita por outro motorista.');
      setPendingRide(null);
    }
  }

  function handleReject() {
    if (pendingRide) logRideOfferEvent(pendingRide.id, profile?.id, 'rejected');
    setPendingRide(null);
  }

  function handleExpire() {
    if (pendingRide) logRideOfferEvent(pendingRide.id, profile?.id, 'expired');
    setPendingRide(null);
  }

  async function handleConfirmScheduled() {
    if (!pendingScheduledRide) return;
    setConfirming(true);
    const ok = await confirmScheduledRide(pendingScheduledRide.id);
    setConfirming(false);
    if (ok) {
      // Item #5: após confirmar, fecha o banner e volta para o mapa principal,
      // deixando o motorista livre para aguardar novas corridas. A agendada
      // confirmada reaparece no banner fixo (useUpcomingScheduledRide).
      setPendingScheduledRide(null);
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
        ref={mapRef}
        style={styles.map}
        provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined}
        initialRegion={{
          latitude: location?.lat ?? 28.5383,
          longitude: location?.lng ?? -81.3792,
          latitudeDelta: 0.015,
          longitudeDelta: 0.015,
        }}
        // Ver comentário equivalente em passenger/HomeScreen.tsx: o customMapStyle
        // escuro renderiza como "modo noturno" no Google Maps (Android); usamos o
        // estilo padrão (claro) nessa plataforma.
        customMapStyle={Platform.OS === 'android' ? [] : darkMapStyle}
      >
        {location && (
          <Marker
            coordinate={{ latitude: location.lat, longitude: location.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            tracksViewChanges={tracksCar}
          >
            <CarMarker scale={0.85} heading={location.heading ?? 0} />
          </Marker>
        )}
      </MapView>

      {location && (
        <TouchableOpacity style={styles.recenterBtn} onPress={recenter}>
          <CrosshairIcon size={27.5} color={colors.primary} />
        </TouchableOpacity>
      )}

      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <View style={styles.topBar}>
          <View>
            <Text style={styles.greeting}>{t('driver.hello')}, {firstName}</Text>
            <Text style={styles.role}>{t('driver.driverLabel')}</Text>
          </View>
          <View style={styles.onlineToggle}>
            <Text style={[styles.onlineLabel, isOnline && styles.onlineLabelActive]}>
              {isOnline ? t('driver.online') : t('driver.offline')}
            </Text>
            <Switch
              value={isOnline}
              onValueChange={handleOnlineChange}
              trackColor={{ false: colors.gray[400], true: colors.success }}
              thumbColor={colors.white}
            />
          </View>
        </View>

        {!isOnline && (
          <View style={styles.offlineBanner}>
            <Text style={styles.offlineBannerText}>
              {t('driver.activateOnline')}
            </Text>
          </View>
        )}

        {upcoming.showBanner && upcoming.ride && !pendingRide && (
          <ScheduledRideBanner
            ride={upcoming.ride}
            minutesUntil={upcoming.minutesUntil}
            imminent={upcoming.imminent}
            onPress={() => navigation.navigate('DriverScheduledRides')}
          />
        )}

        {!pendingRide && <DutyStatusBanner status={duty.status} warn={duty.warn} />}

      </SafeAreaView>

      {pendingScheduledRide && !pendingRide && (
        <View style={[styles.rideRequestSheet, { paddingBottom: Math.max(insets.bottom, 16) + 16 }]}>
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
        <IncomingRideCall
          ride={pendingRide}
          driverLocation={location ? { lat: location.lat, lng: location.lng } : null}
          timeoutSeconds={callTimeout}
          accepting={accepting}
          isQrLocked={!!pendingRide.driver_id}
          onAccept={handleAccept}
          onReject={handleReject}
          onExpire={handleExpire}
        />
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

function makeStyles(colors: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1 },
    map: { flex: 1 },
    overlay: { position: 'absolute', top: 0, left: 0, right: 0 },
    recenterBtn: {
      position: 'absolute',
      right: 16,
      bottom: 16,
      // 25% maior que o botão original (44 → 55) e com visual de mira.
      width: 55,
      height: 55,
      borderRadius: 27.5,
      backgroundColor: colors.card,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.2,
      shadowRadius: 6,
      elevation: 5,
    },
    topBar: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      margin: 16,
      backgroundColor: colors.primary,
      borderRadius: 16,
      padding: 16,
    },
    greeting: { fontSize: 17, fontWeight: '700', color: colors.white },
    role: { fontSize: 12, color: colors.accent, marginTop: 2 },
    onlineToggle: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    onlineLabel: { fontSize: 13, color: colors.gray[400], fontWeight: '600' },
    onlineLabelActive: { color: colors.success },
    offlineBanner: {
      marginHorizontal: 16,
      backgroundColor: 'rgba(26,26,46,0.9)',
      borderRadius: 12,
      padding: 12,
      alignItems: 'center',
    },
    offlineBannerText: { color: colors.gray[300], fontSize: 13, textAlign: 'center' },
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
    scheduledBtnText: { color: colors.accent, fontSize: 14, fontWeight: '700' },
    rideRequestSheet: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor: colors.card,
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
    requestHandle: { width: 36, height: 4, borderRadius: 2, backgroundColor: colors.gray[300], alignSelf: 'center', marginBottom: 16 },
    qrRideBadge: {
      backgroundColor: 'rgba(201,168,76,0.15)',
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 6,
      marginBottom: 8,
      borderWidth: 1,
      borderColor: 'rgba(201,168,76,0.4)',
    },
    qrRideBadgeText: { color: colors.accent, fontSize: 13, fontWeight: '700', textAlign: 'center' },
    scheduledHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
    scheduledIcon: { fontSize: 32 },
    scheduledWhen: { fontSize: 14, color: colors.accent, fontWeight: '700', marginTop: 2 },
    requestTitle: { fontSize: 22, fontWeight: '800', color: colors.text },
    requestDetails: { backgroundColor: colors.gray[100], borderRadius: 14, padding: 14, marginBottom: 16 },
    requestRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 4 },
    requestIcon: { fontSize: 18, marginRight: 12 },
    requestLabel: { fontSize: 11, color: colors.gray[400], textTransform: 'uppercase', letterSpacing: 0.5 },
    requestAddr: { fontSize: 14, color: colors.gray[800], fontWeight: '500', maxWidth: 240 },
    requestDivider: { height: 1, backgroundColor: colors.gray[200], marginVertical: 8, marginLeft: 30 },
    requestMeta: { flexDirection: 'row', alignItems: 'center', marginBottom: 20 },
    metaItem: { flex: 1, alignItems: 'center' },
    metaValue: { fontSize: 18, fontWeight: '800', color: colors.text },
    priceValue: { color: colors.accent },
    metaLabel: { fontSize: 11, color: colors.gray[400], marginTop: 2 },
    metaDivider: { width: 1, height: 32, backgroundColor: colors.gray[200] },
    requestActions: { flexDirection: 'row', gap: 12 },
    declineBtn: {
      flex: 1,
      height: 54,
      borderRadius: 12,
      borderWidth: 1.5,
      borderColor: colors.gray[300],
      alignItems: 'center',
      justifyContent: 'center',
    },
    declineText: { color: colors.gray[600], fontSize: 16, fontWeight: '600' },
    acceptBtn: {
      flex: 2,
      height: 54,
      borderRadius: 12,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    acceptText: { color: colors.primary, fontSize: 16, fontWeight: '800' },
  });
}
