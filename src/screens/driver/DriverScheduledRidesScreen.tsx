import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, ScrollView, Image,
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
import { bucketScheduledRides, type ScheduleBucketKey } from '../../lib/scheduleBuckets';
import { checkScheduleConflict } from '../../lib/scheduleConflict';
import { useTranslation } from '../../i18n';

function isCancellationFree(scheduledFor?: string): boolean {
  if (!scheduledFor) return true;
  return new Date(scheduledFor).getTime() - Date.now() > 60 * 60 * 1000;
}
import { formatCurrency, formatDistance } from '../../lib/format';

// ─── Funções de tempo ─────────────────────────────────────────────────────────

type Urgency = 'normal' | 'soon' | 'imminent' | 'now';

// Descreve quanto falta sem montar a string traduzida — o componente resolve o
// texto com t(), pois hooks não podem ser chamados fora de componentes.
type TimeLeft =
  | { kind: 'none'; urgency: Urgency }
  | { kind: 'now'; urgency: Urgency }
  | { kind: 'min'; min: number; urgency: Urgency }
  | { kind: 'hm'; h: number; m: number; urgency: Urgency };

function computeTimeLeft(iso?: string, now = Date.now()): TimeLeft {
  if (!iso) return { kind: 'none', urgency: 'normal' };
  const diff = new Date(iso).getTime() - now;
  const totalMin = Math.floor(diff / 60_000);

  if (diff <= 0) return { kind: 'now', urgency: 'now' };
  if (totalMin < 5) return { kind: 'min', min: totalMin, urgency: 'now' };
  if (totalMin < 15) return { kind: 'min', min: totalMin, urgency: 'imminent' };
  if (totalMin < 60) return { kind: 'min', min: totalMin, urgency: 'soon' };

  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return { kind: 'hm', h, m, urgency: 'normal' };
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

// Horário compacto para os cards menores (pedidos por data). O rótulo do card já
// diz o período, então mostramos só o que falta para situar o pedido:
//   • hoje/amanhã     → só a hora (09:30)
//   • esta semana     → dia da semana + hora (Wed • 09:30)
//   • próximas semanas→ dia/mês + hora (Jul 14 • 09:30)
function compactWhen(iso: string | undefined, key: ScheduleBucketKey): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
  if (key === 'today' || key === 'tomorrow') return time;
  if (key === 'thisWeek') return `${d.toLocaleDateString('en-US', { weekday: 'short' })} • ${time}`;
  return `${d.toLocaleDateString('en-US', { day: '2-digit', month: 'short' })} • ${time}`;
}

// ─── Identificação do passageiro (nome + foto + avaliação) ─────────────────────

function PassengerRow({
  ride,
  styles,
}: {
  ride: RideRecord;
  styles: ReturnType<typeof makeStyles>;
}) {
  const { t } = useTranslation();
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
        <Text style={styles.passengerName} numberOfLines={1}>{ride.passenger_name ?? t('driverScheduled.passengerFallback')}</Text>
        {hasRating && (
          <Text style={styles.passengerRating}>⭐ {rating!.toFixed(1)}</Text>
        )}
      </View>
    </View>
  );
}

// ─── Card de corrida confirmada (usado dentro de "Meus agendamentos") ──────────

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
  const { t } = useTranslation();
  const timeLeft = computeTimeLeft(ride.scheduled_for, now);
  const { urgency } = timeLeft;
  const label =
    timeLeft.kind === 'none'
      ? t('driverScheduled.noTime')
      : timeLeft.kind === 'now'
      ? t('driverScheduled.now')
      : timeLeft.kind === 'min'
      ? t('driverScheduled.minutesLeft').replace('{min}', String(timeLeft.min))
      : timeLeft.m > 0
      ? t('driverScheduled.hoursMinutesLeft')
          .replace('{h}', String(timeLeft.h))
          .replace('{m}', String(timeLeft.m))
      : t('driverScheduled.hoursLeft').replace('{h}', String(timeLeft.h));
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
        {/* Duas linhas por endereço: é este o card que o motorista abre para
            saber onde buscar, e numa linha só "Residence Inn Orlando at
            FLAMINGO…" virava reticências antes de dizer a rua. */}
        <View style={styles.routeAddrs}>
          <Text style={styles.addr} numberOfLines={2}>{ride.origin_address}</Text>
          <Text style={[styles.addr, styles.addrDest]} numberOfLines={2}>{ride.destination_address}</Text>
        </View>
      </View>

      {/* Meta */}
      <View style={styles.meta}>
        <Text style={styles.metaText}>{formatDistance(ride.distance_km)} • {ride.duration_min} min</Text>
        <Text style={styles.metaPrice}>{formatCurrency(ride.price)}</Text>
      </View>

      {/* Chat com passageiro */}
      <TouchableOpacity style={styles.chatBtn} onPress={() => onChat(ride)}>
        <Text style={styles.chatBtnText}>💬  {t('driverScheduled.chatWithPassenger')}</Text>
      </TouchableOpacity>

      {/* Botão iniciar */}
      {isDue && (
        <TouchableOpacity style={styles.startBtn} onPress={() => onStart(ride)}>
          <Text style={styles.startBtnText}>🚀  {t('driverScheduled.startRideNow')}</Text>
        </TouchableOpacity>
      )}

      {/* Liberar agendamento */}
      {canRelease ? (
        <TouchableOpacity style={styles.releaseBtn} onPress={() => onRelease(ride)}>
          <Text style={styles.releaseBtnText}>{t('driverScheduled.releaseSchedule')}</Text>
        </TouchableOpacity>
      ) : (
        <View style={styles.noReleaseRow}>
          <Text style={styles.noReleaseText}>⚠️ {t('driverScheduled.lessThanHourWarning')}</Text>
        </View>
      )}
    </View>
  );
}

