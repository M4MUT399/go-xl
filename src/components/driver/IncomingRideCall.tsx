import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Modal,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Platform,
  Image,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../hooks/useTheme';
import { AppTheme } from '../../constants/theme';
import { useTranslation } from '../../i18n';
import { useRideCallAlert } from '../../hooks/useRideCallAlert';
import { formatCurrency, formatDistance } from '../../lib/format';
import { rideOrigin, rideDestination } from '../../lib/ride';
import { getRoute } from '../../lib/routing';
import { supabase } from '../../lib/supabase';
import type { Ride } from '../../types';

/** Linha extra na composição da tarifa (pedágio, fee de aeroporto, etc. — P5/P6). */
export interface FareLine {
  label: string;
  value: string;
}

interface Props {
  ride: Ride;
  driverLocation: { lat: number; lng: number } | null;
  /** Tempo total (s) da chamada antes de expirar — vem do system_config. */
  timeoutSeconds: number;
  accepting: boolean;
  /** Corrida reservada via QR Code para este motorista. */
  isQrLocked: boolean;
  /** Itens extras da tarifa (pedágios/fees) — vazio até P5/P6. */
  fareBreakdown?: FareLine[];
  onAccept: () => void;
  onReject: () => void;
  onExpire: () => void;
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function fmtClock(totalSeconds: number): string {
  const s = Math.max(0, totalSeconds);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, '0')}`;
}

/**
 * IncomingRideCall — tela CHEIA de chamada de corrida para o motorista (P1).
 *
 * Substitui o antigo bottom-sheet pequeno: ocupa a tela inteira, com o som
 * recorrente (useRideCallAlert), contagem regressiva configurável, todos os
 * dados da corrida (passageiro, embarque/destino, distâncias/ETAs, tarifa e
 * eventuais pedágios/fees) e botões grandes ACEITAR/RECUSAR.
 *
 * É puramente apresentacional: o pai (DriverHomeScreen) controla aceite,
 * recusa, logging dos eventos e a limpeza da fila.
 */
export function IncomingRideCall({
  ride,
  driverLocation,
  timeoutSeconds,
  accepting,
  isQrLocked,
  fareBreakdown = [],
  onAccept,
  onReject,
  onExpire,
}: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const styles = makeStyles(colors);

  // Som/vibração recorrentes enquanto a chamada estiver ativa (para ao aceitar).
  // Delegado ao singleton offerAlertManager, chaveado por ride.id — ver
  // useRideCallAlert. `!accepting` silencia na hora quando o aceite começa.
  useRideCallAlert(!accepting, ride.id);

  // ─── Contagem regressiva ────────────────────────────────────────────────────
  const [remaining, setRemaining] = useState(timeoutSeconds);
  const expiredRef = useRef(false);
  useEffect(() => {
    setRemaining(timeoutSeconds);
    expiredRef.current = false;
  }, [ride.id, timeoutSeconds]);

  useEffect(() => {
    // Pausa a contagem enquanto o aceite está em andamento.
    if (accepting) return;
    const interval = setInterval(() => {
      setRemaining((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          if (!expiredRef.current) {
            expiredRef.current = true;
            onExpire();
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [ride.id, accepting, onExpire]);

  // ─── Dados do passageiro (nome + foto + rating) ─────────────────────────────
  const [passengerName, setPassengerName] = useState<string | null>(null);
  const [passengerRating, setPassengerRating] = useState<number | null>(null);
  const [passengerAvatar, setPassengerAvatar] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    supabase
      .from('profiles')
      .select('full_name, rating, avatar_url')
      .eq('id', ride.passenger_id)
      .single()
      .then(({ data }) => {
        if (!alive || !data) return;
        setPassengerName((data as { full_name?: string }).full_name ?? null);
        setPassengerRating((data as { rating?: number }).rating ?? null);
        setPassengerAvatar((data as { avatar_url?: string }).avatar_url ?? null);
      });
    return () => {
      alive = false;
    };
  }, [ride.passenger_id]);

  // ─── Distância/ETA até o embarque ───────────────────────────────────────────
  const [pickup, setPickup] = useState<{ km: number; min: number } | null>(null);
  useEffect(() => {
    let alive = true;
    const origin = rideOrigin(ride);
    if (!driverLocation) {
      setPickup(null);
      return;
    }
    // Fallback imediato por linha reta enquanto a rota real carrega.
    const straightKm = haversineKm(driverLocation, { lat: origin.lat, lng: origin.lng });
    setPickup({ km: straightKm, min: Math.max(1, Math.round((straightKm / 48) * 60)) });
    getRoute(driverLocation, { lat: origin.lat, lng: origin.lng }).then((route) => {
      if (alive && route) setPickup({ km: route.distanceKm, min: route.durationMin });
    });
    return () => {
      alive = false;
    };
  }, [ride.id, driverLocation?.lat, driverLocation?.lng]);

  const origin = rideOrigin(ride);
  const destination = rideDestination(ride);
  const initials =
    (passengerName ?? '')
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join('') || '👤';
  const urgent = remaining <= 10;

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onReject} statusBarTranslucent>
      <View style={styles.backdrop}>
        <View style={[styles.safe, { paddingTop: insets.top }]}>
          {/* Cabeçalho: contagem + título */}
          <View style={styles.header}>
            <View style={[styles.countPill, urgent && styles.countPillUrgent]}>
              <Text style={styles.countLabel}>{t('driverCall.expiresIn', 'Expires in')}</Text>
              <Text style={[styles.countValue, urgent && styles.countValueUrgent]}>
                {fmtClock(remaining)}
              </Text>
            </View>
            <Text style={styles.title}>{t('driverCall.title', 'New ride!')}</Text>
            <View style={styles.categoryBadge}>
              <Text style={styles.categoryText}>Executive XL</Text>
            </View>
            {isQrLocked && (
              <View style={styles.qrBadge}>
                <Text style={styles.qrBadgeText}>
                  📲 {t('driverCall.qrReserved', 'QR ride — reserved for you')}
                </Text>
              </View>
            )}
          </View>

          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            {/* Passageiro */}
            <View style={styles.card}>
              <View style={styles.paxRow}>
                {passengerAvatar ? (
                  <Image source={{ uri: passengerAvatar }} style={styles.avatar} />
                ) : (
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>{initials}</Text>
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={styles.paxLabel}>{t('driverCall.passenger', 'Passenger')}</Text>
                  <Text style={styles.paxName} numberOfLines={1}>
                    {passengerName ?? '—'}
                  </Text>
                </View>
                <View style={styles.ratingPill}>
                  <Text style={styles.ratingText}>
                    ⭐ {(passengerRating ?? 5).toFixed(1)}
                  </Text>
                </View>
              </View>
            </View>

            {/* Rota */}
            <View style={styles.card}>
              <View style={styles.routeRow}>
                <View style={[styles.dot, { backgroundColor: colors.success }]} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.routeLabel}>{t('driverCall.pickup', 'Pickup')}</Text>
                  <Text style={styles.routeAddr} numberOfLines={2}>
                    {origin.address}
                  </Text>
                </View>
              </View>
              <View style={styles.routeConnector} />
              <View style={styles.routeRow}>
                <View style={[styles.dot, styles.dotSquare, { backgroundColor: colors.accent }]} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.routeLabel}>{t('driverCall.dropoff', 'Drop-off')}</Text>
                  <Text style={styles.routeAddr} numberOfLines={2}>
                    {destination.address}
                  </Text>
                </View>
              </View>
            </View>

            {/* Métricas */}
            <View style={styles.metricsRow}>
              <View style={styles.metricCard}>
                <Text style={styles.metricTitle}>{t('driverCall.toPickup', 'To pickup')}</Text>
                <Text style={styles.metricValue}>
                  {pickup ? formatDistance(pickup.km) : '—'}
                </Text>
                <Text style={styles.metricSub}>{pickup ? `${pickup.min} min` : ''}</Text>
              </View>
              <View style={styles.metricCard}>
                <Text style={styles.metricTitle}>{t('driverCall.trip', 'Trip')}</Text>
                <Text style={styles.metricValue}>{formatDistance(ride.distance_km)}</Text>
                <Text style={styles.metricSub}>
                  {ride.duration_min ? `${ride.duration_min} min` : ''}
                </Text>
              </View>
            </View>

            {/* Tarifa */}
            <View style={styles.fareCard}>
              <View style={styles.fareTopRow}>
                <Text style={styles.fareLabel}>{t('driverCall.fare', 'Fare')}</Text>
                <Text style={styles.fareValue}>{formatCurrency(ride.price)}</Text>
              </View>
              {fareBreakdown.map((line, i) => (
                <View key={i} style={styles.fareLineRow}>
                  <Text style={styles.fareLineLabel}>{line.label}</Text>
                  <Text style={styles.fareLineValue}>{line.value}</Text>
                </View>
              ))}
              <View style={styles.paymentRow}>
                <Text style={styles.paymentText}>
                  💳 {t('driverCall.card', 'Credit card')}
                </Text>
              </View>
            </View>
          </ScrollView>

          {/* Ações — paddingBottom respeita a barra de navegação (Android) e o
              home-indicator (iOS). No Android, dentro do <Modal>, o inset pode
              vir subestimado; por isso aplicamos um piso generoso para os botões
              NUNCA ficarem sob a barra de navegação nativa. */}
          <View
            style={[
              styles.actions,
              {
                paddingBottom:
                  Platform.OS === 'android'
                    ? Math.max(insets.bottom, 24) + 28
                    : Math.max(insets.bottom, 12) + 6,
              },
            ]}
          >
            <TouchableOpacity
              style={styles.rejectBtn}
              onPress={onReject}
              disabled={accepting}
              activeOpacity={0.85}
            >
              <Text style={styles.rejectText}>{t('driverCall.reject', 'DECLINE')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.acceptBtn, accepting && { opacity: 0.7 }]}
              onPress={onAccept}
              disabled={accepting}
              activeOpacity={0.85}
            >
              {accepting ? (
                <ActivityIndicator color={colors.primary} />
              ) : (
                <Text style={styles.acceptText}>{t('driverCall.accept', 'ACCEPT')}</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(colors: AppTheme) {
  return StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: colors.primary },
    safe: { flex: 1 },
    header: { alignItems: 'center', paddingTop: 8, paddingBottom: 4 },
    countPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: 'rgba(255,255,255,0.08)',
      borderRadius: 999,
      paddingHorizontal: 16,
      paddingVertical: 8,
      marginBottom: 12,
    },
    countPillUrgent: { backgroundColor: 'rgba(239,68,68,0.2)' },
    countLabel: { color: colors.gray[400], fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
    countValue: { color: colors.white, fontSize: 16, fontWeight: '800', fontVariant: ['tabular-nums'] },
    countValueUrgent: { color: colors.error },
    title: { color: colors.white, fontSize: 30, fontWeight: '900' },
    categoryBadge: {
      marginTop: 8,
      backgroundColor: 'rgba(201,168,76,0.18)',
      borderRadius: 999,
      paddingHorizontal: 14,
      paddingVertical: 5,
      borderWidth: 1,
      borderColor: 'rgba(201,168,76,0.5)',
    },
    categoryText: { color: colors.accent, fontSize: 13, fontWeight: '800', letterSpacing: 0.5 },
    qrBadge: {
      marginTop: 10,
      backgroundColor: 'rgba(201,168,76,0.15)',
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderWidth: 1,
      borderColor: 'rgba(201,168,76,0.4)',
    },
    qrBadgeText: { color: colors.accent, fontSize: 13, fontWeight: '700', textAlign: 'center' },
    scroll: { flex: 1, marginTop: 8 },
    scrollContent: { paddingHorizontal: 20, paddingBottom: 12, gap: 12 },
    card: {
      backgroundColor: 'rgba(255,255,255,0.06)',
      borderRadius: 16,
      padding: 16,
    },
    paxRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    avatar: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    avatarText: { color: colors.primary, fontSize: 18, fontWeight: '800' },
    paxLabel: { color: colors.gray[400], fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 },
    paxName: { color: colors.white, fontSize: 17, fontWeight: '700', marginTop: 2 },
    ratingPill: {
      backgroundColor: 'rgba(255,255,255,0.1)',
      borderRadius: 999,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    ratingText: { color: colors.white, fontSize: 14, fontWeight: '700' },
    routeRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
    dot: { width: 12, height: 12, borderRadius: 6, marginTop: 4 },
    dotSquare: { borderRadius: 3 },
    routeLabel: { color: colors.gray[400], fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 },
    routeAddr: { color: colors.white, fontSize: 15, fontWeight: '600', marginTop: 2 },
    routeConnector: {
      width: 2,
      height: 20,
      backgroundColor: 'rgba(255,255,255,0.2)',
      marginLeft: 5,
      marginVertical: 4,
    },
    metricsRow: { flexDirection: 'row', gap: 12 },
    metricCard: {
      flex: 1,
      backgroundColor: 'rgba(255,255,255,0.06)',
      borderRadius: 16,
      padding: 16,
      alignItems: 'center',
    },
    metricTitle: { color: colors.gray[400], fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5 },
    metricValue: { color: colors.white, fontSize: 20, fontWeight: '800', marginTop: 4 },
    metricSub: { color: colors.gray[500], fontSize: 13, marginTop: 2 },
    fareCard: {
      backgroundColor: 'rgba(201,168,76,0.12)',
      borderRadius: 16,
      padding: 16,
      borderWidth: 1,
      borderColor: 'rgba(201,168,76,0.35)',
    },
    fareTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    fareLabel: { color: colors.gray[300], fontSize: 14, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
    fareValue: { color: colors.accent, fontSize: 30, fontWeight: '900' },
    fareLineRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 8 },
    fareLineLabel: { color: colors.gray[300], fontSize: 13 },
    fareLineValue: { color: colors.white, fontSize: 13, fontWeight: '600' },
    paymentRow: { marginTop: 12, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.1)', paddingTop: 10 },
    paymentText: { color: colors.gray[300], fontSize: 14, fontWeight: '600' },
    actions: {
      flexDirection: 'row',
      gap: 12,
      paddingHorizontal: 20,
      paddingTop: 8,
      paddingBottom: 8,
    },
    rejectBtn: {
      flex: 1,
      height: 60,
      borderRadius: 16,
      borderWidth: 1.5,
      borderColor: 'rgba(255,255,255,0.3)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    rejectText: { color: colors.gray[300], fontSize: 16, fontWeight: '700', letterSpacing: 0.5 },
    acceptBtn: {
      flex: 2,
      height: 60,
      borderRadius: 16,
      backgroundColor: colors.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    acceptText: { color: colors.primary, fontSize: 18, fontWeight: '900', letterSpacing: 0.5 },
  });
}
