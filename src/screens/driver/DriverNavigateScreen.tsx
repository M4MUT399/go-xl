import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, TouchableOpacity,
  Platform, Alert, ScrollView,
} from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
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
import { formatCurrency, formatDistance } from '../../lib/format';
import { rideOrigin, rideDestination } from '../../lib/ride';
import { RouteStep } from '../../lib/routing';
import { NavChevron } from '../../components/common/NavChevron';
import { supabase } from '../../lib/supabase';

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

function maneuverInstruction(type: string, modifier?: string, name?: string): { action: string; street: string } {
  const street = name || '';
  if (type === 'arrive')    return { action: 'Chegou ao destino', street };
  if (type === 'depart')    return { action: 'Siga em frente', street };
  if (type === 'roundabout' || type === 'rotary') return { action: 'Entre na rotatória', street };
  if (type === 'fork')      return { action: modifier?.includes('right') ? 'Mantenha à direita' : 'Mantenha à esquerda', street };
  if (type === 'merge')     return { action: 'Incorpore ao tráfego', street };
  if (type === 'on ramp')   return { action: 'Entre na rampa', street };
  if (type === 'off ramp')  return { action: 'Saia pela rampa', street };
  if (type === 'end of road') return { action: modifier?.includes('right') ? 'Vire à direita' : 'Vire à esquerda', street };
  switch (modifier) {
    case 'uturn':        return { action: 'Faça o retorno', street };
    case 'sharp right':  return { action: 'Vire totalmente à direita', street };
    case 'right':        return { action: 'Vire à direita', street };
    case 'slight right': return { action: 'Siga levemente à direita', street };
    case 'straight':     return { action: 'Continue em frente', street };
    case 'slight left':  return { action: 'Siga levemente à esquerda', street };
    case 'left':         return { action: 'Vire à esquerda', street };
    case 'sharp left':   return { action: 'Vire totalmente à esquerda', street };
    default:             return { action: 'Continue', street };
  }
}

function formatStepDist(meters: number): string {
  if (meters < 30)   return 'Agora';
  if (meters < 1000) return `${Math.round(meters / 10) * 10} m`;
  return `${(meters / 1000).toFixed(1)} km`;
}

// ─── Componente ──────────────────────────────────────────────────────────────