// ─── Linha compacta de pedido (dentro de um card de data) ──────────────────────

function RequestRow({
  ride,
  bucketKey,
  claiming,
  colors,
  styles,
  onClaim,
}: {
  ride: RideRecord;
  bucketKey: ScheduleBucketKey;
  claiming: boolean;
  colors: AppTheme;
  styles: ReturnType<typeof makeStyles>;
  onClaim: (r: RideRecord) => void;
}) {
  const { t } = useTranslation();
  return (
    <TouchableOpacity
      style={[styles.reqRow, claiming && { opacity: 0.5 }]}
      onPress={() => onClaim(ride)}
      disabled={claiming}
      activeOpacity={0.7}
    >
      <View style={styles.reqInfo}>
        <Text style={styles.reqTime}>{compactWhen(ride.scheduled_for, bucketKey)}</Text>
        <Text style={styles.reqName} numberOfLines={1}>{ride.passenger_name ?? t('driverScheduled.passengerFallback')}</Text>
        <Text style={styles.reqAddr} numberOfLines={1}>{ride.origin_address}</Text>
      </View>
      <View style={styles.reqRight}>
        {claiming
          ? <ActivityIndicator size="small" color={colors.accent} />
          : <Text style={styles.reqPrice}>{formatCurrency(ride.price)}</Text>}
        <Text style={styles.reqCta}>{t('driverScheduled.confirmCta')} ›</Text>
      </View>
    </TouchableOpacity>
  );
}

// ─── Card de um período (hoje / amanhã / esta semana / próximas semanas) ───────

function BucketCard({
  title,
  emoji,
  rides,
  bucketKey,
  claiming,
  colors,
  styles,
  onClaim,
}: {
  title: string;
  emoji: string;
  rides: RideRecord[];
  bucketKey: ScheduleBucketKey;
  claiming: string | null;
  colors: AppTheme;
  styles: ReturnType<typeof makeStyles>;
  onClaim: (r: RideRecord) => void;
}) {
  const { t } = useTranslation();
  return (
    <View style={styles.bucket}>
      <View style={styles.bucketHead}>
        <Text style={styles.bucketTitle} numberOfLines={1}>{emoji} {title}</Text>
        <View style={[styles.bucketCount, rides.length > 0 && styles.bucketCountActive]}>
          <Text style={[styles.bucketCountText, rides.length > 0 && styles.bucketCountTextActive]}>
            {rides.length}
          </Text>
        </View>
      </View>

      {rides.length === 0 ? (
        <Text style={styles.bucketEmpty}>{t('driverScheduled.noRequests')}</Text>
      ) : (
        rides.map((r) => (
          <RequestRow
            key={r.id}
            ride={r}
            bucketKey={bucketKey}
            claiming={claiming === r.id}
            colors={colors}
            styles={styles}
            onClaim={onClaim}
          />
        ))
      )}
    </View>
  );
}

// ─── Tela principal ───────────────────────────────────────────────────────────

