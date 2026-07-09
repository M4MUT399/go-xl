import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Platform, ActivityIndicator, Image,
} from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { RouteProp } from '@react-navigation/native';
import { RootStackParamList } from '../types';
import { useTheme } from '../hooks/useTheme';
import { AppTheme } from '../constants/theme';
import { supabaseUrl } from '../lib/supabase';
import { useTranslation } from '../i18n';
import { CarMarker } from '../components/common/CarMarker';

// ─── Contrato público (espelha supabase/functions/_shared/tripShare.ts) ─────────
// A Edge Function track-trip devolve APENAS estes campos (nunca telefone/e-mail/
// preço). Este é o mesmo payload consumido pela página web de fallback.
type PublicTripPayload =
  | { active: false; reason: 'not_found' | 'expired' | 'ended' }
  | {
      active: true;
      status: string;
      origin: { lat: number; lng: number; address: string };
      destination: { lat: number; lng: number; address: string };
      position: { lat: number; lng: number; heading: number | null } | null;
      eta_min: number | null;
      driver: {
        first_name: string;
        avatar_url: string | null;
        vehicle: { model: string; color: string; plate: string } | null;
      } | null;
    };

type Props = {
  navigation: NativeStackNavigationProp<RootStackParamList, 'TrackTrip'>;
  route: RouteProp<RootStackParamList, 'TrackTrip'>;
};

const POLL_MS = 6000;

function jsonUrl(token: string): string {
  return `${supabaseUrl}/functions/v1/track-trip?token=${encodeURIComponent(token)}&format=json`;
}

