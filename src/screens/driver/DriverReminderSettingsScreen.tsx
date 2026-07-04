import React, { useEffect, useState } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, ScrollView, Switch, TouchableOpacity, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../../hooks/useTheme';
import { useAuth } from '../../hooks/useAuth';
import { showLocalNotification } from '../../lib/notifications';
import {
  REMINDER_OFFSETS,
  DEFAULT_REMINDER_PREFS,
  loadReminderPrefs,
  saveReminderPrefs,
  syncDriverReminders,
  type ReminderKey,
  type ReminderPrefs,
} from '../../lib/driverReminders';

/**
 * Aba exclusiva do motorista para configurar os lembretes de corridas
 * agendadas (2h, 1h, 30min e 15min antes). Cada aviso pode ser ligado/desligado
 * de forma independente. As preferências ficam salvas no dispositivo e, a cada
 * mudança, os lembretes são reagendados na hora.
 */
export function DriverReminderSettingsScreen() {
  const { colors } = useTheme();
  const { profile } = useAuth();
  const insets = useSafeAreaInsets();
  const [prefs, setPrefs] = useState<ReminderPrefs>(DEFAULT_REMINDER_PREFS);
  const [testSent, setTestSent] = useState(false);

  const driverId = profile?.id;
  const styles = makeStyles(colors);

  useEffect(() => {
    loadReminderPrefs().then(setPrefs);
  }, []);

  async function toggle(key: ReminderKey) {
    const next = { ...prefs, [key]: !prefs[key] };
    setPrefs(next);
    await saveReminderPrefs(next);
    // Reagenda imediatamente com as novas preferências.
    syncDriverReminders(driverId);
  }

  async function sendTest() {
    await showLocalNotification(
      '🔔 Lembrete de teste',
      'É assim que você será avisado antes das suas corridas agendadas.',
      { type: 'sched_reminder_test' }
    );
    setTestSent(true);
    setTimeout(() => setTestSent(false), 2500);
  }

  const anyOn = REMINDER_OFFSETS.some((o) => prefs[o.key]);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          Platform.OS === 'android' && { paddingBottom: 24 + insets.bottom },
        ]}
      >
        <Text style={styles.title}>Lembretes</Text>
        <Text style={styles.subtitle}>
          Avisos antes das suas corridas agendadas, para você se programar e buscar o passageiro a tempo.
        </Text>

        <View style={styles.card}>
          {REMINDER_OFFSETS.map((item, i) => (
            <View
              key={item.key}
              style={[styles.row, i < REMINDER_OFFSETS.length - 1 && styles.rowBorder]}
            >
              <View style={styles.rowText}>
                <Text style={styles.rowTitle}>{item.label}</Text>
                <Text style={styles.rowDesc}>{item.desc}</Text>
              </View>
              <Switch
                value={prefs[item.key]}
                onValueChange={() => toggle(item.key)}
                trackColor={{ true: colors.accent, false: colors.gray[300] }}
                thumbColor={colors.white}
              />
            </View>
          ))}
        </View>

        {!anyOn && (
          <Text style={styles.warn}>
            ⚠️ Todos os lembretes estão desligados — você não receberá avisos antes dos agendamentos.
          </Text>
        )}

        <TouchableOpacity style={styles.testButton} onPress={sendTest} activeOpacity={0.85}>
          <Text style={styles.testButtonText}>
            {testSent ? '✓ Enviado — confira sua tela' : 'Testar notificação agora'}
          </Text>
        </TouchableOpacity>

        <Text style={styles.note}>
          Os avisos disparam mesmo com o app fechado ou o celular bloqueado. As preferências ficam
          salvas neste dispositivo e dependem da permissão de notificações do sistema.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(colors: ReturnType<typeof useTheme>['colors']) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.surface },
    scroll: { padding: 24 },
    title: { fontSize: 26, fontWeight: '800', color: colors.text, marginBottom: 6 },
    subtitle: { fontSize: 14, color: colors.gray[500], marginBottom: 24, lineHeight: 20 },
    card: { backgroundColor: colors.card, borderRadius: 16, paddingHorizontal: 16 },
    row: { flexDirection: 'row', alignItems: 'center', paddingVertical: 16 },
    rowBorder: { borderBottomWidth: 1, borderBottomColor: colors.gray[100] },
    rowText: { flex: 1, paddingRight: 12 },
    rowTitle: { fontSize: 15, fontWeight: '600', color: colors.gray[800] },
    rowDesc: { fontSize: 12, color: colors.gray[500], marginTop: 2 },
    warn: { fontSize: 13, color: colors.error, marginTop: 16, lineHeight: 18 },
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
