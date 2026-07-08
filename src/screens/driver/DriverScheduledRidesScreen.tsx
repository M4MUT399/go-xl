import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, FlatList, Image,
  TouchableOpacity, ActivityIndicator, RefreshControl, Alert, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import { RootStackParamList, RideRecord, Ride } from '../../types';
import { useTheme } from '../../hooks/useTheme';
import { AppTheme } from '../../constants/theme';
import { useAuth } from '../../hooks/useAuth';
import { useDriverScheduledRides } from '../../hooks/useDriverScheduledRides';
import { useScheduledRides } from '../../hooks/useRide';

function isCancellationFree(scheduledFor?: string): boolean {
  if (!scheduledFor) return true;
  return new Date(scheduledFor).getTime() - Date.now() > 60 * 60 * 1000;
}
import { formatCurrency, formatDistance } from '../../lib/format';

// ─── Funções de tempo ─────────────────────────────────────────────────────────

type Urgency = 'normal' | 'soon' | 'imminent' | 'now';

function computeTimeLeft(iso?: string, now = Date.now()): { label: string; urgency: Urgency } {
  if (!iso) return { label: 'Sem horário', urgency: 'normal' };
  const diff = new Date(iso).getTime() - now;
  const totalMin = Math.floor(diff / 60_000);

  if (diff <= 0) return { label: 'Agora!', urgency: 'now' };
  if (totalMin < 5) return { label: `${totalMin} min`, urgency: 'now' };
  if (totalMin < 15) return { label: `${totalMin} min`, urgency: 'imminent' };
  if (totalMin < 60) return { label: `${totalMin} min`, urgency: 'soon' };

  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return { label: m > 0 ? `${h}h ${m}min` : `${h}h`, urgency: 'normal' };
}

function urgencyColor(urgency: Urgency, colors: AppTheme): string {
  switch (urgency) {
    case 'soon': return colors.accent;
    case 'imminent': return '#f97316';
    case 'now': return '#ef4444';
    default: return colors.gray[400];
  }
}

function formatDate(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString('en-US', { weekday: 'short', day: '2-digit', month: 'short' })} • ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
}

// ─── Identificação do passageiro (nome + foto + avaliação) ─────────────────────
// Componente único usado por TODOS os cards do motorista (Tarefa 5): quem
// solicitou a corrida aparece com foto (quando houver), nome e avaliação média.

function PassengerRow({
  ride,
  styles,
}: {
  ride: RideRecord;
  styles: ReturnType<typeof makeStyles>;
}) {
  const rating = ride.passenger_rating;
  const hasRating = typeof rating === 'number' && rating > 0;
  return (
    <View style={styles.passengerRow}>
      {ride.passenger_avatar_url ? (
        <Image source={{ uri: ride.passenger_avatar_url }} style={styles.passengerAvatar} />
      ) : (
        <View style={styles.passengerAvatarFallback}>
          <Text style={styles.passengerIcon}>👤</Text>
        </View>
      )}
      <View style={styles.passengerInfo}>
        <Text style={styles.passengerName} numberOfLines={1}>{ride.passenger_name ?? 'Passageiro'}</Text>
        {hasRating && (
          <Text style={styles.passengerRating}>⭐ {rating!.toFixed(1)}</Text>
        )}
      </View>
    </View>
  );
}

// ─── Card de corrida confirmada ───────────────────────────────────────────────

