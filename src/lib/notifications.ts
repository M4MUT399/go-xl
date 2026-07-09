import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { reportError } from './errorReporting';

/**
 * Tipos de push que, EM FOREGROUND, já são exibidos pelo banner in-app do app
 * (NotificationBanner). Mostrar também o banner do sistema geraria aviso em
 * dobro — então suprimimos o banner/som do sistema apenas quando o app está
 * aberto. Em BACKGROUND o handler não é consultado, e o sistema entrega o push
 * normalmente (aviso único).
 */
const FOREGROUND_SILENT_TYPES = new Set([
  'schedule_confirmed', 'ride_accepted', 'driver_released',
  // O teste da aba Alertas já toca notification.wav e mostra o banner de
  // corrida agendada por conta própria — suprime o push do sistema em
  // foreground para não duplicar som/banner.
  'sched_reminder_test',
]);

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    const type = (notification.request.content.data as { type?: string } | undefined)?.type;
    if (type && FOREGROUND_SILENT_TYPES.has(type)) {
      return {
        shouldShowBanner: false,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      };
    }
    return {
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    };
  },
});

/**
 * Solicita (ou confirma) permissão de notificação.
 * Funciona em dispositivo real e em simulador (Device.isDevice removido
 * para não bloquear testes em ambiente de desenvolvimento).
 */
export async function ensureNotificationPermissions(): Promise<boolean> {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('rides', {
        name: 'Corridas',
        importance: Notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#C9A84C',
      });
    }

    const { status: existing } = await Notifications.getPermissionsAsync();
    if (existing === 'granted') return true;
    if (existing === 'denied') return false; // Usuário negou — não perguntar de novo

    const { status } = await Notifications.requestPermissionsAsync();
    return status === 'granted';
  } catch {
    return false;
  }
}

/**
 * Tenta obter o Expo Push Token e salvar no banco.
 * Pode falhar silenciosamente em dev sem EAS projectId.
 */
export async function registerForPushNotificationsAsync(): Promise<string | null> {
  const granted = await ensureNotificationPermissions();
  if (!granted) return null;

  const projectId =
    Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;

  try {
    const token = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined
    );
    return token.data;
  } catch {
    // Em dev sem EAS o token não está disponível,
    // mas notificações locais (showLocalNotification) continuam funcionando.
    return null;
  }
}

/**
 * Dispara uma notificação local imediata (banner + som).
 * Solicita permissão se ainda não concedida.
 * Funciona no Expo Go sem push token nem internet.
 */
export async function showLocalNotification(
  title: string,
  body: string,
  data?: Record<string, unknown>
) {
  try {
    const granted = await ensureNotificationPermissions();
    if (!granted) {
      console.warn('[Notifications] Permissão não concedida — notificação ignorada.');
      return;
    }

    await Notifications.scheduleNotificationAsync({
      content: { title, body, sound: 'default', data: data ?? {} },
      trigger: null,
    });
  } catch (e) {
    reportError(e, { op: 'scheduleLocalNotification' });
  }
}

export interface PushMessage {
  to: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

export async function sendPushAsync(messages: PushMessage[]): Promise<void> {
  const valid = messages.filter((m) => m.to?.startsWith('ExponentPushToken'));
  if (valid.length === 0) return;

  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(
        valid.map((m) => ({
          to: m.to,
          sound: 'default',
          channelId: 'rides',
          title: m.title,
          body: m.body,
          data: m.data ?? {},
          // Colapsa/substitui a oferta anterior da MESMA corrida na bandeja em
          // vez de empilhar (Android collapse_key / iOS apns-collapse-id).
          ...(typeof (m.data as { rideId?: string } | undefined)?.rideId === 'string'
            ? { collapseId: (m.data as { rideId?: string }).rideId }
            : {}),
        }))
      ),
    });
  } catch {
    // push é best-effort
  }
}

/**
 * Remove da bandeja/lockscreen QUALQUER notificação de oferta de corrida cujo
 * `data.rideId` bata com o informado — usada quando a oferta deixa de valer
 * (outro motorista aceitou, o passageiro cancelou, ou a oferta expirou), para
 * não deixar um card órfão na central de notificações dos demais motoristas.
 *
 * Best-effort e idempotente: dispensar um id já removido é no-op; qualquer
 * falha é engolida (nunca deve quebrar o fluxo de corrida).
 */
export async function dismissRideNotifications(rideId: string): Promise<void> {
  if (!rideId) return;
  try {
    const presented = await Notifications.getPresentedNotificationsAsync();
    await Promise.all(
      presented
        .filter((n) => {
          const data = n.request.content.data as { rideId?: string } | undefined;
          return data?.rideId === rideId;
        })
        .map((n) =>
          Notifications.dismissNotificationAsync(n.request.identifier).catch(() => {})
        )
    );
  } catch {
    // best-effort — não há notificação apresentada ou a API falhou
  }
}
