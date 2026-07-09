import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, ScrollView, Switch, TouchableOpacity, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../hooks/useTheme';
import { useAuth } from '../../hooks/useAuth';
import { showLocalNotification } from '../../lib/notifications';
import { playScheduledReminderSound } from '../../hooks/useScheduledReminderAlert';
import { ScheduledRideBanner } from '../../components/driver/ScheduledRideBanner';
import { useTranslation } from '../../i18n';
import type { RideRecord } from '../../types';
import {
  REMINDER_OFFSETS,
  DEFAULT_REMINDER_PREFS,
  loadReminderPrefs,
  saveReminderPrefs,
  syncDriverReminders,
  type ReminderKey,
  type ReminderPrefs,
} from '../../lib/driverReminders';

/** Corrida fictícia só para o botão de teste renderizar o banner real. */
function buildTestRide(originAddress: string, destinationAddress: string): RideRecord {
  const now = new Date();
  return {
    id: 'test-reminder',
    passenger_id: 'test',
    origin_lat: 28.5383,
    origin_lng: -81.3792,
    origin_address: originAddress,
    destination_lat: 28.4312,
    destination_lng: -81.3081,
    destination_address: destinationAddress,
    status: 'scheduled',
    scheduled_for: new Date(now.getTime() + 15 * 60_000).toISOString(),
    created_at: now.toISOString(),
  };
}

/**
 * Aba exclusiva do motorista para configurar os lembretes de corridas
 * agendadas (2h, 1h, 30min e 15min antes).
 *
 * Os avisos de 30min e 15min são OBRIGATÓRIOS: ficam sempre vinculados a
 * TODA viagem agendada e não podem ser desligados, garantindo que o
 * motorista sempre receba pelo menos um toque no celular antes do embarque.
 * 2h e 1h continuam opcionais. As preferências ficam salvas no dispositivo
 * e, a cada mudança, os lembretes são reagendados na hora.
 */
export function DriverReminderSettingsScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const { profile } = useAuth();
  const insets = useSafeAreaInsets();
  const [prefs, setPrefs] = useState<ReminderPrefs>(DEFAULT_REMINDER_PREFS);
  const [testSent, setTestSent] = useState(false);
  const [testBannerRide, setTestBannerRide] = useState<RideRecord | null>(null);

  const driverId = profile?.id;
  const styles = makeStyles(colors);

  useEffect(() => {
    loadReminderPrefs().then(setPrefs);
  }, []);

  async function toggle(key: ReminderKey, mandatory: boolean) {
    if (mandatory) return; // obrigatório — não pode ser desligado
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    await saveReminderPrefs(next);
    // Reagenda imediatamente com as novas preferências.
    syncDriverReminders(driverId);
  }

  async function sendTest() {
    // 1) Push do sistema (confirma que a permissão/config de notificação
    //    está OK) — silenciado em foreground (ver FOREGROUND_SILENT_TYPES)
    //    para não duplicar com o som e o banner abaixo.
    await showLocalNotification(
      `🔔 ${t('reminder.testNotifTitle')}`,
      t('reminder.testNotifBody'),
      { type: 'sched_reminder_test' }
    );
    // 2) Mesmo som (notification.wav) + vibração que tocam de verdade
    //    quando uma corrida agendada fica iminente.
    playScheduledReminderSound();
    // 3) Mesmo banner "corrida agendada" que aparece no mapa do motorista.
    setTestBannerRide(buildTestRide(t('reminder.testOriginAddress'), t('reminder.testDestinationAddress')));
    setTimeout(() => setTestBannerRide(null), 6000);

    setTestSent(true);
    setTimeout(() => setTestSent(false), 2500);
  }

  const optionalAllOff = REMINDER_OFFSETS.filter((o) => !o.mandatory).every((o) => !prefs[o.key]);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          Platform.OS === 'android' && { paddingBottom: 24 + insets.bottom },
        ]}
      >
        <Text style={styles.title}>{t('reminder.title').replace('{br}', '\n')}</Text>
        <Text style={styles.subtitle}>
          {t('reminder.subtitle')}
        </Text>

        {testBannerRide && (
          <ScheduledRideBanner
            ride={testBannerRide}
            minutesUntil={15}
            imminent
            onPress={() => setTestBannerRide(null)}
          />
        )}

        <View style={styles.card}>
          {REMINDER_OFFSETS.map((item, i) => (
            <View
              key={item.key}
              style={[styles.row, i < REMINDER_OFFSETS.length - 1 && styles.rowBorder]}
            >
              <View style={styles.rowText}>
                <View style={styles.rowTitleLine}>
                  <Text style={styles.rowTitle}>{t(`reminder.label_${item.key}`)}</Text>
                  {item.mandatory && (
                    <View style={styles.lockBadge}>
                      <Text style={styles.lockBadgeText}>{t('reminder.alwaysOn')}</Text>
                    </View>
                  )}
                </View>
                <Text style={styles.rowDesc}>{t(`reminder.desc_${item.key}`)}</Text>
              </View>
              <Switch
                value={item.mandatory ? true : prefs[item.key]}
                onValueChange={() => toggle(item.key, item.mandatory)}
                disabled={item.mandatory}
                trackColor={{ true: colors.accent, false: colors.gray[300] }}
                thumbColor={colors.white}
              />
            </View>
          ))}
        </View>

        <Text style={styles.mandatoryNote}>
          🔒 {t('reminder.mandatoryNote')}
        </Text>

        {optionalAllOff && (
          <Text style={styles.warn}>
            ⚠️ {t('reminder.optionalAllOffWarn')}
          </Text>
        )}

        <TouchableOpacity style={styles.testButton} onPress={sendTest} activeOpacity={0.85}>
          <Text style={styles.testButtonText}>
            {testSent ? `✓ ${t('reminder.testButtonSent')}` : t('reminder.testButton')}
          </Text>
        </TouchableOpacity>

        <Text style={styles.note}>
          {t('reminder.footerNote')}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface },
    scroll: { padding: 24 },
    title: { fontSize: 30, fontWeight: '800', color: colors.text, lineHeight: 36, marginBottom: 10 },
    subtitle: { fontSize: 14, color: colors.gray[500], marginBottom: 24, lineHeight: 20 },
    card: { backgroundColor: colors.card, borderRadius: 16, paddingHorizontal: 16 },
    row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 16 },
    rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.gray[100] },
    rowText: { flex: 1, paddingRight: 12 },
    rowTitleLine: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8 },
    rowTitle: { fontSize: 15, fontWeight: '600', color: colors.gray[800] },
    rowDesc: { fontSize: 12, color: colors.gray[500], marginTop: 2 },
    lockBadge: {
      backgroundColor: colors.accent,
      borderRadius: 8,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    lockBadgeText: { fontSize: 9, fontWeight: '800', color: colors.primary, letterSpacing: 0.5 },
    mandatoryNote: { fontSize: 12, color: colors.gray[500], marginTop: 16, lineHeight: 18 },
    warn: { fontSize: 13, color: colors.error, marginTop: 12, lineHeight: 18 },
    testButton: {
      marginTop: 24,
      paddingVertical: 14,
      borderRadius: 12,
      backgroundColor: colors.primary,
      alignItems: 'center',
    },
    testButtonText: { color: colors.white, fontSize: 15, fontWeight: '700' },
    note: { fontSize: 12, color: colors.gray[400], marginTop: 16, lineHeight: 18 },
  });
}