function ClaimedCard({
  ride,
  now,
  colors,
  styles,
  onStart,
  onChat,
  onRelease,
}: {
  ride: RideRecord;
  now: number;
  colors: AppTheme;
  styles: ReturnType<typeof makeStyles>;
  onStart: (r: RideRecord) => void;
  onChat: (r: RideRecord) => void;
  onRelease: (r: RideRecord) => void;
}) {
  const { label, urgency } = computeTimeLeft(ride.scheduled_for, now);
  const isDue = ride.scheduled_for ? new Date(ride.scheduled_for).getTime() <= now : false;
  const uColor = urgencyColor(urgency, colors);
  const canRelease = isCancellationFree(ride.scheduled_for);

  return (
    <View style={[styles.card, styles.cardClaimed, urgency === 'now' && styles.cardNow]}>
      {/* Cabeçalho: data + countdown */}
      <View style={styles.cardTop}>
        <View>
          <Text style={styles.cardDate}>{formatDate(ride.scheduled_for)}</Text>
        </View>
        <View style={[styles.countdownBadge, { backgroundColor: uColor + '22', borderColor: uColor }]}>
          <Text style={styles.countdownIcon}>⏰</Text>
          <Text style={[styles.countdownText, { color: uColor }]}>{label}</Text>
        </View>
      </View>

      {/* Passageiro */}
      <PassengerRow ride={ride} styles={styles} />

      {/* Rota */}
      <View style={styles.route}>
        <View style={styles.routeIcons}>
          <View style={styles.dotOrigin} />
          <View style={styles.routeLine} />
          <View style={styles.dotDest} />
        </View>
        <View style={styles.routeAddrs}>
          <Text style={styles.addr} numberOfLines={1}>{ride.origin_address}</Text>
          <Text style={[styles.addr, styles.addrDest]} numberOfLines={1}>{ride.destination_address}</Text>
        </View>
      </View>

      {/* Meta */}
      <View style={styles.meta}>
        <Text style={styles.metaText}>{formatDistance(ride.distance_km)} • {ride.duration_min} min</Text>
        <Text style={styles.metaPrice}>{formatCurrency(ride.price)}</Text>
      </View>

      {/* Chat com passageiro */}
      <TouchableOpacity style={styles.chatBtn} onPress={() => onChat(ride)}>
        <Text style={styles.chatBtnText}>💬  Falar com o passageiro</Text>
      </TouchableOpacity>

      {/* Botão iniciar */}
      {isDue && (
        <TouchableOpacity style={styles.startBtn} onPress={() => onStart(ride)}>
          <Text style={styles.startBtnText}>🚀  Iniciar corrida agora</Text>
        </TouchableOpacity>
      )}

      {/* Liberar agendamento */}
      {canRelease ? (
        <TouchableOpacity style={styles.releaseBtn} onPress={() => onRelease(ride)}>
          <Text style={styles.releaseBtnText}>Liberar agendamento</Text>
        </TouchableOpacity>
      ) : (
        <View style={styles.noReleaseRow}>
          <Text style={styles.noReleaseText}>⚠️ Menos de 1h — corrida será cobrada</Text>
        </View>
      )}
    </View>
  );
}

// ─── Card de corrida disponível ───────────────────────────────────────────────

function AvailableCard({
  ride,
  now,
  claiming,
  colors,
  styles,
  onClaim,
}: {
  ride: RideRecord;
  now: number;
  claiming: boolean;
  colors: AppTheme;
  styles: ReturnType<typeof makeStyles>;
  onClaim: (r: RideRecord) => void;
}) {
  const { label } = computeTimeLeft(ride.scheduled_for, now);

  return (
    <View style={styles.card}>
      <View style={styles.cardTop}>
        <Text style={styles.cardDate}>{formatDate(ride.scheduled_for)}</Text>
        <View style={styles.availBadge}>
          <Text style={styles.availText}>em {label}</Text>
        </View>
      </View>

      {/* Passageiro */}
      <View style={styles.passengerRow}>
        <Text style={styles.passengerIcon}>👤</Text>
        <Text style={styles.passengerName} numberOfLines={1}>{ride.passenger_name ?? 'Passageiro'}</Text>
      </View>

      <View style={styles.route}>
        <View style={styles.routeIcons}>
          <View style={styles.dotOrigin} />
          <View style={styles.routeLine} />
          <View style={styles.dotDest} />
        </View>
        <View style={styles.routeAddrs}>
          <Text style={styles.addr} numberOfLines={1}>{ride.origin_address}</Text>
          <Text style={[styles.addr, styles.addrDest]} numberOfLines={1}>{ride.destination_address}</Text>
        </View>
      </View>

      <View style={styles.meta}>
        <Text style={styles.metaText}>{formatDistance(ride.distance_km)} • {ride.duration_min} min</Text>
        <Text style={styles.metaPrice}>{formatCurrency(ride.price)}</Text>
      </View>

      <TouchableOpacity
        style={[styles.claimBtn, claiming && { opacity: 0.6 }]}
        onPress={() => onClaim(ride)}
        disabled={claiming}
      >
        {claiming
          ? <ActivityIndicator size="small" color={colors.primary} />
          : <Text style={styles.claimBtnText}>Confirmar esta corrida</Text>
        }
      </TouchableOpacity>
    </View>
  );
}

// ─── Tela principal ───────────────────────────────────────────────────────────