export function TrackTripScreen({ navigation, route }: Props) {
  const token = route.params?.token ?? '';
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const styles = makeStyles(colors);

  const [payload, setPayload] = useState<PublicTripPayload | null>(null);
  const [firstLoad, setFirstLoad] = useState(true);
  const mapRef = useRef<MapView>(null);
  const [mapReady, setMapReady] = useState(false);
  const didFitRef = useRef(false);
  const [tracksCar, setTracksCar] = useState(true);

  // ── Polling do endpoint público ────────────────────────────────────────────
  const poll = useCallback(async () => {
    if (!token) {
      setPayload({ active: false, reason: 'not_found' });
      setFirstLoad(false);
      return;
    }
    try {
      const res = await fetch(jsonUrl(token), { cache: 'no-store' as RequestCache });
      const data = (await res.json()) as PublicTripPayload;
      setPayload(data);
    } catch {
      // Falha de rede: mantém o último estado conhecido (não pisca "inválido").
    } finally {
      setFirstLoad(false);
    }
  }, [token]);

  useEffect(() => {
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [poll]);

  // Reativa o redesenho do marcador do carro por um instante a cada atualização
  // de posição (garante que o ícone acompanhe o movimento no iOS).
  const posLat = payload?.active ? payload.position?.lat : undefined;
  const posLng = payload?.active ? payload.position?.lng : undefined;
  useEffect(() => {
    if (posLat == null) return;
    setTracksCar(true);
    const tm = setTimeout(() => setTracksCar(false), 1000);
    return () => clearTimeout(tm);
  }, [posLat, posLng]);

  // Enquadra origem + destino + motorista na primeira leitura ativa.
  useEffect(() => {
    if (!mapReady || didFitRef.current || !payload?.active || !mapRef.current) return;
    const coords = [
      { latitude: payload.origin.lat, longitude: payload.origin.lng },
      { latitude: payload.destination.lat, longitude: payload.destination.lng },
    ];
    if (payload.position) {
      coords.push({ latitude: payload.position.lat, longitude: payload.position.lng });
    }
    mapRef.current.fitToCoordinates(coords, {
      edgePadding: { top: 120, right: 60, bottom: 240, left: 60 },
      animated: true,
    });
    didFitRef.current = true;
  }, [mapReady, payload]);

  function statusLabel(status: string): string {
    switch (status) {
      case 'accepted': return t('track.status.accepted', 'Motorista confirmado, a caminho do embarque');
      case 'driver_en_route': return t('track.status.enroute', 'Motorista a caminho do embarque');
      case 'in_progress': return t('track.status.inProgress', 'Em viagem para o destino');
      default: return t('track.status.following', 'Acompanhando a viagem');
    }
  }

  // ── Estados terminais / carregamento ───────────────────────────────────────
  if (firstLoad && !payload) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color={colors.accent} size="large" />
        <Text style={styles.centeredText}>{t('track.locating', 'Localizando a viagem…')}</Text>
      </View>
    );
  }

  if (payload && !payload.active) {
    const title =
      payload.reason === 'expired' ? t('track.expiredTitle', 'Link expirado') :
      payload.reason === 'ended' ? t('track.endedTitle', 'Viagem encerrada') :
      t('track.invalidTitle', 'Link inválido');
    const msg =
      payload.reason === 'expired' ? t('track.expiredMsg', 'O acompanhamento foi encerrado ou o link expirou.') :
      payload.reason === 'ended' ? t('track.endedMsg', 'A viagem foi concluída ou cancelada.') :
      t('track.invalidMsg', 'Não encontramos esta viagem.');
    return (
      <View style={styles.centered}>
        <Text style={styles.endedIcon}>🏁</Text>
        <Text style={styles.endedTitle}>{title}</Text>
        <Text style={styles.centeredText}>{msg}</Text>
        <TouchableOpacity style={styles.closeBtn} onPress={() => navigation.goBack()}>
          <Text style={styles.closeBtnText}>{t('common.close', 'Fechar')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (!payload?.active) return null;

  const p = payload;
  const routePts = [
    { latitude: p.origin.lat, longitude: p.origin.lng },
    ...(p.position ? [{ latitude: p.position.lat, longitude: p.position.lng }] : []),
    { latitude: p.destination.lat, longitude: p.destination.lng },
  ];

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={styles.map}
        provider={Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined}
        userInterfaceStyle="light"
        onMapReady={() => setMapReady(true)}
        initialRegion={{
          latitude: (p.origin.lat + p.destination.lat) / 2,
          longitude: (p.origin.lng + p.destination.lng) / 2,
          latitudeDelta: Math.abs(p.origin.lat - p.destination.lat) * 2 + 0.05,
          longitudeDelta: Math.abs(p.origin.lng - p.destination.lng) * 2 + 0.05,
        }}
      >
        <Polyline coordinates={routePts} strokeColor={colors.accent} strokeWidth={4} />
        <Marker coordinate={{ latitude: p.origin.lat, longitude: p.origin.lng }}>
          <View style={styles.markerOrigin} />
        </Marker>
        <Marker coordinate={{ latitude: p.destination.lat, longitude: p.destination.lng }}>
          <View style={styles.markerDest} />
        </Marker>
        {p.position && (
          <Marker
            coordinate={{ latitude: p.position.lat, longitude: p.position.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            tracksViewChanges={tracksCar}
          >
            <CarMarker scale={0.7} heading={p.position.heading ?? 0} />
          </Marker>
        )}
      </MapView>

      {/* Marca Go XL no topo */}
      <View style={[styles.brand, { top: insets.top + 10 }]}>
        <Text style={styles.brandText}>GO XL</Text>
      </View>

      {/* Cartão inferior com motorista + status */}
      <View style={[styles.card, { paddingBottom: 18 + insets.bottom }]}>
        <View style={styles.driverRow}>
          {p.driver?.avatar_url ? (
            <Image source={{ uri: p.driver.avatar_url }} style={styles.avatar} />
          ) : (
            <View style={[styles.avatar, styles.avatarFallback]}>
              <Text style={styles.avatarInitial}>{(p.driver?.first_name ?? 'M')[0]}</Text>
            </View>
          )}
          <View style={styles.driverInfo}>
            <Text style={styles.driverName}>
              {p.driver?.first_name ?? t('track.driver', 'Motorista')}
            </Text>
            {p.driver?.vehicle && (
              <Text style={styles.vehicleText}>
                {p.driver.vehicle.color} {p.driver.vehicle.model} · {p.driver.vehicle.plate}
              </Text>
            )}
          </View>
        </View>
        <Text style={styles.status}>
          {statusLabel(p.status)}
          {p.eta_min != null && (
            <Text style={styles.eta}>{`  ·  ${p.eta_min} min`}</Text>
          )}
        </Text>
      </View>
    </View>
  );
}

function makeStyles(colors: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface },
    map: { flex: 1 },
    centered: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: 32,
      backgroundColor: colors.surface,
    },
    centeredText: {
      marginTop: 12,
      fontSize: 15,
      color: colors.gray[500],
      textAlign: 'center',
      lineHeight: 21,
    },
    endedIcon: { fontSize: 46, marginBottom: 12 },
    endedTitle: { fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: 6 },
    closeBtn: {
      marginTop: 24,
      backgroundColor: colors.primary,
      borderRadius: 12,
      paddingVertical: 12,
      paddingHorizontal: 32,
    },
    closeBtnText: { color: colors.white, fontSize: 15, fontWeight: '700' },

    brand: {
      position: 'absolute',
      left: 12,
      backgroundColor: colors.primary,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 10,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.25,
      shadowRadius: 12,
      elevation: 6,
    },
    brandText: { color: colors.accent, fontSize: 13, fontWeight: '800', letterSpacing: 3 },

    card: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: colors.card,
      borderTopLeftRadius: 20,
      borderTopRightRadius: 20,
      paddingHorizontal: 20,
      paddingTop: 16,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: -4 },
      shadowOpacity: 0.12,
      shadowRadius: 16,
      elevation: 12,
    },
    driverRow: { flexDirection: 'row', alignItems: 'center' },
    avatar: { width: 48, height: 48, borderRadius: 24, marginRight: 14 },
    avatarFallback: {
      backgroundColor: colors.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarInitial: { color: colors.accent, fontSize: 20, fontWeight: '800' },
    driverInfo: { flex: 1 },
    driverName: { fontSize: 17, fontWeight: '700', color: colors.text },
    vehicleText: { fontSize: 13, color: colors.gray[500], marginTop: 2 },
    status: { marginTop: 14, fontSize: 14, color: colors.text, fontWeight: '600' },
    eta: { color: colors.accent, fontWeight: '800' },

    markerOrigin: {
      width: 14, height: 14, borderRadius: 7,
      backgroundColor: colors.accent, borderWidth: 2, borderColor: colors.white,
    },
    markerDest: {
      width: 14, height: 14, borderRadius: 2,
      backgroundColor: colors.primary, borderWidth: 2, borderColor: colors.white,
    },
  });
}
