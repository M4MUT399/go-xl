import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity,
  Platform, Alert, Image,
} from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp, useIsFocused } from '@react-navigation/native';
import { RootStackParamList, Ride, RideStatus } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import { AppTheme } from '../../constants/theme';
import { Button } from '../../components/common/Button';
import { useDriverRide, notifyPassengerRideCompleted } from '../../hooks/useRide';
import { useAuth } from '../../hooks/useAuth';
import { useLocation } from '../../hooks/useLocation';
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
  // watch: true → posição contínua durante a navegação
  const { location } = useLocation({ watch: true });
  const { updateRideStatus, refundRide } = useDriverRide(profile?.id);
  const lastUploadedCoord = useRef<{ lat: number; lng: number } | null>(null);
  const isFocused = useIsFocused();
  const [phase, setPhase] = useState<Phase>('pickup');
  const [loading, setLoading] = useState(false);
  // Mantém o snapshot do marcador ligado por um instante a cada movimento,
  // para o ícone do carro pintar e acompanhar a posição no iOS.
  const [tracksCar, setTracksCar] = useState(true);

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
      .from('profiles')
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
    if (!location) return;
    setTracksCar(true);
    const t = setTimeout(() => setTracksCar(false), 1000);
    return () => clearTimeout(t);
  }, [location?.lat, location?.lng, location?.heading]);

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
  const lastCameraUpdate = useRef(0);
  // Último rumo VÁLIDO do GPS. Quando o curso é desconhecido (parado ou GPS sem
  // heading) mantemos o anterior em vez de "pular" para o norte — é assim que
  // Waze/Uber giram o mapa continuamente no sentido do deslocamento.
  const lastHeadingRef = useRef(0);

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

  // ── Modo navegação: câmera segue posição + rumo (mapa gira como Waze/Uber) ──
  useEffect(() => {
    if (!location || !mapRef.current) return;
    const now = Date.now();
    if (now - lastCameraUpdate.current < 1000) return;
    lastCameraUpdate.current = now;
    // Só atualiza o rumo quando o GPS informa um curso válido; caso contrário
    // mantém o último (não volta ao norte quando o motorista para no sinal).
    if (location.heading != null) lastHeadingRef.current = location.heading;
    mapRef.current.animateCamera(
      {
        center: { latitude: location.lat, longitude: location.lng },
        heading: lastHeadingRef.current,
        zoom: 17.5,
        pitch: 55,
      },
      { duration: 700 },
    );
  }, [location?.lat, location?.lng, location?.heading]);

  const { route: path } = useRideRoute(
    routeOrigin,
    { lat: target.lat, lng: target.lng }
  );

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
      // Reseta throttle para recalcular rota ao destino
      lastRouteCoord.current = null;
    } else {
      await updateRideStatus(ride.id, 'completed' as RideStatus);
      // Notifica o passageiro (push remoto para app em background)
      notifyPassengerRideCompleted(ride.passenger_id, ride.price);
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

  // Visão geral ao trocar de fase (embarque → destino); depois a câmera de
  // navegação retoma o controle automaticamente no próximo update de posição.
  useEffect(() => {
    if (!mapRef.current) return;
    const coords = location
      ? [
          { latitude: location.lat, longitude: location.lng },
          { latitude: target.lat, longitude: target.lng },
        ]
      : [{ latitude: target.lat, longitude: target.lng }];
    lastCameraUpdate.current = 0; // força re-engajamento do modo navegação logo em seguida
    mapRef.current.fitToCoordinates(coords, {
      edgePadding: { top: 160, right: 60, bottom: 320, left: 60 },
      animated: true,
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  function recenter() {
    if (!location || !mapRef.current) return;
    lastCameraUpdate.current = 0; // força update imediato no próximo ciclo
    if (location.heading != null) lastHeadingRef.current = location.heading;
    mapRef.current.animateCamera(
      {
        center: { latitude: location.lat, longitude: location.lng },
        heading: lastHeadingRef.current,
        zoom: 17.5,
        pitch: 55,
      },
      { duration: 300 },
    );
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
        initialRegion={{
          latitude: target.lat,
          longitude: target.lng,
          latitudeDelta: 0.02,
          longitudeDelta: 0.02,
        }}
        showsUserLocation={false}
        showsMyLocationButton={false}
        followsUserLocation={false}
      >
        <Marker
          coordinate={{ latitude: target.lat, longitude: target.lng }}
          anchor={{ x: 0.5, y: 0.5 }}
          tracksViewChanges={false}
        >
          <View style={phase === 'pickup' ? styles.markerPickup : styles.markerDropoff} />
        </Marker>
        {location && (
          <Marker
            coordinate={{ latitude: location.lat, longitude: location.lng }}
            // Marcador de marca (o MESMO CarMarker das demais telas) — idêntico
            // ao iOS e já robusto no Android (o triângulo "cru" era o antigo
            // NavChevron, só usado aqui). A CÂMERA já gira para o rumo do
            // motorista (heading-up, estilo Waze), então a seta do badge aponta
            // sempre para CIMA (heading={0}) = sentido do movimento. Billboard
            // (sem `flat`) mantém a logo em pé e legível sobre o mapa inclinado.
            anchor={{ x: 0.5, y: 0.5 }}
            tracksViewChanges={tracksCar}
          >
            <CarMarker scale={0.9} heading={0} />
          </Marker>
        )}
        {/* Traça a rota IMEDIATAMENTE ao abrir a tela: usa a posição já conhecida
            do motorista (GPS ao vivo ou, na falta dele por 1-2s, a localização
            capturada no momento do aceite) — nunca fica com o mapa "vazio"
            enquanto espera um novo fix de GPS. */}
        {(location || routeOrigin) && (
          <Polyline
            // Contorno dourado (mais largo, atrás) + linha navy por cima:
            // combinação da paleta da marca que se destaca tanto sobre ruas
            // claras/cinza quanto sobre água/parques do mapa (modo claro).
            coordinates={
              path?.coordinates ?? [
                {
                  latitude: (location ?? routeOrigin)!.lat,
                  longitude: (location ?? routeOrigin)!.lng,
                },
                { latitude: target.lat, longitude: target.lng },
              ]
            }
            strokeColor={colors.accent}
            strokeWidth={path ? 7 : 6}
            lineDashPattern={path ? undefined : [6, 3]}
            zIndex={1}
          />
        )}
        {(location || routeOrigin) && (
          <Polyline
            coordinates={
              path?.coordinates ?? [
                {
                  latitude: (location ?? routeOrigin)!.lat,
                  longitude: (location ?? routeOrigin)!.lng,
                },
                { latitude: target.lat, longitude: target.lng },
              ]
            }
            strokeColor={colors.primary}
            strokeWidth={path ? 4 : 3}
            lineDashPattern={path ? undefined : [6, 3]}
            zIndex={2}
          />
        )}
      </MapView>

      {location && (
        <TouchableOpacity style={styles.recenterBtn} onPress={recenter}>
          <Text style={styles.recenterIcon}>◎</Text>
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

// ─── Utilitário ──────────────────────────────────────────────────────────────

function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