export function DriverScheduledRidesScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { profile } = useAuth();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { available, claimed, loading, refresh, release } = useDriverScheduledRides(profile?.id);
  const { claimScheduledRide, activate } = useScheduledRides(profile?.id);
  const [claiming, setClaiming] = useState<string | null>(null);

  const styles = makeStyles(colors);

  // Relógio local — atualiza a cada 30s para refrescar os countdowns
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);

  useFocusEffect(useCallback(() => { refresh(); }, [refresh]));

  async function handleClaim(ride: RideRecord) {
    Alert.alert(
      'Confirmar corrida agendada',
      `Confirmar que você buscará o passageiro em:\n${ride.origin_address}\n\nData: ${formatDate(ride.scheduled_for)}`,
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Confirmar',
          onPress: async () => {
            if (!profile?.id) return;
            setClaiming(ride.id);
            const ok = await claimScheduledRide(ride.id, profile.id);
            setClaiming(null);
            if (ok) {
              Alert.alert('✅ Confirmado!', 'O passageiro foi notificado que você irá buscá-lo.');
              refresh();
            } else {
              Alert.alert('Ops', 'Essa corrida já foi confirmada por outro motorista.');
            }
          },
        },
      ]
    );
  }

  async function handleStart(ride: RideRecord) {
    const activated = await activate(ride.id);
    if (activated) {
      navigation.navigate('DriverNavigate', { ride: activated as Ride });
    }
  }

  function handleChat(ride: RideRecord) {
    navigation.navigate('Chat', { rideId: ride.id, title: ride.passenger_name ?? 'Passageiro' });
  }

  function handleRelease(ride: RideRecord) {
    Alert.alert(
      'Liberar agendamento',
      'Deseja liberar esta corrida? Outro motorista poderá confirmá-la.',
      [
        { text: 'Não', style: 'cancel' },
        {
          text: 'Sim, liberar',
          style: 'destructive',
          onPress: async () => {
            const ok = await release(ride.id);
            if (!ok) Alert.alert('Ops', 'Não foi possível liberar a corrida.');
          },
        },
      ]
    );
  }

  const hasClaimed = claimed.length > 0;
  const hasAvailable = available.length > 0;
  const isEmpty = !hasClaimed && !hasAvailable;

  return (
    <SafeAreaView style={styles.container}>
      {/* Cabeçalho */}
      <View style={styles.header}>
        <Text style={styles.title}>Corridas Agendadas</Text>
        {hasClaimed && (
          <View style={styles.claimedBadge}>
            <Text style={styles.claimedBadgeText}>{claimed.length} confirmada{claimed.length > 1 ? 's' : ''}</Text>
          </View>
        )}
      </View>

      {loading && isEmpty ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: 40 }} />
      ) : isEmpty ? (
        <View style={styles.empty}>
          <Text style={styles.emptyEmoji}>🗓️</Text>
          <Text style={styles.emptyTitle}>Nenhuma corrida agendada</Text>
          <Text style={styles.emptyText}>
            Passageiros que agendarem corridas aparecerão aqui.{'\n'}Fique online para receber novos pedidos.
          </Text>
        </View>
      ) : (
        <FlatList
          data={[]}
          renderItem={null}
          keyExtractor={() => ''}
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={refresh} tintColor={colors.accent} />
          }
          ListHeaderComponent={
            <>
              {/* ── Minhas corridas confirmadas ── */}
              {hasClaimed && (
                <>
                  <Text style={styles.sectionHeader}>Minhas corridas</Text>
                  {claimed.map((ride) => (
                    <ClaimedCard
                      key={ride.id}
                      ride={ride}
                      now={now}
                      colors={colors}
                      styles={styles}
                      onStart={handleStart}
                      onChat={handleChat}
                      onRelease={handleRelease}
                    />
                  ))}
                </>
              )}

              {/* ── Disponíveis para confirmar ── */}
              {hasAvailable && (
                <>
                  <Text style={styles.sectionHeader}>Disponíveis</Text>
                  {available.map((ride) => (
                    <AvailableCard
                      key={ride.id}
                      ride={ride}
                      now={now}
                      claiming={claiming === ride.id}
                      colors={colors}
                      styles={styles}
                      onClaim={handleClaim}
                    />
                  ))}
                </>
              )}
            </>
          }
          contentContainerStyle={[styles.list, Platform.OS === 'android' && { paddingBottom: 32 + insets.bottom }]}
        />
      )}
    </SafeAreaView>
  );
}

// ─── Estilos ──────────────────────────────────────────────────────────────────

