// passengerReminders — lembretes locais escalonados de corridas AGENDADAS (passageiro).
//
// Espelha driverReminders.ts, mas do lado do passageiro: avisa 2h, 1h, 30min e
// 15min ANTES de uma corrida que ELE agendou, para que ele esteja pronto no
// ponto de embarque na hora marcada (com ou sem motorista já atribuído).
//
// Por que notificação LOCAL agendada (e não polling em primeiro plano):
//   `Notifications.scheduleNotificationAsync` com trigger de DATA entrega a
//   notificação no horário marcado pelo próprio SISTEMA — dispara mesmo com o
//   app fechado ou o celular bloqueado. O alerta sonoro in-app existente
//   (useScheduledReminderAlert) só toca com o app aberto; estes complementam.
//
// Idempotência: cada (corrida × offset) tem um identifier determinístico
// (`goxl-pax-sched-<rideId>-<key>`). Prefixo PRÓPRIO (distinto do motorista,
// `goxl-sched-`) para que um papel nunca cancele os lembretes do outro. Antes
// de reagendar, cancelamos todos os NOSSOS para remover lembretes de corridas
// canceladas/iniciadas e evitar duplicatas.

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { supabase } from './supabase';
import { ensureNotificationPermissions } from './notifications';
import { reportError } from './errorReporting';
import { currentAppLang, reminderChannelName, reminderText, type ReminderOffsetKey } from './reminderText';
import type { Lang } from '../i18n/translations';

const ID_PREFIX = 'goxl-pax-sched-';
const CHANNEL_ID = 'reminders';

type ReminderOffset = {
  key: ReminderOffsetKey;
  minutes: number;
};

/**
 * Avisos do passageiro — todos disparam (sem tela de preferências, ao contrário
 * do motorista). Mesma cadência do motorista (2h/1h/30min/15min) para paridade,
 * com texto voltado a quem vai embarcar. Os textos ficam em
 * src/i18n/translations.ts (`reminderNotif.pax.*`), no idioma atual do app.
 */
const REMINDER_OFFSETS: ReminderOffset[] = [
  { key: 'h2', minutes: 120 },
  { key: 'h1', minutes: 60 },
  { key: 'm30', minutes: 30 },
  { key: 'm15', minutes: 15 },
];

/** Canal Android dedicado — o passageiro pode ajustá-lo nas configs do sistema. */
async function ensureReminderChannel(lang: Lang): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: reminderChannelName(lang),
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 200, 150, 200],
      lightColor: '#C9A84C',
    });
  } catch {
    /* canal é best-effort */
  }
}

/** Cancela todos os lembretes que ESTE módulo agendou (prefixo goxl-pax-sched-). */
export async function clearPassengerReminders(): Promise<void> {
  try {
    const all = await Notifications.getAllScheduledNotificationsAsync();
    await Promise.all(
      all
        .filter((n) => typeof n.identifier === 'string' && n.identifier.startsWith(ID_PREFIX))
        .map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier))
    );
  } catch (e) {
    reportError(e, { op: 'clearPassengerReminders' });
  }
}

/**
 * Reagenda, do zero, TODOS os lembretes locais do passageiro.
 *
 * Busca as corridas agendadas dele (status 'scheduled', passenger_id = ele, no
 * futuro) e, para cada offset, agenda uma notificação local no horário
 * `scheduled_for - offset`.
 *
 * Seguro chamar com frequência: cancela os lembretes anteriores antes de recriar,
 * então corridas canceladas/iniciadas somem e nada duplica.
 */
export async function syncPassengerReminders(passengerId: string | undefined): Promise<void> {
  if (!passengerId) return;
  try {
    const granted = await ensureNotificationPermissions();
    if (!granted) return;
    const lang = await currentAppLang();
    await ensureReminderChannel(lang);

    // Limpa os antigos SEMPRE (remove lembretes órfãos, evita duplicata).
    await clearPassengerReminders();

    const now = Date.now();
    const { data } = await supabase
      .from('rides')
      .select('id, scheduled_for, origin_address')
      .eq('status', 'scheduled')
      .eq('passenger_id', passengerId)
      .gte('scheduled_for', new Date(now).toISOString());

    const rides =
      (data as { id: string; scheduled_for: string | null; origin_address: string | null }[] | null) ?? [];

    for (const ride of rides) {
      if (!ride.scheduled_for) continue;
      const startMs = new Date(ride.scheduled_for).getTime();
      const place = ride.origin_address ?? '';

      for (const off of REMINDER_OFFSETS) {
        const fireMs = startMs - off.minutes * 60_000;
        // Já passou (ou está a menos de 5s)? Não adianta agendar.
        if (fireMs <= now + 5_000) continue;

        try {
          const text = reminderText(lang, 'pax', off.key, place);
          await Notifications.scheduleNotificationAsync({
            identifier: `${ID_PREFIX}${ride.id}-${off.key}`,
            content: {
              title: text.title,
              body: text.body,
              sound: 'default',
              data: { type: 'sched_reminder', rideId: ride.id, offset: off.minutes, role: 'passenger' },
            },
            trigger: {
              type: Notifications.SchedulableTriggerInputTypes.DATE,
              date: new Date(fireMs),
              channelId: CHANNEL_ID,
            },
          });
        } catch (e) {
          reportError(e, { op: 'schedulePassengerReminder', offset: off.minutes });
        }
      }
    }
  } catch (e) {
    reportError(e, { op: 'syncPassengerReminders' });
  }
}
