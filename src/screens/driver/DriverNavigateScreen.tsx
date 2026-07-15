import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity,
  Platform, Alert, Image, Dimensions,
} from 'react-native';
import MapView, { Marker, MarkerAnimated, AnimatedRegion, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useIsFocused } from '@react-navigation/native';
import { RootStackParamList, Ride, RideStatus } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import { AppTheme } from '../../constants/theme';
import { Button } from '../../components/common/Button';
import { useDriverRide, notifyPassengerRideCompleted } from '../../hooks/useRide';
import { useAuth } from '../../hooks/useAuth';
import { useNavigationLocation } from '../../hooks/useNavigationLocation';
import { simulateRouteFixes, SimFix } from '../../lib/nav/simulator';
import {
  fromMapCoord, toMapCoord, LatLng,
  nearestPointOnPath, splitPathAtSnap, shortestAngleDelta, haversineMeters,
} from '../../lib/nav/geo';
import { zoomForSpeed, updateOffRoute, initialOffRouteState, OffRouteState } from '../../lib/nav/follow';
import {
  advanceHeading,
  initialHeadingState,
  topPaddingForAnchor,
  DEFAULT_COURSE_UP,
  type HeadingState,
} from '../../lib/nav/courseUp';
import { useCameraController } from '../../hooks/useCameraController';
import { useFeatureFlag } from '../../hooks/useFeatureFlag';
import { useRoute as useRideRoute } from '../../hooks/useRoute';
import { useChatAlert } from '../../hooks/useChatAlert';
import { formatCurrency } from '../../lib/format';
import { rideOrigin, rideDestination } from '../../lib/ride';
import { RouteStep } from '../../lib/routing';
import { CarMarker } from '../../components/common/CarMarker';
import { supabase } from '../../lib/supabase';
import { useTranslation } from '../../i18n';

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'DriverNavigate'>;
  route: RouteProp<RootStackParamList, 'DriverNavigate'>;
};

type Phase = 'pickup' | 'dropoff';

// ─── Helpers de navegação ────────────────────────────────────────────────────

function maneuverArrow(type: string, modifier?: string): string {
  if (type === 'arrive') return '🏁';
  if (type === 'roundabout' || type === 'rotary') return '↻';
  if (type === 'fork') {
    return modifier?.includes('right') ? '↗' : '↖';
  }
  if (type === 'on ramp' || type === 'off ramp') {
    return modifier?.includes('left') ? '↖' : '↗';
  }
  switch (modifier) {
    case 'uturn':       return '↩';
    case 'sharp right': return '→';
    case 'right':       return '→';
    case 'slight right':return '↗';
    case 'straight':    return '↑';
    case 'slight left': return '↖';
    case 'left':        return '←';
    case 'sharp left':  return '←';
    default:            return '↑';
  }
}

function maneuverColor(type: string, modifier: string | undefined, colors: AppTheme): string {
  if (type === 'arrive') return colors.success;
  if (type === 'roundabout' || type === 'rotary') return '#7C3AED';
  if (modifier === 'left' || modifier === 'sharp left' || modifier === 'slight left') return '#2563EB';
  if (modifier === 'right' || modifier === 'sharp right' || modifier === 'slight right') return '#2563EB';
  return colors.primary;
}

// Retorna a CHAVE de tradução da ação (resolvida com t() no componente) + a rua crua.
function maneuverInstruction(type: string, modifier?: string, name?: string): { actionKey: string; street: string } {
  const street = name || '';
  if (type === 'arrive')    return { actionKey: 'driverNav.maneuverArrive', street };
  if (type === 'depart')    return { actionKey: 'driverNav.maneuverDepart', street };
  if (type === 'roundabout' || type === 'rotary') return { actionKey: 'driverNav.maneuverRoundabout', street };
  if (type === 'fork')      return { actionKey: modifier?.includes('right') ? 'driverNav.maneuverKeepRight' : 'driverNav.maneuverKeepLeft', street };
  if (type === 'merge')     return { actionKey: 'driverNav.maneuverMerge', street };
  if (type === 'on ramp')   return { actionKey: 'driverNav.maneuverOnRamp', street };
  if (type === 'off ramp')  return { actionKey: 'driverNav.maneuverOffRamp', street };
  if (type === 'end of road') return { actionKey: modifier?.includes('right') ? 'driverNav.maneuverTurnRight' : 'driverNav.maneuverTurnLeft', street };
  switch (modifier) {
    case 'uturn':        return { actionKey: 'driverNav.maneuverUturn', street };
    case 'sharp right':  return { actionKey: 'driverNav.maneuverSharpRight', street };
    case 'right':        return { actionKey: 'driverNav.maneuverTurnRight', street };
    case 'slight right': return { actionKey: 'driverNav.maneuverSlightRight', street };
    case 'straight':     return { actionKey: 'driverNav.maneuverStraight', street };
    case 'slight left':  return { actionKey: 'driverNav.maneuverSlightLeft', street };
    case 'left':         return { actionKey: 'driverNav.maneuverTurnLeft', street };
    case 'sharp left':   return { actionKey: 'driverNav.maneuverSharpLeft', street };
    default:             return { actionKey: 'driverNav.maneuverContinue', street };
  }
}

