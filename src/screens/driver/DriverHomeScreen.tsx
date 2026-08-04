import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, SafeAreaView, TouchableOpacity, Switch, Platform, Alert, Dimensions } from 'react-native';
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RootStackParamList } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import { AppTheme } from '../../constants/theme';
import { useAuth } from '../../hooks/useAuth';
import { useScheduledRides } from '../../hooks/useRide';
import { useDriverRideContext } from '../../contexts/DriverRideContext';
import { formatCurrency, formatDistance } from '../../lib/format';
import { rideOrigin, rideDestination } from '../../lib/ride';
import { useTranslation } from '../../i18n';
import { CarMarker } from '../../components/common/CarMarker';
import { CrosshairIcon } from '../../components/common/CrosshairIcon';
import { ScheduledRideBanner } from '../../components/common/ScheduledRideBanner';
import { DutyStatusBanner } from '../../components/driver/DutyStatusBanner';
import { useUpcomingScheduledRide } from '../../hooks/useUpcomingScheduledRide';
import { useScheduledReminderAlert } from '../../hooks/useScheduledReminderAlert';
import { useScheduledOfferAlert } from '../../hooks/useScheduledOfferAlert';
import { useRideCallAlert } from '../../hooks/useRideCallAlert';
import { useDrivingLimit } from '../../hooks/useDrivingLimit';
import { useBackgroundCheck } from '../../hooks/useBackgroundCheck';
import { useDriverOnboardingGate } from '../../hooks/useDriverOnboardingGate';
import { useCameraController } from '../../hooks/useCameraController';
import { useFeatureFlag } from '../../hooks/useFeatureFlag';
import {
  advanceHeading,
  initialHeadingState,
  topPaddingForAnchor,
  DEFAULT_COURSE_UP,
  type HeadingState,
} from '../../lib/nav/courseUp';
import { zoomForSpeed } from '../../lib/nav/follow';
import { supabase } from '../../lib/supabase';

type Props = { navigation: NativeStackNavigationProp<RootStackParamList, 'DriverTabs'> };

