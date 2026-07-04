// driverReminders — lembretes locais escalonados de corridas AGENDADAS (motorista).
//
// Objetivo: avisar o motorista 2h, 1h, 30min e 15min ANTES de um agendamento que
// ele confirmou, para que ele se programe e consiga buscar o passageiro a tempo.
//
// Por que notificação LOCAL agendada (e não polling em primeiro plano):
//   `Notifications.scheduleNotificationAsync` com trigger de DATA entrega a
//   notificação no horário marcado pelo próprio SISTEMA — dispara mesmo com o
//   app fechado ou o celular bloqueado. Os alertas sonoros in-app existentes
//   (useScheduledReminderAlert) só tocam com o app aberto; estes complementam.
//
// Idempotência: cada (corrida × offset) tem um identifier determinístico
// (`goxl-sched-<rideId>-<key>`). Antes de reagendar, cancelamos todos os nossos
// para remover lembretes de corridas liberadas/canceladas e evitar duplicatas.

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from './supabase';
import { ensureNotificationPermissions } from './notifications';
import { reportError } from './errorReporting';

const PREFS_KEY = '@goxl:driver_reminder_prefs';
const ID_PREFIX = 'goxl-sched-';
const CHANNEL_ID = 'reminders';

export type ReminderKey = 'h2' | 'h1' | 'm30' | 'm15';
export type ReminderPrefs = Record<ReminderKey, boolean>;

/** Ordem de exibição = ordem cronológica dos avisos (mais cedo → mais tarde). */
export const REMINDER_OFFSETS: {
  key: ReminderKey;
  minutes: number;
  label: string;
  desc: string;
  title: string;
  body: (place: string) => string;
}[] = [
  {
    key: 'h2',
    minutes: 120,
    label: '2 horas antes',
    desc: 'Aviso antecipado para você se organizar',
    title: '🗓️ Corrida agendada em 2 horas',
    body: (p) => `Você tem uma corrida agendada em 2 horas${p ? ` — embarque em ${p}` : ''}.`,
  },
  {
    key: 'h1',
    minutes: 60,
    label: '1 hora antes',
    desc: 'Hora de começar a se preparar',
    title: '🗓️ Corrida agendada em 1 hora',
    body: (p) => `Você tem uma corrida agendada em 1 hora${p ? ` — embarque em ${p}` : ''}.`,
  },
  {
    key: 'm30',
    minutes: 30,
    label: '30 minutos antes',
    desc: 'Fique pronto para sair',
    title: '⏰ Corrida agendada em 30 minutos',
    body: (p) => `Faltam 30 minutos para sua corrida agendada${p ? ` — embarque em ${p}` : ''}. Prepare-se.`,
  },
  {
    key: 'm15',
    minutes: 15,
    label: '15 minutos antes',
    desc: 'Último aviso — vá buscar o passageiro',
    title: '🚗 Corrida agendada em 15 minutos',
    body: (p) => `Faltam 15 minutos${p ? ` — vá buscar o passageiro em ${p}` : ''}.`,
  },
];

export const DEFAULT_REMINDER_PREFS: ReminderPrefs = { h2: true, h1: true, m30: true, m15: true };

// ─── Preferências (por dispositivo) ────────────────────────────────────────────

export async function loadReminderPrefs(): Promise<ReminderPrefs> {
  try {
    const raw = await AsyncStorage.getItem(PREFS_KEY);
    if (raw) return { ...DEFAULT_REMINDER_PREFS, ...(JSON.parse(raw) as Partial<ReminderPrefs>) };
  } catch {
    /* fallback nos defaults */
  }
  return { ...DEFAULT_REMINDER_PREFS };
}

export async function saveReminderPrefs(prefs: ReminderPrefs): Promise<void> {
  try {
    await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch (e) {
    reportError(e, { op: 'saveReminderPrefs' });
  }
}

// ─── Agendamento ────────────────────────────────────────────────────────────────

/** Canal Android dedicado — o motorista pode ajustá-lo nas configs do sistema. */
async function ensureReminderChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: 'Lembretes de agendamento',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 200, 150, 200],
      lightColor: '#C9A84C',
    });
  } catch {
    /* canal é best-effort */
  }
}

/** Cancela todos os lembretes que ESTE módulo agendou (prefixo goxl-sched-). */
export async function clearDriverReminders(): Promise<void> {
  try {
    const all = await Notifications.getAllScheduledNotificationsAsync();
    await Promise.all(
      all
        .filter((n) => typeof n.identifier === 'string' && n.identifier.startsWith(ID_PREFIX))
        .map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier))
    );
  } catch (e) {
    reportError(e, { op: 'clearDriverReminders' });
  }
}

/**
 * Reagenda, do zero, TODOS os lembretes locais do motorista.
 *
 * Busca as corridas agendadas que ele confirmou (status 'scheduled',
 * driver_id = ele, no futuro) e, para cada offset habilitado nas preferências,
 * agenda uma notificação local no horário `scheduled_for - offset`.
 *
 * Seguro chamar com frequência: cancela os lembretes anteriores antes de recriar,
 * então corridas liberadas/canceladas somem e nada duplica.
 */
export async function syncDriverReminders(driverId: string | undefined): Promise<void> {
  if (!driverId) return;
  try {
    const granted = await ensureNotificationPermissions();
    if (!granted) return;
    await ensureReminderChannel();

    const prefs = await loadReminderPrefs();

    // Limpa os antigos SEMPRE (remove lembretes órfãos, evita duplicata).
    await clearDriverReminders();

    const enabled = REMINDER_OFFSETS.filter((o) => prefs[o.key]);
    if (enabled.length === 0) return;

    const now = Date.now();
    const { data } = await supabase
      .from('rides')
      .select('id, scheduled_for, origin_address')
      .eq('status', 'scheduled')
      .eq('driver_id', driverId)
      .gte('scheduled_for', new Date(now).toISOString());

    const rides =
      (data as { id: string; scheduled_for: string | null; origin_address: string | null }[] | null) ?? [];

    for (const ride of rides) {
      if (!ride.scheduled_for) continue;
      const startMs = new Date(ride.scheduled_for).getTime();
      const place = ride.origin_address ?? '';

      for (const off of enabled) {
        const fireMs = startMs - off.minutes * 60_000;
        // Já passou (ou está a menos de 5s)? Não adianta agendar.
        if (fireMs <= now + 5_000) continue;

        try {
          await Notifications.scheduleNotificationAsync({
            identifier: `${ID_PREFIX}${ride.id}-${off.key}`,
            content: {
              title: off.title,
              body: off.body(place),
              sound: 'default',
              data: { type: 'sched_reminder', rideId: ride.id, offset: off.minutes },
            },
            trigger: {
              type: Notifications.SchedulableTriggerInputTypes.DATE,
              date: new Date(fireMs),
              channelId: CHANNEL_ID,
            },
          });
        } catch (e) {
          reportError(e, { op: 'scheduleDriverReminder', offset: off.minutes });
        }
      }
    }
  } catch (e) {
    reportError(e, { op: 'syncDriverReminders' });
  }
}
