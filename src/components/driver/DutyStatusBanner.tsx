import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { AppTheme } from '../../constants/theme';
import { useTheme } from '../../hooks/useTheme';
import { useTranslation } from '../../i18n';
import { formatHm, type DutyStatus } from '../../lib/drivingLimits';

type Props = {
  status: DutyStatus;
  warn: boolean;
};

const clock = (d: Date | null) =>
  d ? d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) : '';

/**
 * DutyStatusBanner — aviso do limite de direção no mapa do motorista (P3).
 *   • mustRest  → banner de descanso obrigatório (com horário de liberação).
 *   • warn      → banner de "limite se aproximando" (tempo restante).
 *   • senão     → não renderiza nada.
 */
export function DutyStatusBanner({ status, warn }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const styles = makeStyles(colors);

  if (status.mustRest) {
    return (
      <View style={[styles.banner, styles.rest]}>
        <Text style={styles.icon}>😴</Text>
        <View style={styles.textCol}>
          <Text style={styles.restTitle}>{t('duty.restTitle', 'Mandatory rest')}</Text>
          <Text style={[styles.body, styles.restBody]}>
            {t('duty.restBody', 'Driving limit reached. Back online at')} {clock(status.restUntil)}
          </Text>
        </View>
      </View>
    );
  }

  if (warn) {
    return (
      <View style={[styles.banner, styles.warn]}>
        <Text style={styles.icon}>⏳</Text>
        <View style={styles.textCol}>
          <Text style={styles.warnTitle}>{t('duty.warnTitle', 'Driving limit approaching')}</Text>
          <Text style={[styles.body, styles.warnBody]}>
            {formatHm(status.remainingMinutes)} {t('duty.warnBody', 'left before mandatory rest')}
          </Text>
        </View>
      </View>
    );
  }

  return null;
}

function makeStyles(colors: AppTheme) {
  return StyleSheet.create({
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      marginHorizontal: 16,
      marginTop: 10,
      borderRadius: 12,
      paddingVertical: 12,
      paddingHorizontal: 14,
      borderWidth: 1.5,
    },
    rest: { backgroundColor: colors.error, borderColor: colors.black, borderWidth: 2 },
    warn: { backgroundColor: colors.accent, borderColor: colors.black, borderWidth: 2 },
    icon: { fontSize: 24 },
    textCol: { flex: 1 },
    restTitle: { color: colors.black, fontSize: 14, fontWeight: '800' },
    warnTitle: { color: colors.black, fontSize: 14, fontWeight: '800' },
    body: { color: colors.gray[300], fontSize: 12, marginTop: 2 },
    // Nos dois banners sólidos (vermelho de descanso e âmbar de aviso) o texto
    // do corpo vira PRETO para contrastar com o fundo cheio.
    restBody: { color: colors.black },
    warnBody: { color: colors.black },
  });
}
