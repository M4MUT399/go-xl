import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { AppTheme } from '../../constants/theme';
import { useTheme } from '../../hooks/useTheme';
import { useTranslation } from '../../i18n';
import { rideOrigin, rideDestination } from '../../lib/ride';
import { countdownFor } from '../../lib/scheduledRides';
import type { RideRecord } from '../../types';

type Props = {
  ride: RideRecord;
  minutesUntil: number;
  imminent: boolean;
  onPress: () => void;
  /** Nome do passageiro — só o motorista mostra (o passageiro é ele mesmo). */
  passengerName?: string | null;
  /** Chamada de ação no rodapé. Ausente = banner só informativo. */
  ctaLabel?: string;
};

/**
 * ScheduledRideBanner — banner fixo com a próxima corrida agendada + contagem
 * regressiva ao vivo (P2). Compartilhado entre motorista (mapa da DriverHome)
 * e passageiro (mapa da HomeScreen): é puramente apresentacional, então a
 * decisão de exibir, o alerta sonoro e o destino do toque ficam no container.
 *
 * O ENDEREÇO DE EMBARQUE é o dado principal, não um detalhe: na hora de sair
 * para buscar, é o que o motorista precisa ler. Por isso ele ganha rótulo
 * próprio e até duas linhas — antes origem e destino dividiam uma única linha
 * de 12px e o nome do hotel morria em reticências.
 *
 * Quando `imminent` (dentro da janela de lembrete), ganha destaque de urgência.
 */
export function ScheduledRideBanner({
  ride,
  minutesUntil,
  imminent,
  onPress,
  passengerName,
  ctaLabel,
}: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = makeStyles(colors);

  const when = ride.scheduled_for
    ? new Date(ride.scheduled_for).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    : '';

  const c = countdownFor(minutesUntil);
  const countdown =
    c.kind === 'none'
      ? ''
      : c.kind === 'now'
      ? t('scheduledBanner.now', 'now')
      : c.kind === 'late'
      ? t('scheduledBanner.late', '{min} min late').replace('{min}', String(c.min))
      : c.kind === 'min'
      ? `${c.min} min`
      : c.m === 0
      ? `${c.h}h`
      : `${c.h}h ${c.m}min`;
  const late = c.kind === 'late';

  return (
    <TouchableOpacity
      style={[styles.banner, imminent && styles.bannerImminent]}
      onPress={onPress}
      activeOpacity={0.85}
    >
      <View style={styles.headRow}>
        <Text style={styles.icon}>🗓️</Text>
        <View style={styles.textCol}>
          <Text style={styles.title} numberOfLines={1}>
            {imminent ? t('scheduledBanner.imminentTitle', 'Scheduled ride coming up!')
                      : t('scheduledBanner.title', 'Scheduled ride')}
          </Text>
          {!!passengerName && (
            <Text style={styles.passenger} numberOfLines={1}>👤 {passengerName}</Text>
          )}
        </View>
        <View style={styles.timeCol}>
          <Text style={[styles.countdown, imminent && styles.countdownImminent, late && styles.countdownLate]}>
            {countdown}
          </Text>
          {!!when && <Text style={styles.when}>{when}</Text>}
        </View>
      </View>

      <View style={styles.addrBlock}>
        <Text style={styles.addrLabel}>📍 {t('driverCall.pickup', 'Pickup')}</Text>
        <Text style={styles.addrPickup} numberOfLines={2}>{rideOrigin(ride).address}</Text>
        <Text style={[styles.addrLabel, styles.addrLabelSecond]}>🏁 {t('driverCall.dropoff', 'Drop-off')}</Text>
        <Text style={styles.addrDrop} numberOfLines={1}>{rideDestination(ride).address}</Text>
      </View>

      {!!ctaLabel && <Text style={styles.cta}>{ctaLabel} ›</Text>}
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
    headRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    icon: { fontSize: 26 },
    textCol: { flex: 1 },
    title: { color: colors.accent, fontSize: 14, fontWeight: '800' },
    passenger: { color: colors.gray[300], fontSize: 12, marginTop: 2 },
    timeCol: { alignItems: 'flex-end' },
    countdown: { color: colors.white, fontSize: 15, fontWeight: '800' },
    countdownImminent: { color: colors.accent },
    countdownLate: { color: '#ef4444' },
    when: { color: colors.gray[400], fontSize: 11, marginTop: 2 },

    addrBlock: {
      marginTop: 10,
      paddingTop: 10,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: 'rgba(255,255,255,0.15)',
    },
    addrLabel: {
      color: colors.gray[400],
      fontSize: 10,
      fontWeight: '700',
      letterSpacing: 0.5,
      textTransform: 'uppercase',
    },
    addrLabelSecond: { marginTop: 8 },
    addrPickup: { color: colors.white, fontSize: 14, fontWeight: '700', marginTop: 2, lineHeight: 18 },
    addrDrop: { color: colors.gray[300], fontSize: 12, marginTop: 2 },

    cta: { color: colors.accent, fontSize: 13, fontWeight: '800', marginTop: 10, textAlign: 'center' },
  });
}
