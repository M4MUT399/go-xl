import React, { useState, useMemo } from 'react';
import { View, Text, StyleSheet, SafeAreaView, FlatList, RefreshControl, ActivityIndicator, TouchableOpacity, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useAuth } from '../../hooks/useAuth';
import { useRideHistory } from '../../hooks/useRideHistory';
import { useTheme } from '../../hooks/useTheme';
import { useTranslation } from '../../i18n';
import { AppTheme } from '../../constants/theme';
import { formatCurrency, formatDistance } from '../../lib/format';
import type { RideRecord, RootStackParamList } from '../../types';

type Filter = 'all' | 'completed' | 'scheduled' | 'cancelled';

const FILTERS: { key: Filter; labelKey: string }[] = [
  { key: 'all', labelKey: 'history.filterAll' },
  { key: 'completed', labelKey: 'history.filterCompleted' },
  { key: 'scheduled', labelKey: 'history.filterScheduled' },
  { key: 'cancelled', labelKey: 'history.filterCancelled' },
];

export function TripHistoryScreen() {
  const { profile } = useAuth();
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { rides, loading, error, refresh } = useRideHistory(profile?.id, 'passenger');
  const [filter, setFilter] = useState<Filter>('all');

  const styles = makeStyles(colors);

  useFocusEffect(
    React.useCallback(() => {
      refresh();
    }, [refresh])
  );

  const filtered = useMemo(
    () => (filter === 'all' ? rides : rides.filter((r) => r.status === filter)),
    [rides, filter]
  );

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>{t('history.title')}</Text>
        <Text style={styles.subtitle}>{filtered.length} {filtered.length === 1 ? t('history.rideSingular') : t('history.ridePlural')}</Text>
      </View>

      <View style={styles.tabsWrap}>
        {FILTERS.map((f) => (
          <TouchableOpacity
            key={f.key}
            style={[styles.tab, filter === f.key && styles.tabActive]}
            onPress={() => setFilter(f.key)}
          >
            <Text style={[styles.tabText, filter === f.key && styles.tabTextActive]}>{t(f.labelKey)}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {loading && rides.length === 0 ? (
        <ActivityIndicator color={colors.accent} style={{ marginTop: 40 }} />
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => item.id}
          contentContainerStyle={[styles.list, Platform.OS === 'android' && { paddingBottom: 24 + insets.bottom }]}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} tintColor={colors.accent} />}
          ListEmptyComponent={
            error ? (
              <View style={styles.empty}>
                <Text style={styles.emptyEmoji}>⚠️</Text>
                <Text style={styles.emptyTitle}>{t('history.loadError')}</Text>
                <Text style={styles.emptyText}>{error}</Text>
                <TouchableOpacity style={styles.retryButton} onPress={refresh}>
                  <Text style={styles.retryButtonText}>{t('history.retry')}</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.empty}>
                <Text style={styles.emptyEmoji}>🚗</Text>
                <Text style={styles.emptyTitle}>{t('history.emptyTitle')}</Text>
                <Text style={styles.emptyText}>{t('history.emptyText')}</Text>
              </View>
            )
          }
          renderItem={({ item }) => (
            <TripCard
              ride={item}
              styles={styles}
              colors={colors}
              onPress={() => navigation.navigate('TripDetails', { ride: item })}
            />
          )}
        />
      )}
    </SafeAreaView>
  );
}

function statusInfo(ride: RideRecord) {
  switch (ride.status) {
    case 'completed':
      return { labelKey: 'history.statusCompleted', style: 'completed' as const };
    case 'cancelled':
      return { labelKey: 'history.statusCancelled', style: 'cancelled' as const };
    case 'scheduled':
      return { labelKey: 'history.statusScheduled', style: 'scheduled' as const };
    default:
      return { labelKey: 'history.statusInProgress', style: 'scheduled' as const };
  }
}

