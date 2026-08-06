import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { AppTheme } from '../../constants/theme';
import { useTheme } from '../../hooks/useTheme';
import { useTranslation } from '../../i18n';
import { rideOrigin, rideDestination } from '../../lib/ride';
import { formatCountdown } from '../../lib/scheduledRides';
import type { RideRecord } from '../../types';

type Props = {
  ride: RideRecord;
  minutesUntil: number;
  imminent: boolean;
  onPress: () => void;
};

/**
 * ScheduledRideBanner — banner fixo com a próxima corrida agendada + contagem
 * regressiva ao vivo (P2). Compartilhado entre motorista (mapa da DriverHome)
 * e passageiro (mapa da HomeScreen): é puramente apresentacional, então a
 * decisão de exibir, o alerta sonoro e o destino do toque ficam no container.
 *
 * Quando `imminent` (dentro da janela de lembrete), ganha destaque de urgência.
 */
export function ScheduledRideBanner({ ride, minutesUntil, imminent, onPress }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = makeStyles(colors);

  const when = ride.scheduled_for
    ? new Date(ride.scheduled_for).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    : '';
  const countdown = formatCountdown(minutesUntil);

  return (
    <TouchableOpacity
      style={[styles.banner, imminent && styles.bannerImminent]}
      onPress={onPress}
      activeOpacity={0.85}
    >
      <View style={styles.row}>
        <Text style={styles.icon}>🗓️</Text>
        <View style={styles.textCol}>
          <Text style={styles.title} numberOfLines={1}>
            {imminent ? t('scheduledBanner.imminentTitle', 'Scheduled ride coming up!')
                      : t('scheduledBanner.title', 'Scheduled ride')}
          </Text>
          <Text style={styles.route} numberOfLines={1}>
            {rideOrigin(ride).address} → {rideDestination(ride).address}
          </Text>
        </View>
        <View style={styles.timeCol}>
          <Text style={[styles.countdown, imminent && styles.countdownImminent]}>{countdown}</Text>
          {!!when && <Text style={styles.when}>{when}</Text>}
        </View>
      </View>
    </TouchableOpacity>
  );
}

function makeStyles(colors: AppTheme) {
  return StyleSheet.create({
    banner: {
      marginHorizontal: 16,
      marginTop: 10,
      backgroundColor: 'rgba(26,26,46,0.92)',
      borderRadius: 12,
      paddingVertical: 12,
      paddingHorizontal: 14,
      borderWidth: 1,
      borderColor: 'rgba(201,168,76,0.4)',
    },
    bannerImminent: {
      backgroundColor: 'rgba(201,168,76,0.18)',
      borderColor: colors.accent,
      borderWidth: 1.5,
    },
    row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    icon: { fontSize: 26 },
    textCol: { flex: 1 },
    title: { color: colors.accent, fontSize: 14, fontWeight: '800' },
    route: { color: colors.gray[300], fontSize: 12, marginTop: 2 },
    timeCol: { alignItems: 'flex-end' },
    countdown: { color: colors.white, fontSize: 15, fontWeight: '800' },
    countdownImminent: { color: colors.accent },
    when: { color: colors.gray[400], fontSize: 11, marginTop: 2 },
  });
}