function makeStyles(colors: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface },

    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 20,
      paddingTop: 12,
      paddingBottom: 8,
    },
    title: { fontSize: 22, fontWeight: '800', color: colors.text },
    claimedBadge: {
      backgroundColor: 'rgba(34,197,94,0.15)',
      borderRadius: 12,
      paddingHorizontal: 10,
      paddingVertical: 4,
    },
    claimedBadgeText: { color: colors.success, fontSize: 12, fontWeight: '700' },

    list: { paddingHorizontal: 16, paddingBottom: 32 },

    sectionHeader: {
      fontSize: 12,
      fontWeight: '700',
      color: colors.gray[500],
      textTransform: 'uppercase',
      letterSpacing: 0.8,
      marginTop: 16,
      marginBottom: 10,
    },

    // ── Cards ─────────────────────────────────────────────────────────────────
    card: {
      backgroundColor: colors.card,
      borderRadius: 16,
      padding: 16,
      marginBottom: 10,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.06,
      shadowRadius: 4,
      elevation: 2,
    },
    cardClaimed: { borderLeftWidth: 4, borderLeftColor: colors.success },
    cardNow: { borderLeftColor: '#ef4444' },

    cardTop: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: 14,
    },
    cardDate: { fontSize: 14, fontWeight: '700', color: colors.text },

    passengerRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
    passengerIcon: { fontSize: 13 },
    passengerAvatar: { width: 34, height: 34, borderRadius: 17, backgroundColor: colors.gray[200] },
    passengerAvatarFallback: {
      width: 34, height: 34, borderRadius: 17, backgroundColor: colors.gray[200],
      alignItems: 'center', justifyContent: 'center',
    },
    passengerInfo: { flex: 1 },
    passengerName: { fontSize: 13, color: colors.gray[600], fontWeight: '600' },
    passengerRating: { fontSize: 12, color: colors.gray[500], marginTop: 1 },

    countdownBadge: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      borderRadius: 10,
      borderWidth: 1,
      paddingHorizontal: 9,
      paddingVertical: 4,
    },
    countdownIcon: { fontSize: 12 },
    countdownText: { fontSize: 13, fontWeight: '800' },

    availBadge: {
      backgroundColor: colors.gray[100],
      borderRadius: 10,
      paddingHorizontal: 9,
      paddingVertical: 4,
    },
    availText: { color: colors.gray[600], fontSize: 12, fontWeight: '600' },

    // ── Rota ─────────────────────────────────────────────────────────────────
    route: { flexDirection: 'row', marginBottom: 12 },
    routeIcons: { width: 16, alignItems: 'center', paddingTop: 4 },
    dotOrigin: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.accent },
    routeLine: { flex: 1, width: 2, backgroundColor: colors.gray[200], marginVertical: 3 },
    dotDest: { width: 9, height: 9, borderRadius: 2, backgroundColor: colors.primary },
    routeAddrs: { flex: 1, marginLeft: 12 },
    addr: { fontSize: 14, color: colors.gray[800], fontWeight: '500' },
    addrDest: { marginTop: 14 },

    // ── Meta ──────────────────────────────────────────────────────────────────
    meta: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingTop: 12,
      borderTopWidth: 1,
      borderTopColor: colors.gray[100],
      marginBottom: 14,
    },
    metaText: { fontSize: 13, color: colors.gray[500] },
    metaPrice: { fontSize: 16, fontWeight: '800', color: colors.text },

    // ── Botões ────────────────────────────────────────────────────────────────
    claimBtn: {
      backgroundColor: colors.accent,
      borderRadius: 12,
      height: 46,
      alignItems: 'center',
      justifyContent: 'center',
    },
    claimBtnText: { color: colors.primary, fontSize: 15, fontWeight: '800' },

    chatBtn: {
      backgroundColor: 'rgba(201,168,76,0.12)',
      borderRadius: 12,
      height: 44,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 10,
      borderWidth: 1,
      borderColor: 'rgba(201,168,76,0.3)',
    },
    chatBtnText: { color: colors.accent, fontSize: 14, fontWeight: '700' },

    startBtn: {
      backgroundColor: colors.primary,
      borderRadius: 12,
      height: 50,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 10,
    },
    startBtnText: { color: colors.accent, fontSize: 15, fontWeight: '800' },

    releaseBtn: {
      borderRadius: 12,
      height: 40,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1.5,
      borderColor: colors.gray[300],
    },
    releaseBtnText: { color: colors.gray[500], fontSize: 13, fontWeight: '600' },

    noReleaseRow: {
      borderRadius: 12,
      height: 40,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(239,68,68,0.06)',
    },
    noReleaseText: { color: '#ef4444', fontSize: 12, fontWeight: '600' },

    // ── Empty ─────────────────────────────────────────────────────────────────
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 100 },
    emptyEmoji: { fontSize: 52, marginBottom: 16 },
    emptyTitle: { fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 8 },
    emptyText: { fontSize: 14, color: colors.gray[500], textAlign: 'center', paddingHorizontal: 36, lineHeight: 20 },
  });
}