function TripCard({ ride, styles, colors, onPress }: { ride: RideRecord; styles: ReturnType<typeof makeStyles>; colors: AppTheme; onPress: () => void }) {
  const { t } = useTranslation();
  const info = statusInfo(ride);
  const isScheduled = ride.status === 'scheduled';
  const refDate = isScheduled && ride.scheduled_for ? new Date(ride.scheduled_for) : new Date(ride.created_at);

  return (
    <TouchableOpacity style={styles.card} onPress={onPress} activeOpacity={0.7}>
      <View style={styles.cardTop}>
        <Text style={styles.cardDate}>
          {isScheduled ? '🗓️ ' : ''}
          {refDate.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' })}
          {' • '}
          {refDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
        </Text>
        <View style={[styles.badge, styles[`badge_${info.style}`]]}>
          <Text style={[styles.badgeText, styles[`badgeText_${info.style}`]]}>{t(info.labelKey)}</Text>
        </View>
      </View>

      <View style={styles.route}>
        <View style={styles.routeIcons}>
          <View style={styles.dotOrigin} />
          <View style={styles.routeLine} />
          <View style={styles.dotDest} />
        </View>
        <View style={styles.routeText}>
          <Text style={styles.addr} numberOfLines={1}>{ride.origin_address}</Text>
          <Text style={[styles.addr, { marginTop: 16 }]} numberOfLines={1}>{ride.destination_address}</Text>
        </View>
      </View>

      {ride.status !== 'cancelled' && (
        <View style={styles.cardFooter}>
          <Text style={styles.distance}>{formatDistance(ride.distance_km)}</Text>
          <View style={styles.footerRight}>
            {ride.status === 'completed' && (
              <Text style={[styles.payTag, ride.paid ? styles.payTagPaid : styles.payTagUnpaid]}>
                {ride.paid ? t('history.paid') : t('history.unpaid')}
              </Text>
            )}
            <Text style={styles.price}>{formatCurrency(ride.price)}</Text>
          </View>
        </View>
      )}
    </TouchableOpacity>
  );
}

function makeStyles(colors: AppTheme) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface },
    header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 },
    title: { fontSize: 28, fontWeight: '800', color: colors.text },
    subtitle: { fontSize: 14, color: colors.gray[500], marginTop: 2 },
    tabsWrap: { flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
    tab: { flex: 1, paddingVertical: 8, borderRadius: 9, alignItems: 'center', backgroundColor: colors.card },
    tabActive: { backgroundColor: colors.primary },
    tabText: { fontSize: 12, fontWeight: '600', color: colors.gray[500] },
    tabTextActive: { color: colors.white },
    list: { paddingHorizontal: 16, paddingBottom: 24, flexGrow: 1 },
    card: {
      backgroundColor: colors.card,
      borderRadius: 16,
      padding: 16,
      marginBottom: 12,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.05,
      shadowRadius: 8,
      elevation: 2,
    },
    cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
    cardDate: { fontSize: 12, color: colors.gray[500] },
    badge: { borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
    badge_completed: { backgroundColor: 'rgba(34,197,94,0.12)' },
    badge_cancelled: { backgroundColor: 'rgba(239,68,68,0.12)' },
    badge_scheduled: { backgroundColor: 'rgba(201,168,76,0.15)' },
    badgeText: { fontSize: 11, fontWeight: '700' },
    badgeText_completed: { color: colors.success },
    badgeText_cancelled: { color: colors.error },
    badgeText_scheduled: { color: colors.accent },
    route: { flexDirection: 'row' },
    routeIcons: { width: 16, alignItems: 'center', paddingTop: 4 },
    dotOrigin: { width: 9, height: 9, borderRadius: 5, backgroundColor: colors.accent },
    routeLine: { flex: 1, width: 2, backgroundColor: colors.gray[200], marginVertical: 3 },
    dotDest: { width: 9, height: 9, borderRadius: 2, backgroundColor: colors.primary },
    routeText: { flex: 1, marginLeft: 12 },
    addr: { fontSize: 14, color: colors.gray[800], fontWeight: '500' },
    cardFooter: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginTop: 14,
      paddingTop: 12,
      borderTopWidth: 1,
      borderTopColor: colors.gray[100],
    },
    distance: { fontSize: 13, color: colors.gray[500] },
    footerRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    payTag: { fontSize: 11, fontWeight: '700', overflow: 'hidden', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 },
    payTagPaid: { color: colors.success, backgroundColor: 'rgba(34,197,94,0.12)' },
    payTagUnpaid: { color: colors.gray[500], backgroundColor: colors.gray[100] },
    price: { fontSize: 17, fontWeight: '800', color: colors.primary },
    empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
    emptyEmoji: { fontSize: 48, marginBottom: 16 },
    emptyTitle: { fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 6 },
    emptyText: { fontSize: 14, color: colors.gray[500], textAlign: 'center' },
    retryButton: {
      marginTop: 20,
      paddingHorizontal: 20,
      paddingVertical: 10,
      borderRadius: 10,
      backgroundColor: colors.primary,
    },
    retryButtonText: { color: colors.white, fontSize: 14, fontWeight: '700' },
  });
}