// Retorna { nowKey } quando muito perto (resolvido com t() no componente) ou o texto formatado.
function formatStepDist(meters: number): { nowKey: string } | string {
  if (meters < 30)   return { nowKey: 'driverNav.distNow' };
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

// ─── Componente ──────────────────────────────────────────────────────────────

export function DriverNavigateScreen({ navigation, route }: Props) {
  const { ride, initialDriverLocation } = route.params;
  const { t } = useTranslation();
  const { profile } = useAuth();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  // Simulação (só em DEV): grava um snapshot da rota atual e "dirige" por ela,
  // 1 fix/s, sem GPS — valida a fluidez do marcador/câmera no emulador.
  const [simFixes, setSimFixes] = useState<SimFix[] | null>(null);
  // Fonte de localização de MÁXIMA precisão já suavizada (Kalman + heading
  // veicular) — substitui o useLocation genérico só nesta tela de navegação.
  const { fix: location } = useNavigationLocation({ enabled: true, simulate: simFixes, simulateIntervalMs: 1000 });

  const { updateRideStatus, refundRide } = useDriverRide(profile?.id);
  const lastUploadedCoord = useRef<{ lat: number; lng: number } | null>(null);
  const isFocused = useIsFocused();
  // Inicializa a partir do status real da corrida (não sempre 'pickup') —
  // essencial para o caso de retomada (app relançado com a corrida já
  // in_progress): sem isto, a tela reiniciava sempre na fase de embarque,
  // mesmo que o motorista já estivesse a caminho do destino.
  const [phase, setPhase] = useState<Phase>(() => (ride.status === 'in_progress' ? 'dropoff' : 'pickup'));
  const [loading, setLoading] = useState(false);
  const { height: screenH } = Dimensions.get('window');

  // ── Animação do marcador (posição suave, SEM teleporte) ─────────────────────
  // O marcador do carro é um MarkerAnimated preso a esta AnimatedRegion; cada
  // fix ANIMA a região da posição atual até a nova (a lib move o marcador
  // nativamente, sem re-render do React). Semeia na posição já conhecida do
  // aceite (ou no ponto de embarque) para não abrir no meio do oceano.
  const carRegion = useRef(
    new AnimatedRegion({
      latitude: (initialDriverLocation ?? rideOrigin(ride)).lat,
      longitude: (initialDriverLocation ?? rideOrigin(ride)).lng,
      latitudeDelta: 0,
      longitudeDelta: 0,
    }),
  ).current;
  const hasFixRef = useRef(false);
  // Deixa o marcador repintar (tracksViewChanges) só no primeiro fix; depois
  // congela — a POSIÇÃO já é animada nativamente, não precisa repintar a cada fix.
  const [markerReady, setMarkerReady] = useState(false);
  // Rumo CONTÍNUO (desenrolado): acumula deltas mínimos para a câmera girar
  // sempre pelo caminho angular mais curto (ex.: 359°→1° gira +2°, não -358°).
  const prevHeadingRef = useRef<number | null>(null);
  const contHeadingRef = useRef(0);
  const lastFixTsRef = useRef<number | null>(null);
  // Bloco 3 (course-up estilo Waze): quando ligado, o rumo da câmera vem do
  // curso do GPS só acima de 4 km/h (congela parado) + filtro passa-baixa
  // (sem jitter/saltos de 180°). Quando desligado (flag OFF), mantém o rumo
  // contínuo cru legado (contHeadingRef). O estado abaixo sobrevive entre fixes.
  const courseUpEnabled = useFeatureFlag('nav_course_up_enabled');
  const courseUpRef = useRef(courseUpEnabled);
  courseUpRef.current = courseUpEnabled;
  const headingStateRef = useRef<HeadingState>(initialHeadingState);
  // Câmera "drone" segue o carro; PAUSA quando o motorista arrasta o mapa e
  // volta ao tocar em "recentralizar".
  const followingRef = useRef(true);
  const [following, setFollowing] = useState(true);
  // Divisão da rota em [percorrido] (cinza) × [restante] (colorido), recalculada
  // a cada fix pelo ponto mais próximo na polyline.
  const [routeSplit, setRouteSplit] = useState<{ traveled: LatLng[]; remaining: LatLng[] } | null>(null);
  const offRouteRef = useRef<OffRouteState>(initialOffRouteState);

  const styles = makeStyles(colors);

  // Nome do passageiro para o título do chat — a corrida chega aqui vinda do
  // fluxo de aceite imediato (acceptRide/useRide.ts), que retorna só as
  // colunas cruas da tabela `rides` (sem join em profiles). Busca local,
  // mesmo padrão usado em DriverHomeScreen.tsx para o popup de agendamento.
  const [passengerName, setPassengerName] = useState<string | null>(null);
  const [passengerAvatar, setPassengerAvatar] = useState<string | null>(null);
  const [passengerRating, setPassengerRating] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    if (!ride.passenger_id) return;
    supabase
      .from('profiles_public')
      .select('full_name, avatar_url, rating')
      .eq('id', ride.passenger_id)
      .single()
      .then(({ data }) => {
        if (!alive) return;
        const p = data as { full_name?: string; avatar_url?: string | null; rating?: number | null } | null;
        setPassengerName(p?.full_name ?? null);
        setPassengerAvatar(p?.avatar_url ?? null);
        setPassengerRating(p?.rating ?? null);
      });
    return () => { alive = false; };
  }, [ride.passenger_id]);

  useChatAlert(ride.id, profile?.id, isFocused, t('driverNav.passenger'));

  useEffect(() => {
    if (!location || markerReady) return;
    const t = setTimeout(() => setMarkerReady(true), 800);
    return () => clearTimeout(t);
  }, [location, markerReady]);

  const origin = rideOrigin(ride);
  const dest   = rideDestination(ride);
  const target = phase === 'pickup' ? origin : dest;

  // Publica posição do motorista em driver_locations (passageiro vê em tempo real)
  useEffect(() => {
    if (!location || !profile?.id) {
      console.log('[GOXL loc] skip — location?', !!location, 'profile?', !!profile?.id);
      return;
    }
    const prev = lastUploadedCoord.current;
    // Só grava se mover > 30 m (evita flood de writes)
    if (prev && haversineMeters(prev, location) < 30) return;
    lastUploadedCoord.current = { lat: location.lat, lng: location.lng };
    supabase.from('driver_locations').upsert({
      driver_id: profile.id,
      lat: location.lat,
      lng: location.lng,
      heading: location.heading ?? null,
      is_online: true,
      updated_at: new Date().toISOString(),
    }).then(({ error }) => {
      console.log(error ? '[GOXL loc] upsert ERROR: ' + error.message : '[GOXL loc] upsert OK');
    });
  }, [location?.lat, location?.lng, profile?.id]);

  // Throttle: recalcula rota só se mover > 150 m
  const lastRouteCoord = useRef<{ lat: number; lng: number } | null>(null);
  // Semeia a origem da rota com a localização já capturada no momento do
  // aceite (passada via navigation params) — assim o mapa traça o caminho
  // até o passageiro IMEDIATAMENTE ao abrir a tela, sem esperar o novo fix
  // de GPS deste hook (que pode levar 1-2s para resolver permissão + posição).
  const [routeOrigin, setRouteOrigin] = useState(
    location
      ? { lat: location.lat, lng: location.lng }
      : initialDriverLocation ?? null
  );
  const mapRef = useRef<MapView>(null);
  // O MKMapView nativo (iOS) só fica pronto para receber comandos de câmera
  // depois de `onMapReady` — `mapRef.current` já existe antes disso, então
  // chamar animateCamera nessa janela é causa conhecida do mapa "explodir"
  // pro zoom do continente/mundo inteiro e travar os gestos (mesmo bug já
  // corrigido em ActiveRideScreen.tsx). As duas chamadas de animateCamera
  // abaixo esperam este flag.
  const [mapReady, setMapReady] = useState(false);
  // Bloco 1: TODA atualização de câmera desta tela passa pelo CameraController
  // (valida coordenada, faz clamp de zoom, mantém a última câmera válida e loga
  // rejeições). Substitui as chamadas diretas a mapRef.animateCamera abaixo.
  const cam = useCameraController(mapRef, 'DriverNavigate');

  useEffect(() => {
    if (!location) return;
    const prev = lastRouteCoord.current;
    if (!prev) {
      lastRouteCoord.current = { lat: location.lat, lng: location.lng };
      setRouteOrigin({ lat: location.lat, lng: location.lng });
      return;
    }
    if (haversineMeters(prev, location) > 150) {
      lastRouteCoord.current = { lat: location.lat, lng: location.lng };
      setRouteOrigin({ lat: location.lat, lng: location.lng });
    }
  }, [location?.lat, location?.lng]);

  // ── Marcador + câmera drone (estilo Waze) ───────────────────────────────────
  // A cada fix: (1) ANIMA o marcador da posição atual até a nova (nunca
  // teleporta) e (2) reposiciona a câmera em perspectiva (pitch 45°, zoom por
  // velocidade, heading-up). Ambas com a MESMA duração (o intervalo entre
  // fixes), para ficarem em sincronia. Nada aqui reconstrói o mapa — só move
  // marcador e câmera; iniciar uma nova animação cancela a anterior pendente.
  useEffect(() => {
    if (!location) return;
    const now = location.timestampMs;
    const prevTs = lastFixTsRef.current;
    lastFixTsRef.current = now;
    const dt = prevTs != null ? Math.max(400, Math.min(1200, now - prevTs)) : 0;

    // (1) posição do marcador — primeiro fix crava (sem glide de um seed velho).
    if (!hasFixRef.current) {
      carRegion.setValue({ latitude: location.lat, longitude: location.lng, latitudeDelta: 0, longitudeDelta: 0 });
      hasFixRef.current = true;
    } else {
      carRegion
        // A tipagem da lib exige toValue/useNativeDriver, mas o AnimatedRegion
        // usa mesmo é latitude/longitude — daí o cast pontual.
        .timing({
          latitude: location.lat,
          longitude: location.lng,
          latitudeDelta: 0,
          longitudeDelta: 0,
          duration: dt || 1000,
          useNativeDriver: false,
          toValue: 0,
        } as any)
        .start();
    }

    // (2) rumo contínuo (desenrolado) para a câmera girar pelo caminho mais curto.
    // Legado (flag OFF): rumo cru a cada fix. Course-up (flag ON): congela parado
    // (< 4 km/h) + passa-baixa (headingStateRef), estilo Waze.
    if (prevHeadingRef.current == null) {
      contHeadingRef.current = location.heading;
    } else {
      contHeadingRef.current += shortestAngleDelta(prevHeadingRef.current, location.heading);
    }
    prevHeadingRef.current = location.heading;
    headingStateRef.current = advanceHeading(
      headingStateRef.current,
      location.speed,
      location.heading,
    );
    const heading = courseUpRef.current
      ? headingStateRef.current.smoothed
      : contHeadingRef.current;

    // (3) câmera drone — só quando "seguindo" (pausada durante arrasto do mapa)
    // e com o MKMapView/GoogleMap nativo já pronto (ver comentário no
    // `mapReady`, acima) — sem isso o iOS pode estourar o zoom pro mundo todo.
    if (followingRef.current) {
      cam.follow(
        { lat: location.lat, lng: location.lng },
        { heading, pitch: DEFAULT_COURSE_UP.pitch, zoom: zoomForSpeed(location.speed) },
        dt || 700,
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location?.timestampMs, mapReady]);

  const { route: path } = useRideRoute(
    routeOrigin,
    { lat: target.lat, lng: target.lng }
  );

  // ── Snap na rota: separa percorrido/restante + dispara re-rota por desvio ────
  // A cada fix, projeta o carro na polyline: o trecho antes do ponto vira
  // "percorrido" (cinza, some) e o depois "restante" (colorido). Se o desvio da
  // rota passar de 40 m por 5 s contínuos, recalcula a rota a partir da posição
  // atual (mesmo throttle/estado do útil nav/follow, testado à parte).
  useEffect(() => {
    const coords = path?.coordinates;
    if (!location || !coords || coords.length < 2) {
      setRouteSplit(null);
      return;
    }
    const lite = coords.map(fromMapCoord);
    const snap = nearestPointOnPath({ lat: location.lat, lng: location.lng }, lite);
    if (!snap) {
      setRouteSplit(null);
      return;
    }
    const { traveled, remaining } = splitPathAtSnap(lite, snap);
    setRouteSplit({ traveled: traveled.map(toMapCoord), remaining: remaining.map(toMapCoord) });

    const r = updateOffRoute(offRouteRef.current, snap.distanceM, Date.now());
    offRouteRef.current = r.state;
    if (r.reroute) {
      lastRouteCoord.current = { lat: location.lat, lng: location.lng };
      setRouteOrigin({ lat: location.lat, lng: location.lng });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location?.lat, location?.lng, path]);

  // Passos da rota (turn-by-turn)
  const steps: RouteStep[] = path?.steps ?? [];
  // steps[0] = instrução atual (de onde estou → próxima manobra)
  // steps[1..] = próximas manobras
  const currentStep   = steps[0] ?? null;

  // Fallback: enquanto a rota local (OSRM) ainda não carregou, usa o ETA já
  // calculado no momento do aceite (acceptRide) — assim o motorista vê o tempo
  // estimado imediatamente ao abrir a tela, em vez de esperar o GPS+rota.
  const fallbackEtaMin = phase === 'pickup' ? (ride.driver_eta_min ?? null) : null;
  const etaMinDisplay = path?.durationMin ?? fallbackEtaMin;

  // ── Grava posição + ETA na própria corrida ────────────────────────────────
  const lastTelemetry = useRef<{ lat: number; lng: number; etaMin?: number } | null>(null);
  useEffect(() => {
    if (!location || !ride.id) {
      console.log('[GOXL tel] skip — location?', !!location, 'rideId?', ride.id);
      return;
    }
    const etaMin = path?.durationMin ?? null;
    const etaKm = path?.distanceKm ?? null;
    const prev = lastTelemetry.current;
    const moved = !prev || haversineMeters(prev, location) >= 30;
    const etaChanged = prev?.etaMin !== (etaMin ?? undefined);
    if (!moved && !etaChanged) return;
    lastTelemetry.current = { lat: location.lat, lng: location.lng, etaMin: etaMin ?? undefined };
    console.log('[GOXL tel] writing', { lat: location.lat, lng: location.lng, etaMin, etaKm, rideId: ride.id });
    supabase.from('rides').update({
      driver_lat: location.lat,
      driver_lng: location.lng,
      driver_heading: location.heading ?? null,
      driver_eta_min: etaMin,
      driver_eta_km: etaKm,
    }).eq('id', ride.id).then(({ error }) => {
      console.log(error ? '[GOXL tel] write ERROR: ' + error.message : '[GOXL tel] write OK');
    });
  }, [location?.lat, location?.lng, path?.durationMin, path?.distanceKm, ride.id]);

  // Detecta cancelamento pelo passageiro por TRÊS caminhos redundantes — o que
  // chegar primeiro vence, e o guard `cancelledHandledRef` garante que o aviso
  // e o reset de navegação aconteçam uma única vez:
  //   1) broadcast `ride_cancelled` no canal pessoal do motorista (Tarefa 4,
  //      entrega direta e confiável em foreground);
  //   2) broadcast `ride_offer_revoked` (motivo 'cancelled') no canal
  //      compartilhado `ride-offers` — mecanismo único das Tarefas 3 e 4;
  //   3) postgres_changes como rede de segurança (pode não disparar no Expo Go
  //      sem REPLICA IDENTITY FULL, mas cobre o caso de app reaberto).
  const cancelledHandledRef = useRef(false);
  useEffect(() => {
    const handlePassengerCancellation = () => {
      if (cancelledHandledRef.current) return;
      cancelledHandledRef.current = true;
      Alert.alert(t('driverNav.rideCancelledTitle'), t('driverNav.rideCancelledByPassenger'));
      navigation.reset({ index: 0, routes: [{ name: 'DriverTabs' }] });
    };

    const pgChannel = supabase
      .channel(`driver-ride-${ride.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rides', filter: `id=eq.${ride.id}` },
        (payload) => {
          if ((payload.new as Ride).status === 'cancelled') handlePassengerCancellation();
        }
      )
      .subscribe();

    const offersChannel = supabase
      .channel('ride-offers')
      .on('broadcast', { event: 'ride_offer_revoked' }, ({ payload }) => {
        if (payload?.rideId === ride.id && payload?.reason === 'cancelled') {
          handlePassengerCancellation();
        }
      })
      .subscribe();

    const personalChannel = profile?.id
      ? supabase
          .channel(`driver-notify-${profile.id}`)
          .on('broadcast', { event: 'ride_cancelled' }, ({ payload }) => {
            if (payload?.rideId === ride.id) handlePassengerCancellation();
          })
          .subscribe()
      : null;

    return () => {
      supabase.removeChannel(pgChannel);
      supabase.removeChannel(offersChannel);
      if (personalChannel) supabase.removeChannel(personalChannel);
    };
  }, [ride.id, profile?.id]);

  function handleCancel() {
    Alert.alert(t('driverNav.cancelRideTitle'), t('driverNav.cancelRideConfirm'), [
      { text: t('driverNav.no'), style: 'cancel' },
      {
        text: t('driverNav.yesCancel'),
        style: 'destructive',
        onPress: async () => {
          // Extorna o pagamento antes de cancelar
          await refundRide(ride.id);
          const ok = await updateRideStatus(ride.id, 'cancelled' as RideStatus);
          if (!ok) {
            // Escrita não confirmada: NÃO sai da tela, senão a corrida fica
            // presa como ativa no banco. O motorista pode tentar de novo.
            Alert.alert(t('common.error'), t('driverNav.statusUpdateFailed'));
            return;
          }
          navigation.reset({ index: 0, routes: [{ name: 'DriverTabs' }] });
        },
      },
    ]);
  }

  async function handleNextPhase() {
    setLoading(true);
    if (phase === 'pickup') {
      const ok = await updateRideStatus(ride.id, 'in_progress' as RideStatus);
      if (!ok) {
        // Sem escrita confirmada não avança de fase — banco e tela ficariam
        // dessincronizados (causa de corrida presa em produção).
        setLoading(false);
        Alert.alert(t('common.error'), t('driverNav.statusUpdateFailed'));
        return;
      }
      setPhase('dropoff');
      // Reseta throttle para recalcular rota ao destino
      lastRouteCoord.current = null;
    } else {
      const ok = await updateRideStatus(ride.id, 'completed' as RideStatus);
      if (!ok) {
        // Idem: não notifica passageiro nem sai da tela sem o banco confirmar.
        setLoading(false);
        Alert.alert(t('common.error'), t('driverNav.statusUpdateFailed'));
        return;
      }
      // Notifica o passageiro (push remoto para app em background)
      notifyPassengerRideCompleted(ride.passenger_id, ride.id, ride.price);
      Alert.alert(
        t('driverNav.rideCompletedTitle'),
        t('driverNav.rideCompletedValue').replace('{value}', formatCurrency(ride.price)),
        [
          { text: t('driverNav.ok'), onPress: () => navigation.reset({ index: 0, routes: [{ name: 'DriverTabs' }] }) },
        ]
      );
    }
    setLoading(false);
  }

  const buttonLabel = phase === 'pickup' ? t('driverNav.pickedUpPassenger') : t('driverNav.finishRide');

  // ── Painel reduzido pós-aceite: cronômetro da corrida + velocidade atual ──
  // Marca o início no momento em que a corrida foi aceita (accepted_at); se por
  // algum motivo não vier preenchido, usa o instante em que esta tela montou.
  const [rideStartMs] = useState(() =>
    ride.accepted_at ? new Date(ride.accepted_at).getTime() : Date.now()
  );
  const [elapsedSec, setElapsedSec] = useState(() => Math.max(0, Math.floor((Date.now() - rideStartMs) / 1000)));
  useEffect(() => {
    const interval = setInterval(() => {
      setElapsedSec(Math.max(0, Math.floor((Date.now() - rideStartMs) / 1000)));
    }, 1000);
    return () => clearInterval(interval);
  }, [rideStartMs]);
  const elapsedLabel = (() => {
    const h = Math.floor(elapsedSec / 3600);
    const m = Math.floor((elapsedSec % 3600) / 60);
    const s = elapsedSec % 60;
    return h > 0
      ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`
      : `${m}:${s.toString().padStart(2, '0')}`;
  })();
  const speedKmh = location?.speed != null ? Math.round(location.speed * 3.6) : null;

  // Confirmação DUPLA antes de avançar de fase (embarque → destino → finalizar):
  // evita toque acidental encerrando/avançando a corrida sem querer.
  function handleNextPhasePress() {
    const isFinal = phase === 'dropoff';
    Alert.alert(
      isFinal ? t('driverNav.finishRideQuestion') : t('driverNav.confirmPickupQuestion'),
      isFinal
        ? t('driverNav.finishRideConfirmMsg')
        : t('driverNav.confirmPickupMsg'),
      [
        { text: t('driverNav.cancel'), style: 'cancel' },
        {
          text: t('driverNav.yes'),
          onPress: () => {
            Alert.alert(
              isFinal ? t('driverNav.confirmFinishTitle') : t('driverNav.confirmPickupTitle'),
              isFinal
                ? t('driverNav.confirmFinishMsg')
                : t('driverNav.startToDestinationMsg'),
              [
                { text: t('driverNav.back'), style: 'cancel' },
                {
                  text: isFinal ? t('driverNav.finish') : t('driverNav.confirm'),
                  style: isFinal ? 'destructive' : 'default',
                  onPress: handleNextPhase,
                },
              ]
            );
          },
        },
      ]
    );
  }

  // Instrução atual
  const arrow       = currentStep ? maneuverArrow(currentStep.maneuver.type, currentStep.maneuver.modifier) : '↑';
  const arrowBg     = currentStep ? maneuverColor(currentStep.maneuver.type, currentStep.maneuver.modifier, colors) : colors.primary;
  const instruction = currentStep
    ? (() => {
        const m = maneuverInstruction(currentStep.maneuver.type, currentStep.maneuver.modifier, currentStep.name);
        return { action: t(m.actionKey), street: m.street };
      })()
    : { action: phase === 'pickup' ? t('driverNav.goingToPickup') : t('driverNav.takingToDestination'), street: target.address };
  const distLabelRaw = currentStep ? formatStepDist(currentStep.distance) : '';
  const distLabel   = typeof distLabelRaw === 'string' ? distLabelRaw : t(distLabelRaw.nowKey);

  // Câmera "drone" engajada IMEDIATAMENTE ao iniciar a corrida e a cada troca
  // de fase (embarque → destino) — zoom máximo (18.5, igual parado) + pitch
  // 45°, nunca uma "visão geral" via fitToCoordinates. Usava fitToCoordinates
  // com UM único ponto (quando o GPS ainda não tinha resolvido o 1º fix) +
  // edgePadding grande — combinação que faz o MapKit/Google Maps SDK estourar
  // o zoom pro mundo inteiro e ficar preso lá (bug conhecido da lib), porque
  // sem um 2º fix de GPS (ex.: motorista parado) a câmera nunca mais era
  // corrigida. Agora usa a melhor posição já conhecida na hora (fix de GPS >
  // posição do aceite, já disponível via param > alvo) e SEMPRE anima direto
  // pro zoom/pitch de perseguição — o próximo fix real (efeito abaixo) só
  // refina center/heading/zoom, nunca precisa "consertar" um zoom quebrado.
  // Também espera `mapReady`: no mount, `mapRef.current` já existe antes do
  // MKMapView (iOS) terminar o layout inicial, e chamar animateCamera nessa
  // janela é a causa raiz do mapa abrir com zoom out pro continente inteiro e
  // os gestos (pinch/touch) travados — por isso o efeito também reroda quando
  // `mapReady` vira true (ex.: fase não mudou, mas o mapa só ficou pronto
  // depois do mount).
  useEffect(() => {
    if (!mapReady) return;
    // Melhor posição já conhecida na hora: fix de GPS > posição do aceite > alvo.
    const center = location
      ? { lat: location.lat, lng: location.lng }
      : initialDriverLocation
        ? { lat: initialDriverLocation.lat, lng: initialDriverLocation.lng }
        : { lat: target.lat, lng: target.lng };
    followingRef.current = true;
    setFollowing(true);
    // Bloco 1: toda câmera passa pelo CameraController (valida coord, clampa zoom,
    // espera mapReady). Nunca chama animateCamera direto no mapRef.
    cam.follow(
      center,
      {
        heading: courseUpRef.current ? headingStateRef.current.smoothed : contHeadingRef.current,
        pitch: DEFAULT_COURSE_UP.pitch,
        zoom: zoomForSpeed(location?.speed ?? 0),
      },
      350,
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, mapReady]);

  // Motorista arrastou o mapa → pausa o follow (deixa ele explorar sem a câmera
  // "brigar"); o botão de recentralizar reata.
  function pauseFollow() {
    if (!followingRef.current) return;
    followingRef.current = false;
    setFollowing(false);
  }

  // Bloco 3: ao entrar em "modo livre" (arrasto pausou o follow), reata o
  // course-up automaticamente após 10 s sem interação — igual Waze/Google Maps.
  // Só com a flag ligada; no legado o motorista reata manualmente pelo botão.
  useEffect(() => {
    if (!courseUpEnabled || following) return;
    const id = setTimeout(() => recenter(), 10_000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [following, courseUpEnabled]);

  function recenter() {
    if (!location) return;
    followingRef.current = true;
    setFollowing(true);
    cam.follow(
      { lat: location.lat, lng: location.lng },
      {
        heading: courseUpRef.current ? headingStateRef.current.smoothed : contHeadingRef.current,
        pitch: DEFAULT_COURSE_UP.pitch,
        zoom: zoomForSpeed(location.speed),
      },
      400,
    );
  }

  // Liga/desliga a simulação (só DEV): congela a rota atual e "dirige" por ela.
  function toggleSim() {
    if (simFixes) {
      setSimFixes(null);
      return;
    }
    const coords = path?.coordinates;
    if (!coords || coords.length < 2) {
      Alert.alert('Simulação', 'Aguarde a rota carregar para simular.');
      return;
    }
    setSimFixes(simulateRouteFixes(coords.map(fromMapCoord), { speedMps: 13.9, intervalMs: 1000 }));
    followingRef.current = true;
    setFollowing(true);
  }

  const showCar = !!location || !!initialDriverLocation;

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
        initialRegion={{
          latitude: target.lat,
          longitude: target.lng,
          latitudeDelta: 0.02,
          longitudeDelta: 0.02,
        }}
        showsUserLocation={false}
        showsMyLocationButton={false}
        followsUserLocation={false}
        onMapReady={() => {
          cam.setReady(true);
          setMapReady(true);
        }}
        // Navegação: gestos de ROTAÇÃO/INCLINAÇÃO desligados (a câmera drone
        // controla heading/pitch); o motorista ainda pode arrastar/dar zoom — e
        // o arrasto PAUSA o follow (estilo Waze). mapPadding empurra o carro
        // para o terço inferior, deixando a via à frente ocupar a tela.
        rotateEnabled={false}
        pitchEnabled={false}
        onPanDrag={pauseFollow}
        // onPanDrag só cobre arrasto; um PINCH de zoom não passa por ele, então
        // sem isto o próximo fix de GPS (até ~1.2s depois) desfazia o zoom
        // manual do motorista. `isGesture` (true só quando a mudança de região
        // veio de um toque do usuário, não de animateCamera) cobre pinch e
        // qualquer outro gesto que não seja pan.
        onRegionChangeComplete={(_region, details) => {
          if (details?.isGesture) pauseFollow();
        }}
        // Course-up (Bloco 3): ancora o carro a ~1/3 do rodapé (mais via à
        // frente). Legado (flag OFF): mantém o padding suave de 16%.
        mapPadding={{
          top: courseUpEnabled ? topPaddingForAnchor(screenH) : Math.round(screenH * 0.16),
          right: 0,
          bottom: 0,
          left: 0,
        }}
      >
        <Marker
          coordinate={{ latitude: target.lat, longitude: target.lng }}
          anchor={{ x: 0.5, y: 0.5 }}
          tracksViewChanges={false}
        >
          <View style={phase === 'pickup' ? styles.markerPickup : styles.markerDropoff} />
        </Marker>

        {/* ── Rota LARGA com cantos arredondados ──────────────────────────────
            Contorno dourado (casing) + núcleo navy por cima, ambos com pontas/
            junções redondas e traço grosso — destaca-se sobre rua, água e
            parques (modo claro) e some no trecho já percorrido (cinza). Sem
            rota ainda: linha tracejada reta da posição conhecida até o alvo. */}
        {routeSplit ? (
          <>
            {routeSplit.traveled.length > 1 && (
              <Polyline
                coordinates={routeSplit.traveled}
                strokeColor={colors.gray[400] + '99'}
                strokeWidth={12}
                lineCap="round"
                lineJoin="round"
                zIndex={2}
              />
            )}
            <Polyline
              coordinates={routeSplit.remaining}
              strokeColor={colors.accent}
              strokeWidth={22}
              lineCap="round"
              lineJoin="round"
              zIndex={3}
            />
            <Polyline
              coordinates={routeSplit.remaining}
              strokeColor={colors.primary}
              strokeWidth={14}
              lineCap="round"
              lineJoin="round"
              zIndex={4}
            />
          </>
        ) : path?.coordinates ? (
          <>
            <Polyline coordinates={path.coordinates} strokeColor={colors.accent} strokeWidth={22} lineCap="round" lineJoin="round" zIndex={3} />
            <Polyline coordinates={path.coordinates} strokeColor={colors.primary} strokeWidth={14} lineCap="round" lineJoin="round" zIndex={4} />
          </>
        ) : (location || routeOrigin) ? (
          <Polyline
            coordinates={[
              { latitude: (location ?? routeOrigin)!.lat, longitude: (location ?? routeOrigin)!.lng },
              { latitude: target.lat, longitude: target.lng },
            ]}
            strokeColor={colors.primary}
            strokeWidth={6}
            lineDashPattern={[6, 3]}
            zIndex={2}
          />
        ) : null}

        {showCar && (
          <MarkerAnimated
            // A posição vem da AnimatedRegion (animada nativamente, sem
            // teleporte). A CÂMERA gira para o rumo (heading-up), então o badge
            // é BILLBOARD (flat=false) com a seta apontando p/ cima (heading=0),
            // mantendo a logo GoXL sempre legível sobre o mapa inclinado.
            coordinate={carRegion as any}
            anchor={{ x: 0.5, y: 0.5 }}
            flat={false}
            tracksViewChanges={!markerReady}
          >
            <CarMarker scale={0.9} heading={0} />
          </MarkerAnimated>
        )}
      </MapView>

      {/* Só aparece quando o follow está pausado (motorista arrastou o mapa) —
          igual ao Waze, que mostra "recentralizar" só quando você saiu do carro. */}
      {location && !following && (
        <TouchableOpacity style={styles.recenterBtn} onPress={recenter}>
          <Text style={styles.recenterIcon}>◎</Text>
        </TouchableOpacity>
      )}

      {/* Toggle da simulação — só em builds de desenvolvimento. */}
      {__DEV__ && (
        <TouchableOpacity style={styles.simBtn} onPress={toggleSim}>
          <Text style={styles.simBtnText}>{simFixes ? '■' : '▶'} SIM</Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity
        style={styles.chatBtn}
        onPress={() => navigation.navigate('Chat', { rideId: ride.id, title: passengerName ?? t('driverNav.passenger') })}
      >
        <Text style={styles.chatIcon}>💬</Text>
      </TouchableOpacity>
      </View>

      {/* ── Banner de instrução de navegação ── */}
      <SafeAreaView style={styles.overlay} pointerEvents="box-none">
        <View style={styles.instructionBanner}>
          {/* Seta de direção */}
          <View style={[styles.arrowBox, { backgroundColor: arrowBg }]}>
            <Text style={styles.arrowText}>{arrow}</Text>
          </View>

          {/* Instrução + rua */}
          <View style={styles.instructionInfo}>
            {distLabel ? (
              <Text style={styles.instructionDist}>{distLabel}</Text>
            ) : null}
            <Text style={styles.instructionAction} numberOfLines={1}>
              {instruction.action}
            </Text>
            {instruction.street ? (
              <Text style={styles.instructionStreet} numberOfLines={1}>
                {instruction.street}
              </Text>
            ) : null}
          </View>

          {/* ETA */}
          {etaMinDisplay != null && (
            <View style={styles.etaBadge}>
              <Text style={styles.etaBadgeMin}>{etaMinDisplay}</Text>
              <Text style={styles.etaBadgeUnit}>{t('driverNav.minUnit')}</Text>
            </View>
          )}
        </View>
      </SafeAreaView>

      {/* ── Bottom sheet reduzido (pós-aceite): só tempo/velocidade + ação ── */}
      <View style={[styles.bottomSheetCompact, Platform.OS === 'android' && { paddingBottom: 20 + insets.bottom }]}>
        <View style={styles.handle} />

        {/* Identidade do passageiro — foto + nome + avaliação média */}
        <View style={styles.paxRow}>
          {passengerAvatar ? (
            <Image source={{ uri: passengerAvatar }} style={styles.paxAvatar} />
          ) : (
            <View style={styles.paxAvatarFallback}>
              <Text style={styles.paxAvatarFallbackText}>
                {(passengerName ?? 'P').trim().charAt(0).toUpperCase()}
              </Text>
            </View>
          )}
          <View style={styles.paxInfo}>
            <Text style={styles.paxName} numberOfLines={1}>
              {passengerName ?? t('driverNav.passenger')}
            </Text>
            {passengerRating != null && passengerRating > 0 && (
              <Text style={styles.paxRating}>⭐ {passengerRating.toFixed(1)}</Text>
            )}
          </View>
        </View>

        <View style={styles.compactStatsRow}>
          <View style={styles.compactStat}>
            <Text style={styles.compactStatValue}>{elapsedLabel}</Text>
            <Text style={styles.compactStatLabel}>{t('driverNav.rideTime')}</Text>
          </View>
          <View style={styles.compactDivider} />
          <View style={styles.compactStat}>
            <Text style={styles.compactStatValue}>{speedKmh != null ? speedKmh : '--'}</Text>
            <Text style={styles.compactStatLabel}>km/h</Text>
          </View>
        </View>

        <Button
          title={buttonLabel}
          onPress={handleNextPhasePress}
          loading={loading}
          style={styles.btn}
        />
        {phase === 'pickup' && (
          <TouchableOpacity style={styles.cancelBtn} onPress={handleCancel}>
            <Text style={styles.cancelBtnText}>{t('driverNav.cancelRide')}</Text>
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

function makeStyles(colors: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1 },
    mapArea: { flex: 1 },
    map: { flex: 1 },
    overlay: { position: 'absolute', top: 0, left: 0, right: 0 },
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
    simBtn: {
      position: 'absolute',
      right: 16,
      top: 110,
      paddingHorizontal: 12,
      height: 34,
      borderRadius: 17,
      backgroundColor: colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.2,
      shadowRadius: 6,
      elevation: 5,
    },
    simBtnText: { color: colors.accent, fontSize: 12, fontWeight: '900', letterSpacing: 0.5 },
    chatBtn: {
      position: 'absolute',
      left: 16,
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
    chatIcon: { fontSize: 20 },

    // Instruction banner
    instructionBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      margin: 12,
      backgroundColor: colors.card,
      borderRadius: 16,
      padding: 12,
      gap: 12,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.2,
      shadowRadius: 12,
      elevation: 8,
    },
    arrowBox: {
      width: 52,
      height: 52,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    arrowText: {
      fontSize: 26,
      color: colors.white,
      fontWeight: '900',
    },
    instructionInfo: {
      flex: 1,
    },
    instructionDist: {
      fontSize: 11,
      fontWeight: '800',
      color: colors.accent,
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginBottom: 1,
    },
    instructionAction: {
      fontSize: 15,
      fontWeight: '800',
      color: colors.text,
      lineHeight: 19,
    },
    instructionStreet: {
      fontSize: 12,
      color: colors.gray[500],
      marginTop: 1,
    },
    etaBadge: {
      alignItems: 'center',
      backgroundColor: colors.primary,
      borderRadius: 10,
      paddingHorizontal: 10,
      paddingVertical: 6,
      flexShrink: 0,
    },
    etaBadgeMin: {
      color: colors.accent,
      fontSize: 18,
      fontWeight: '900',
      lineHeight: 20,
    },
    etaBadgeUnit: {
      color: colors.gray[400],
      fontSize: 10,
      fontWeight: '700',
    },

    // Bottom sheet reduzido (pós-aceite) — só cronômetro/velocidade + ação.
    // ~40% menor que o painel anterior (que tinha manobras, ETA, endereço e
    // dados do passageiro): agora é praticamente a barra + um botão.
    bottomSheetCompact: {
      backgroundColor: colors.card,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      paddingTop: 8,
      paddingHorizontal: 20,
      paddingBottom: 20,
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

    // Identidade do passageiro (foto + nome + avaliação)
    paxRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      marginBottom: 12,
    },
    paxAvatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: colors.gray[200] },
    paxAvatarFallback: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.gray[200],
      alignItems: 'center',
      justifyContent: 'center',
    },
    paxAvatarFallbackText: { fontSize: 18, fontWeight: '800', color: colors.gray[500] },
    paxInfo: { flex: 1 },
    paxName: { fontSize: 16, fontWeight: '700', color: colors.text },
    paxRating: { fontSize: 13, color: colors.gray[500], marginTop: 2 },

    // Barra compacta: tempo de corrida + velocidade atual
    compactStatsRow: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.gray[100],
      borderRadius: 16,
      paddingVertical: 12,
      marginBottom: 14,
    },
    compactStat: { flex: 1, alignItems: 'center' },
    compactStatValue: {
      fontSize: 22,
      fontWeight: '900',
      color: colors.text,
      fontVariant: ['tabular-nums'],
    },
    compactStatLabel: {
      fontSize: 11,
      color: colors.gray[500],
      fontWeight: '600',
      textTransform: 'uppercase',
      letterSpacing: 0.5,
      marginTop: 2,
    },
    compactDivider: {
      width: 1,
      height: 32,
      backgroundColor: colors.gray[300],
    },
    btn: {},
    cancelBtn: {
      marginTop: 12,
      alignItems: 'center',
      paddingVertical: 10,
    },
    cancelBtnText: {
      color: colors.error,
      fontSize: 15,
      fontWeight: '700',
    },

    // Markers
    markerPickup: {
      width: 14,
      height: 14,
      borderRadius: 7,
      backgroundColor: colors.accent,
      borderWidth: 2,
      borderColor: colors.white,
    },
    markerDropoff: {
      width: 14,
      height: 14,
      borderRadius: 3,
      backgroundColor: colors.primary,
      borderWidth: 2,
      borderColor: colors.white,
    },
  });
}