export function DriverNavigateScreen({ navigation, route }: Props) {
  const { ride } = route.params;
  const { profile } = useAuth();
  const { colors } = useTheme();
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

  useChatAlert(ride.id, profile?.id, isFocused, 'Passageiro');

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
  const [routeOrigin, setRouteOrigin] = useState(
    location ? { lat: location.lat, lng: location.lng } : null
  );
  const mapRef = useRef<MapView>(null);
  const lastCameraUpdate = useRef(0);

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

  // ── Modo navegação: câmera segue posição + heading (mapa gira como GPS real) ─
  useEffect(() => {
    if (!location || !mapRef.current) return;
    const now = Date.now();
    if (now - lastCameraUpdate.current < 1500) return;
    lastCameraUpdate.current = now;
    mapRef.current.animateCamera(
      {
        center: { latitude: location.lat, longitude: location.lng },
        heading: location.heading ?? 0,
        zoom: 17,
        pitch: 20,
      },
      { duration: 800 },
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
  const upcomingSteps = steps.slice(1, 4).filter((s) => s.maneuver.type !== 'arrive');

  // Fallback: enquanto a rota local (OSRM) ainda não carregou, usa o ETA já
  // calculado no momento do aceite (acceptRide) — assim o motorista vê o tempo
  // estimado imediatamente ao abrir a tela, em vez de esperar o GPS+rota.
  const fallbackEtaMin = phase === 'pickup' ? (ride.driver_eta_min ?? null) : null;
  const fallbackEtaKm  = phase === 'pickup' ? (ride.driver_eta_km ?? null) : null;
  const etaMinDisplay = path?.durationMin ?? fallbackEtaMin;
  const etaKmDisplay  = path?.distanceKm ?? fallbackEtaKm;
  const etaTime = etaMinDisplay
    ? new Date(Date.now() + etaMinDisplay * 60 * 1000)
    : null;

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
    Alert.alert('Cancelar corrida', 'Tem certeza? O passageiro será reembolsado automaticamente.', [
      { text: 'Não', style: 'cancel' },
      {
        text: 'Sim, cancelar',
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
      Alert.alert('Corrida concluída!', `Valor: ${formatCurrency(ride.price)}`, [
        { text: 'OK', onPress: () => navigation.reset({ index: 0, routes: [{ name: 'DriverTabs' }] }) },
      ]);
    }
    setLoading(false);
  }

  const buttonLabel = phase === 'pickup' ? 'Passei buscar o passageiro' : 'Finalizar corrida';

  // Instrução atual
  const arrow       = currentStep ? maneuverArrow(currentStep.maneuver.type, currentStep.maneuver.modifier) : '↑';
  const arrowBg     = currentStep ? maneuverColor(currentStep.maneuver.type, currentStep.maneuver.modifier, colors) : colors.primary;
  const instruction = currentStep
    ? maneuverInstruction(currentStep.maneuver.type, currentStep.maneuver.modifier, currentStep.name)
    : { action: phase === 'pickup' ? 'Indo buscar o passageiro' : 'Levando ao destino', street: target.address };
  const distLabel   = currentStep ? formatStepDist(currentStep.distance) : '';

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
    mapRef.current.animateCamera(
      {
        center: { latitude: location.lat, longitude: location.lng },
        heading: location.heading ?? 0,
        zoom: 17,
        pitch: 20,
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
        // Força o mapa CLARO no Android (o Google Maps herda o modo escuro do
        // sistema); no iOS o Apple Maps já é claro por padrão, então deixamos
        // undefined para não alterá-lo.
        customMapStyle={Platform.OS === 'android' ? [] : undefined}
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
            anchor={{ x: 0.5, y: 0.5 }}
            rotation={location.heading ?? 0}
            flat
            tracksViewChanges={tracksCar}
          >
            <NavChevron scale={0.95} />
          </Marker>
        )}
        {location && (
          <Polyline
            coordinates={
              path?.coordinates ?? [
                { latitude: location.lat, longitude: location.lng },
                { latitude: target.lat, longitude: target.lng },
              ]
            }
            strokeColor={colors.accent}
            strokeWidth={path ? 4 : 3}
            lineDashPattern={path ? undefined : [6, 3]}
          />
        )}
      </MapView>

      {location && (
        <TouchableOpacity style={styles.recenterBtn} onPress={recenter}>
          <Text style={styles.recenterIcon}>◎</Text>
        </TouchableOpacity>
      )}
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
              <Text style={styles.etaBadgeUnit}>min</Text>
            </View>
          )}
        </View>
      </SafeAreaView>

      {/* ── Bottom sheet ── */}
      <View style={styles.bottomSheet}>
        <View style={styles.handle} />

        {/* Próximas manobras */}
        {upcomingSteps.length > 0 && (
          <View style={styles.upcomingSection}>
            <Text style={styles.upcomingTitle}>Próximas</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.upcomingList}
            >
              {upcomingSteps.map((s, i) => {
                const a = maneuverArrow(s.maneuver.type, s.maneuver.modifier);
                const bg = maneuverColor(s.maneuver.type, s.maneuver.modifier, colors);
                return (
                  <View key={i} style={styles.upcomingChip}>
                    <View style={[styles.upcomingArrowBox, { backgroundColor: bg }]}>
                      <Text style={styles.upcomingArrow}>{a}</Text>
                    </View>
                    <View style={styles.upcomingChipInfo}>
                      <Text style={styles.upcomingChipName} numberOfLines={1}>
                        {s.name || maneuverInstruction(s.maneuver.type, s.maneuver.modifier).action}
                      </Text>
                      <Text style={styles.upcomingChipDist}>{formatStepDist(s.distance)}</Text>
                    </View>
                  </View>
                );
              })}
            </ScrollView>
          </View>
        )}

        {/* ETA card (pickup e dropoff) */}
        {etaMinDisplay != null && (
          <View style={styles.etaCard}>
            <View style={styles.etaMain}>
              <Text style={styles.etaMinutes}>{etaMinDisplay}</Text>
              <Text style={styles.etaUnit}>min</Text>
              {etaKmDisplay != null && (
                <>
                  <View style={styles.etaSep} />
                  <Text style={styles.etaDist}>{formatDistance(etaKmDisplay)}</Text>
                </>
              )}
            </View>
            {etaTime && (
              <Text style={styles.etaArrival}>
                {phase === 'pickup' ? 'Embarque estimado' : 'Chegada estimada'}:{' '}
                {etaTime.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
              </Text>
            )}
          </View>
        )}

        {/* Endereço alvo */}
        <View style={styles.addressCard}>
          <Text style={styles.addressLabel}>
            {phase === 'pickup' ? 'Local de embarque' : 'Destino final'}
          </Text>
          <Text style={styles.addressText}>{target.address}</Text>
        </View>

        {/* Passageiro */}
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

    // Bottom sheet
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

    // Upcoming steps
    upcomingSection: {
      marginBottom: 14,
    },
    upcomingTitle: {
      fontSize: 11,
      fontWeight: '800',
      color: colors.gray[400],
      textTransform: 'uppercase',
      letterSpacing: 0.6,
      marginBottom: 8,
    },
    upcomingList: {
      gap: 8,
    },
    upcomingChip: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.gray[100],
      borderRadius: 12,
      paddingVertical: 8,
      paddingHorizontal: 10,
      gap: 8,
      maxWidth: 180,
    },
    upcomingArrowBox: {
      width: 30,
      height: 30,
      borderRadius: 8,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    upcomingArrow: {
      fontSize: 16,
      color: colors.white,
      fontWeight: '700',
    },
    upcomingChipInfo: {
      flex: 1,
    },
    upcomingChipName: {
      fontSize: 12,
      fontWeight: '700',
      color: colors.text,
    },
    upcomingChipDist: {
      fontSize: 11,
      color: colors.gray[500],
      marginTop: 1,
    },

    // ETA card (dropoff)
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
    etaArrival: {
      fontSize: 13,
      color: colors.gray[400],
      fontWeight: '600',
    },

    // Address card
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

    // Passenger row
    passengerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 18,
    },
    passengerAvatar: {
      width: 46,
      height: 46,
      borderRadius: 23,
      backgroundColor: colors.gray[200],
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 12,
    },
    passengerAvatarText: {
      fontSize: 18,
      fontWeight: '700',
      color: colors.gray[600],
    },
    passengerInfo: { flex: 1 },
    passengerName: { fontSize: 15, fontWeight: '600', color: colors.text },
    ratingRow: { flexDirection: 'row', alignItems: 'center', marginTop: 2 },
    star: { color: colors.accent, fontSize: 13, marginRight: 2 },
    ratingText: { fontSize: 12, color: colors.gray[500] },
    actions: { flexDirection: 'row', gap: 8 },
    actionBtn: {
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: colors.gray[100],
      alignItems: 'center',
      justifyContent: 'center',
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