export function DriverHomeScreen({ navigation }: Props) {
  const { profile } = useAuth();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  // Estado online/localização/assinatura de corridas agora vive em um Provider
  // único (DriverRideContext), montado fora da Stack.Navigator — sobrevive à
  // navegação entre telas e é a mesma instância usada por GlobalDriverRideOverlay.
  const {
    isOnline, setIsOnline, location, pendingRide, pendingScheduledRide, setPendingScheduledRide,
    confirmScheduledRide, confirmQrScheduledRide, rejectScheduledRide, dutyIdleSegments,
    dutyMovementEnabled, dutyMovementMinutes,
  } = useDriverRideContext();
  // Agendamento travado por QR (o passageiro escolheu este motorista pelo
  // código dele): diferente do pool aberto, aqui `driver_id` já vem preenchido
  // desde a criação — usamos isso para diferenciar o banner e o alerta sonoro.
  const isQrLockedSchedule = !!pendingScheduledRide?.driver_id;
  // P2: próxima corrida agendada confirmada por mim → banner fixo + alerta sonoro.
  const upcoming = useUpcomingScheduledRide(profile?.id);
  useScheduledReminderAlert(upcoming.imminent, upcoming.ride?.id ?? null);
  // `activate` inicia a rota de fato (muda status da corrida) quando o
  // motorista toca no banner fixo — só usamos essa função do hook (a lista
  // interna dele é por passenger_id e não nos interessa aqui).
  const { activate: activateScheduledRide } = useScheduledRides(profile?.id, profile?.jurisdiction);
  const [startingBannerRide, setStartingBannerRide] = useState(false);
  // Item #4: sinal sonoro DISTINTO (arpejo, toca uma vez) para o pool aberto.
  useScheduledOfferAlert(!isQrLockedSchedule ? (pendingScheduledRide?.id ?? null) : null);
  // Agendamento travado por QR: alerta RECORRENTE (mesmo som/vibração da
  // chamada de corrida imediata) até o motorista aceitar ou recusar — o
  // passageiro escolheu este motorista especificamente, então a notificação
  // precisa insistir, não apenas tocar uma vez.
  useRideCallAlert(isQrLockedSchedule, isQrLockedSchedule ? (pendingScheduledRide?.id ?? null) : null);
  // P3: limite de direção (12h) + descanso obrigatório (6h), configurável.
  // Item 1: passa os segmentos ociosos do turno (veículo parado) para que a
  // contagem só corra com o veículo em movimento.
  // Bloco 2: com a flag `duty_movement_v2_enabled` ligada, a contagem por
  // movimento (persistida, sobrevive a kill/reboot) vira a fonte autoritativa do
  // acúmulo de direção; desligada → mantém o cálculo v1 (sessão − ociosidade).
  const duty = useDrivingLimit(
    profile?.id,
    dutyIdleSegments,
    dutyMovementEnabled ? dutyMovementMinutes : null,
    // Reconciliação: quando a tela já mostra "Offline" mas uma sessão ficou
    // presa aberta no banco (falha de rede em endSession(), app morto etc.),
    // o hook fecha essa sessão órfã sozinho — sem isso, o descanso obrigatório
    // nunca "andava" com o tempo realmente offline (ver useDrivingLimit.ts).
    isOnline,
  );
  const bgCheck = useBackgroundCheck(profile?.id);
  // Bloco 3 (compliance TNC F.S. 627.748): gates NOVOS deste bloco — desqualificação
  // já persistida, recheck trienal e disclosure legal. O gate de verificação/Stripe
  // já existente acima permanece como está (evita duplicar o mesmo aviso por dois
  // caminhos); aqui só usamos os motivos que ainda não têm um `if` próprio.
  const onboardingGate = useDriverOnboardingGate();
  const [confirming, setConfirming] = useState(false);
  const mapRef = useRef<MapView>(null);
  // Bloco 1: toda câmera passa pelo CameraController (valida coord + clampa zoom).
  const cam = useCameraController(mapRef, 'DriverHome');
  // Course-up estilo Waze também no mapa OCIOSO da home: a câmera gira conforme
  // o deslocamento (mapa "desce" sob o carro, seta sempre apontando pra frente),
  // não só na tela de navegação durante a corrida. Guardado pela mesma flag
  // `nav_course_up_enabled` (ligada por padrão) para rollback imediato: off →
  // volta ao mapa north-up com a setinha girando.
  const courseUpEnabled = useFeatureFlag('nav_course_up_enabled');
  const courseUpRef = useRef(courseUpEnabled);
  courseUpRef.current = courseUpEnabled;
  const { height: screenH } = Dimensions.get('window');
  // Rumo suavizado (passa-baixa + congela parado), reaproveitado da lib de nav.
  const headingStateRef = useRef<HeadingState>(initialHeadingState);
  // Câmera "drone" segue o carro; PAUSA quando o motorista arrasta o mapa e
  // volta ao tocar em "recentralizar".
  const followingRef = useRef(true);
  const [following, setFollowing] = useState(true);
  // O MKMapView (iOS) só aceita comandos de câmera após onMapReady — antes disso
  // animateCamera estoura o zoom pro mundo (mesmo bug já tratado na navegação).
  const [mapReady, setMapReady] = useState(false);

  // Pose da câmera para a posição atual: course-up (heading + pitch + zoom por
  // velocidade) quando a flag está ligada; senão, north-up com zoom fixo.
  const cameraPose = () =>
    courseUpRef.current
      ? { heading: headingStateRef.current.smoothed, pitch: DEFAULT_COURSE_UP.pitch, zoom: zoomForSpeed(location?.speed) }
      : { zoom: 16 };

  // Câmera drone course-up: a cada fix, avança o rumo suavizado e (se estiver
  // "seguindo") reposiciona a câmera girando o mapa para o sentido do movimento.
  useEffect(() => {
    if (!location || !mapReady) return;
    headingStateRef.current = advanceHeading(headingStateRef.current, location.speed, location.heading);
    if (followingRef.current) {
      cam.follow({ lat: location.lat, lng: location.lng }, cameraPose(), 700);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location?.lat, location?.lng, location?.speed, location?.heading, mapReady, courseUpEnabled]);

  // Motorista arrastou/deu pinch no mapa → pausa o follow (deixa explorar sem a
  // câmera "brigar"); o botão de recentralizar reata.
  function pauseFollow() {
    if (!followingRef.current) return;
    followingRef.current = false;
    setFollowing(false);
  }

  // Nome do passageiro do agendamento pendente — mesmo padrão já usado em
  // IncomingRideCall.tsx para a chamada imediata (fetch pontual em profiles,
  // já que rides/rides_with_locations não carregam esse dado).
  const [pendingScheduledPassengerName, setPendingScheduledPassengerName] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const passengerId = pendingScheduledRide?.passenger_id;
    if (!passengerId) {
      setPendingScheduledPassengerName(null);
      return;
    }
    supabase
      .from('profiles_public')
      .select('full_name')
      .eq('id', passengerId)
      .single()
      .then(({ data }) => {
        if (!alive) return;
        setPendingScheduledPassengerName((data as { full_name?: string } | null)?.full_name ?? null);
      });
    return () => { alive = false; };
  }, [pendingScheduledRide?.passenger_id]);
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
    if (!location) return;
    followingRef.current = true;
    setFollowing(true);
    cam.follow({ lat: location.lat, lng: location.lng }, cameraPose(), 300);
  }

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
      duty.endSession();
    }
    if (!duty.status.mustRest) forcedRestRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline, duty.status.mustRest]);

  // Alterna online/offline e persiste a escolha.
  // Só permite ficar online se a verificação (selfie + documento) já tiver
  // sido aprovada pela equipe — duplo grau de conferência antes de aceitar corridas.
  function handleOnlineChange(val: boolean) {
    // Bloco 4: suspensão de tolerância zero (driver_suspensions) — checada
    // primeiro de propósito, mesma prioridade do servidor em
    // driver_can_go_online() (migration 0060, checada antes do early-return
    // do Bloco 3). Sem botão de ação: exige contato com o suporte.
    if (val && onboardingGate.reasons.includes('safety_suspension')) {
      Alert.alert(t('driver.suspendedTitle'), t('driver.suspendedBody'));
      return;
    }
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
    // Bloco 3: achado desqualificante já apurado (bane vitalício/limiar — ver
    // disqualificationRules.ts). Sem botão de ação: é uma decisão que exige contato
    // com o suporte, não algo que o motorista resolve sozinho no app.
    if (val && onboardingGate.reasons.includes('background_check_disqualified')) {
      Alert.alert(t('driver.disqualifiedTitle'), t('driver.disqualifiedBody'));
      return;
    }
    // Bloco 3: recheck trienal vencido — teto independente da validade operacional
    // do check (ver ambiguidade documentada em driverOnboardingGate.ts).
    if (val && onboardingGate.reasons.includes('background_check_recheck_due')) {
      Alert.alert(t('driver.recheckDueTitle'), t('driver.recheckDueBody'));
      return;
    }
    // Stripe Connect: só pode ficar online com a conta de repasse habilitada
    // (charges + payouts). O backend também força isso (trigger em
    // driver_locations) — aqui é só o aviso amigável direcionando ao onboarding.
    if (val && !(profile?.stripe_charges_enabled && profile?.stripe_payouts_enabled)) {
      Alert.alert(
        t('driver.payoutSetupRequiredTitle', 'Finish payout setup'),
        t('driver.payoutSetupRequiredBody', 'Complete your Stripe payout onboarding before going online so you can get paid.'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('driver.payoutSetupGo', 'Set up payouts'), onPress: () => navigation.navigate('DriverTabs', { screen: 'Ganhos' } as never) },
        ]
      );
      return;
    }
    // Bloco 3: aceite do disclosure legal (driver_disclosure_acceptances) — quando
    // a jurisdição exige, leva o motorista direto para a tela de revisão/aceite.
    if (val && onboardingGate.reasons.includes('disclosure_not_accepted')) {
      Alert.alert(
        t('driver.disclosureRequiredTitle'),
        t('driver.disclosureRequiredBody'),
        [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('driver.disclosureGo'), onPress: () => navigation.navigate('Disclosure') },
        ]
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
    // Abre/fecha a sessão de serviço que alimenta o cálculo do limite (P3).
    if (val) duty.startSession();
    else duty.endSession();
  }

  async function handleConfirmScheduled() {
    if (!pendingScheduledRide) return;
    setConfirming(true);
    // Agendamento travado por QR já tem driver_id — só falta gravar accepted_at
    // (confirmQrScheduledRide); o pool aberto ainda precisa reivindicar (confirmScheduledRide).
    const ok = isQrLockedSchedule
      ? await confirmQrScheduledRide(pendingScheduledRide.id)
      : await confirmScheduledRide(pendingScheduledRide.id);
    setConfirming(false);
    if (ok) {
      // Item #5: após confirmar, fecha o banner e volta para o mapa principal,
      // deixando o motorista livre para aguardar novas corridas. A agendada
      // confirmada reaparece no banner fixo (useUpcomingScheduledRide).
      setPendingScheduledRide(null);
      Alert.alert(t('driverHome.rideConfirmedTitle'), t('driverScheduled.confirmedMessage'));
    } else {
      Alert.alert(t('driverScheduled.oops'), isQrLockedSchedule ? t('driverHome.qrConfirmFailed') : t('driverScheduled.alreadyClaimedMessage'));
      setPendingScheduledRide(null);
    }
  }

  // Recusa do banner de agendamento. No pool aberto a corrida ainda não tem
  // motorista vinculado — só dispensar o banner é suficiente. Já no caso
  // travado por QR, o `driver_id` já está gravado no banco: é preciso liberar
  // a corrida de volta (rejectScheduledRide) para que outro motorista possa
  // recebê-la, e avisar o passageiro que este motorista não confirmou.
  async function handleRejectScheduled() {
    if (!pendingScheduledRide) return;
    if (isQrLockedSchedule) {
      await rejectScheduledRide(pendingScheduledRide.id);
    }
    setPendingScheduledRide(null);
  }

  // Toque no banner fixo de corrida agendada: inicia a rota de verdade
  // (muda o status da corrida) em vez de só abrir a lista — é isso que faz
  // o banner sumir (a corrida deixa de ser 'scheduled').
  async function handleStartScheduledFromBanner() {
    if (!upcoming.ride || startingBannerRide) return;
    setStartingBannerRide(true);
    const activated = await activateScheduledRide(upcoming.ride.id);
    setStartingBannerRide(false);
    if (activated) {
      navigation.navigate('DriverNavigate', {
        ride: activated,
        initialDriverLocation: location ? { lat: location.lat, lng: location.lng } : undefined,
      });
    } else {
      Alert.alert(t('driverScheduled.oops'), t('driverHome.startRouteFailed'));
    }
  }

  const firstName = profile?.full_name?.split(' ')[0] ?? t('driverHome.driverFallback');

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
        onMapReady={() => {
          cam.setReady(true);
          setMapReady(true);
        }}
        // Course-up (Waze): o próprio mapa gira para a direção do movimento, então
        // desabilitamos os gestos de rotação/pitch do usuário e ancoramos o carro no
        // terço inferior da tela via mapPadding (o mapa "desce" sob o carro).
        rotateEnabled={false}
        pitchEnabled={false}
        onPanDrag={pauseFollow}
        onRegionChangeComplete={(_r, d) => {
          if (d?.isGesture) pauseFollow();
        }}
        // Âncora do carro no TERÇO INFERIOR — SEMPRE, independente das flags de
        // rollout. Mantém o cursor fixo embaixo com o mapa descendo sob ele.
        mapPadding={{
          top: topPaddingForAnchor(screenH),
          right: 0,
          bottom: 0,
          left: 0,
        }}
      >
        {location && (
          <Marker
            coordinate={{ latitude: location.lat, longitude: location.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            tracksViewChanges={tracksCar}
          >
            {/* Em course-up o mapa já está girado para a direção, então a seta fica
                fixa apontando "pra frente do celular" (heading=0). Sem course-up, a
                seta gira conforme o rumo do GPS. */}
            <CarMarker scale={0.85} heading={courseUpEnabled ? 0 : (location.heading ?? 0)} />
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
            onPress={handleStartScheduledFromBanner}
          />
        )}

        {!pendingRide && <DutyStatusBanner status={duty.status} warn={duty.warn} />}

      </SafeAreaView>

      {pendingScheduledRide && !pendingRide && (
        <View style={[styles.rideRequestSheet, { paddingBottom: Math.max(insets.bottom, 16) + 16 }]}>
          <View style={styles.requestHandle} />

          <View style={styles.scheduledHeader}>
            <Text style={styles.scheduledIcon}>{isQrLockedSchedule ? '📲' : '🗓️'}</Text>
            <View>
              <Text style={styles.requestTitle}>
                {isQrLockedSchedule ? t('driverHome.qrScheduleTitle') : t('driverHome.scheduledRideTitle')}
              </Text>
              {pendingScheduledRide.scheduled_for && (
                <Text style={styles.scheduledWhen}>
                  {new Date(pendingScheduledRide.scheduled_for).toLocaleDateString('en-US', { day: '2-digit', month: 'short' })}
                  {` ${t('driverHome.dateTimeSeparator')} `}
                  {new Date(pendingScheduledRide.scheduled_for).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                </Text>
              )}
            </View>
          </View>

          <View style={styles.requestDetails}>
            <View style={styles.requestRow}>
              <Text style={styles.requestIcon}>👤</Text>
              <View>
                <Text style={styles.requestLabel}>{t('driverCall.passenger')}</Text>
                <Text style={styles.requestAddr} numberOfLines={1}>{pendingScheduledPassengerName ?? t('driverScheduled.passengerFallback')}</Text>
              </View>
            </View>
            <View style={styles.requestDivider} />
            <View style={styles.requestRow}>
              <Text style={styles.requestIcon}>📍</Text>
              <View>
                <Text style={styles.requestLabel}>{t('driverHome.originLabel')}</Text>
                <Text style={styles.requestAddr} numberOfLines={1}>{rideOrigin(pendingScheduledRide).address}</Text>
              </View>
            </View>
            <View style={styles.requestDivider} />
            <View style={styles.requestRow}>
              <Text style={styles.requestIcon}>🏁</Text>
              <View>
                <Text style={styles.requestLabel}>{t('driverHome.destinationLabel')}</Text>
                <Text style={styles.requestAddr} numberOfLines={1}>{rideDestination(pendingScheduledRide).address}</Text>
              </View>
            </View>
          </View>

          <View style={styles.requestMeta}>
            <View style={styles.metaItem}>
              <Text style={styles.metaValue}>{formatDistance(pendingScheduledRide.distance_km)}</Text>
              <Text style={styles.metaLabel}>{t('driverHome.distanceLabel')}</Text>
            </View>
            <View style={styles.metaDivider} />
            <View style={styles.metaItem}>
              <Text style={styles.metaValue}>{pendingScheduledRide.duration_min} {t('driverNav.minUnit')}</Text>
              <Text style={styles.metaLabel}>{t('driverHome.durationLabel')}</Text>
            </View>
            <View style={styles.metaDivider} />
            <View style={styles.metaItem}>
              <Text style={[styles.metaValue, styles.priceValue]}>{formatCurrency(pendingScheduledRide.price)}</Text>
              <Text style={styles.metaLabel}>{t('driverHome.valueLabel')}</Text>
            </View>
          </View>

          <View style={styles.requestActions}>
            <TouchableOpacity
              style={styles.declineBtn}
              onPress={handleRejectScheduled}
            >
              <Text style={styles.declineText}>{t('driverHome.declineBtn')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.acceptBtn, confirming && { opacity: 0.7 }]}
              onPress={handleConfirmScheduled}
              disabled={confirming}
            >
              <Text style={styles.acceptText}>{confirming ? t('driverHome.confirming') : t('driverScheduled.confirm')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* O Modal de chamada de corrida (IncomingRideCall) agora é renderizado
       *  globalmente por <GlobalDriverRideOverlay>, fora da Stack.Navigator —
       *  veja AppNavigator.tsx e DriverRideContext.tsx. Isso garante que o
       *  banner apareça mesmo com o motorista em outra tela (Agenda, Navegação
       *  etc.), já que react-native-screens "congela" telas para trás na pilha. */}
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