export function DriverScheduledRidesScreen() {
  const { t } = useTranslation();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { profile } = useAuth();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const { available, claimed, loading, refresh, release } = useDriverScheduledRides(profile?.id);
  const { claimScheduledRide, activate } = useScheduledRides(profile?.id, profile?.jurisdiction);
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
      t('driverScheduled.claimTitle'),
      t('driverScheduled.claimMessage')
        .replace('{origin}', ride.origin_address)
        .replace('{date}', formatDate(ride.scheduled_for)),
      [
        { text: t('driverScheduled.cancel'), style: 'cancel' },
        {
          text: t('driverScheduled.confirm'),
          onPress: async () => {
            if (!profile?.id) return;
            setClaiming(ride.id);

            // Bloqueia o aceite se este agendamento não deixa tempo hábil em
            // relação a outro já confirmado por este motorista: fim da rota da
            // corrida existente + deslocamento (OSRM) até o próximo embarque +
            // 20 min de folga. Evita atraso ao segundo agendamento.
            const conflict = await checkScheduleConflict(ride, claimed);
            if (conflict.conflict) {
              setClaiming(null);
              const whenStr = conflict.withScheduledFor ? formatDate(conflict.withScheduledFor) : '';
              Alert.alert(
                t('driverScheduled.conflictTitle'),
                t('driverScheduled.conflictMessage') +
                  (whenStr ? t('driverScheduled.conflictWith').replace('{date}', whenStr) : ''),
              );
              return;
            }

            const ok = await claimScheduledRide(ride.id, profile.id);
            setClaiming(null);
            if (ok) {
              Alert.alert('✅ ' + t('driverScheduled.confirmedTitle'), t('driverScheduled.confirmedMessage'));
              refresh();
            } else {
              Alert.alert(t('driverScheduled.oops'), t('driverScheduled.alreadyClaimedMessage'));
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
    navigation.navigate('Chat', { rideId: ride.id, title: ride.passenger_name ?? t('driverScheduled.passengerFallback') });
  }

  function handleRelease(ride: RideRecord) {
    Alert.alert(
      t('driverScheduled.releaseTitle'),
      t('driverScheduled.releaseMessage'),
      [
        { text: t('driverScheduled.no'), style: 'cancel' },
        {
          text: t('driverScheduled.yesRelease'),
          style: 'destructive',
          onPress: async () => {
            const ok = await release(ride.id);
            if (!ok) Alert.alert(t('driverScheduled.oops'), t('driverScheduled.releaseFailedMessage'));
          },
        },
      ]
    );
  }

  const hasClaimed = claimed.length > 0;
  const hasAvailable = available.length > 0;
  const isEmpty = !hasClaimed && !hasAvailable;

  // Pedidos de passageiros agrupados por proximidade de data (item 5).
  const buckets = bucketScheduledRides(available, new Date(now));

  return (
    <SafeAreaView style={styles.container}>
      {/* Cabeçalho */}
      <View style={styles.header}>
        <Text style={styles.title}>{t('driverScheduled.headerTitle')}</Text>
      </View>

      {loading && isEmpty ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: 40 }} />
      ) : (
        <ScrollView
          refreshControl={
            <RefreshControl refreshing={loading} onRefresh={refresh} tintColor={colors.accent} />
          }
          contentContainerStyle={[
            styles.scroll,
            Platform.OS === 'android' && { paddingBottom: 32 + insets.bottom },
          ]}
        >
          {/* ── Meus agendamentos — card maior no topo ── */}
          <View style={styles.myPanel}>
            <View style={styles.myPanelHead}>
              <Text style={styles.myPanelTitle}>📌 {t('driverScheduled.mySchedules')}</Text>
              {hasClaimed && (
                <View style={styles.claimedBadge}>
                  <Text style={styles.claimedBadgeText}>
                    {(claimed.length > 1
                      ? t('driverScheduled.confirmedCountPlural')
                      : t('driverScheduled.confirmedCount')
                    ).replace('{count}', String(claimed.length))}
                  </Text>
                </View>
              )}
            </View>

            {hasClaimed ? (
              claimed.map((ride) => (
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
              ))
            ) : (
              <Text style={styles.myPanelEmpty}>
                {t('driverScheduled.myPanelEmpty')}
              </Text>
            )}
          </View>

          {/* ── Pedidos de passageiros por data — cards menores (2 por linha) ── */}
          <Text style={styles.sectionHeader}>{t('driverScheduled.passengerRequests')}</Text>

          <View style={styles.grid}>
            <View style={styles.gridRow}>
              <BucketCard
                title={t('driverScheduled.bucketToday')} emoji="🕐" rides={buckets.today} bucketKey="today"
                claiming={claiming} colors={colors} styles={styles} onClaim={handleClaim}
              />
              <BucketCard
                title={t('driverScheduled.bucketTomorrow')} emoji="🌅" rides={buckets.tomorrow} bucketKey="tomorrow"
                claiming={claiming} colors={colors} styles={styles} onClaim={handleClaim}
              />
            </View>
            <View style={styles.gridRow}>
              <BucketCard
                title={t('driverScheduled.bucketThisWeek')} emoji="🗓️" rides={buckets.thisWeek} bucketKey="thisWeek"
                claiming={claiming} colors={colors} styles={styles} onClaim={handleClaim}
              />
              <BucketCard
                title={t('driverScheduled.bucketNextWeeks')} emoji="📆" rides={buckets.nextWeeks} bucketKey="nextWeeks"
                claiming={claiming} colors={colors} styles={styles} onClaim={handleClaim}
              />
            </View>
          </View>

          {isEmpty && (
            <View style={styles.empty}>
              <Text style={styles.emptyEmoji}>🗓️</Text>
              <Text style={styles.emptyText}>
                {t('driverScheduled.emptyLine1')}{'\n'}{t('driverScheduled.emptyLine2')}
              </Text>
            </View>
          )}
        </ScrollView>
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

    scroll: { paddingHorizontal: 16, paddingBottom: 32 },

    // ── "Meus agendamentos": painel maior no topo ──────────────────────────────
    myPanel: {
      backgroundColor: 'rgba(201,168,76,0.08)',
      borderRadius: 20,
      borderWidth: 1,
      borderColor: 'rgba(201,168,76,0.25)',
      padding: 12,
      marginTop: 8,
      marginBottom: 8,
    },
    myPanelHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 4,
      marginBottom: 10,
    },
    myPanelTitle: { fontSize: 17, fontWeight: '800', color: colors.text },
    myPanelEmpty: {
      fontSize: 13,
      color: colors.gray[500],
      lineHeight: 19,
      paddingHorizontal: 6,
      paddingVertical: 10,
    },

    sectionHeader: {
      fontSize: 12,
      fontWeight: '700',
      color: colors.gray[500],
      textTransform: 'uppercase',
      letterSpacing: 0.8,
      marginTop: 16,
      marginBottom: 10,
      marginLeft: 4,
    },

    // ── Grade 2×2 de cards de data ─────────────────────────────────────────────
    grid: { gap: 10 },
    gridRow: { flexDirection: 'row', gap: 10, alignItems: 'flex-start' },
    bucket: {
      flex: 1,
      backgroundColor: colors.card,
      borderRadius: 16,
      padding: 12,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.06,
      shadowRadius: 4,
      elevation: 2,
    },
    bucketHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 8,
    },
    bucketTitle: { flex: 1, fontSize: 13, fontWeight: '800', color: colors.text },
    bucketCount: {
      minWidth: 22,
      height: 22,
      borderRadius: 11,
      paddingHorizontal: 6,
      backgroundColor: colors.gray[100],
      alignItems: 'center',
      justifyContent: 'center',
    },
    bucketCountActive: { backgroundColor: colors.accent },
    bucketCountText: { fontSize: 12, fontWeight: '800', color: colors.gray[500] },
    bucketCountTextActive: { color: colors.primary },
    bucketEmpty: { fontSize: 12, color: colors.gray[400], paddingVertical: 6 },

    // ── Linha de pedido dentro do card de data ─────────────────────────────────
    reqRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 8,
      borderTopWidth: 1,
      borderTopColor: colors.gray[100],
      gap: 6,
    },
    reqInfo: { flex: 1 },
    reqTime: { fontSize: 13, fontWeight: '800', color: colors.text },
    reqName: { fontSize: 12, color: colors.gray[600], fontWeight: '600', marginTop: 1 },
    reqAddr: { fontSize: 11, color: colors.gray[400], marginTop: 1 },
    reqRight: { alignItems: 'flex-end' },
    reqPrice: { fontSize: 13, fontWeight: '800', color: colors.text },
    reqCta: { fontSize: 11, fontWeight: '700', color: colors.accent, marginTop: 2 },

    // ── Cards (confirmadas) ────────────────────────────────────────────────────
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
    empty: { alignItems: 'center', justifyContent: 'center', paddingTop: 24, paddingBottom: 16 },
    emptyEmoji: { fontSize: 44, marginBottom: 12 },
    emptyText: { fontSize: 14, color: colors.gray[500], textAlign: 'center', paddingHorizontal: 36, lineHeight: 20 },
  });
}
