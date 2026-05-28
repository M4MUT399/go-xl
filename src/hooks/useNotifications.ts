import { useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import { supabase } from '../lib/supabase';
import { registerForPushNotificationsAsync } from '../lib/notifications';

export function useNotifications(userId: string | undefined) {
  const responseListener = useRef<Notifications.EventSubscription | undefined>(undefined);

  useEffect(() => {
    if (!userId) return;

    let active = true;

    registerForPushNotificationsAsync().then(async (token) => {
      if (!active || !token) return;
      await supabase.from('profiles').update({ push_token: token }).eq('id', userId);
    });

    responseListener.current = Notifications.addNotificationResponseReceivedListener(() => {
      // ponto de extensão: navegar para a corrida ao tocar na notificação
    });

    return () => {
      active = false;
      responseListener.current?.remove();
    };
  }, [userId]);
}
