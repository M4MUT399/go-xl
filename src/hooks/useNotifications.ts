import { useEffect, useRef, useState, useCallback } from 'react';
import * as Notifications from 'expo-notifications';
import { supabase } from '../lib/supabase';
import {
  ensureNotificationPermissions,
  registerForPushNotificationsAsync,
} from '../lib/notifications';
import { activeChatRideId } from '../lib/activeChatRide';

export interface InAppMessage {
  title: string;
  body: string;
  /** Se presente, o banner navega para o ChatScreen ao ser tocado */
  rideId?: string;
  chatTitle?: string;
}

const REMINDER_THRESHOLDS = [15, 10, 5] as const; // minutos antes da corrida

export function useNotifications(
  userId: string | undefined,
  userType?: 'passenger' | 'driver'
) {
  const responseListener = useRef<Notifications.EventSubscription | undefined>(undefined);
  /** IDs de corridas já notificadas (aceite do agendamento) */
  const notifiedRides = useRef<Set<string>>(new Set());
  /** Chaves de lembretes já disparados: `{rideId}-{threshold}` */
  const firedReminders = useRef<Set<string>>(new Set());
  /** Dedup de mensagens de chat: `{rideId}:{texto}` → timestamp */
  const recentMsgKeys = useRef<Map<string, number>>(new Map());
  /** Mensagem para o banner in-app */
  const [inAppMessage, setInAppMessage] = useState<InAppMessage | null>(null);

  // Exibe SOMENTE o banner in-app (sem notificação do sistema). Em foreground o
  // banner já é suficiente; o aviso do sistema/background é entregue por push
  // remoto no lado do motorista. Disparar também showLocalNotification aqui
  // causava banner duplicado (um dos "4 popups" reportados no aceite).
  const fireNotification = useCallback((
    title: string,
    body: string,
    rideId: string,
    chatTitle?: string,
  ) => {
    setInAppMessage({ title, body, rideId, chatTitle });
  }, []);

  /**
   * Exibe apenas o banner in-app (sem notificação do sistema, evitando banner
   * duplicado no iOS em foreground). Faz deduplicação por `{rideId}:{texto}`
   * numa janela de 12 s, pois a mesma mensagem pode chegar por até 3 fontes
   * (postgres_changes, broadcast e polling).
   */
  const showBanner = useCallback((
    title: string,
    body: string,
    rideId: string,
    chatTitle?: string,
  ) => {
    const key = `${rideId}:${body.slice(0, 80)}`;
    const now = Date.now();
    // Purga entradas antigas (> 30 s)
    for (const [k, t] of recentMsgKeys.current) {
      if (now - t > 30_000) recentMsgKeys.current.delete(k);
    }
    const last = recentMsgKeys.current.get(key);
    if (last !== undefined && now - last < 12_000) return; // duplicada
    recentMsgKeys.current.set(key, now);
    setInAppMessage({ title, body, rideId, chatTitle });
  }, []);

  // ─── Permissão + push token ────────────────────────────────────────────────
  useEffect(() => {
    if (!userId) return;
    let active = true;

    ensureNotificationPermissions();

    registerForPushNotificationsAsync().then(async (token) => {
      if (!active || !token) return;
      await supabase.from('profiles').update({ push_token: token }).eq('id', userId);
    });

    responseListener.current = Notifications.addNotificationResponseReceivedListener(() => {});

    return () => {
      active = false;
      responseListener.current?.remove();
    };
  }, [userId]);

  // ─── Broadcast (mensagem direta do motorista ao confirmar) ────────────────
  useEffect(() => {
    if (!userId) return;

    const senderLabel = userType === 'driver' ? 'Passageiro' : 'Motorista';

    const channel = supabase
      .channel(`pax-notify-${userId}`)
      .on('broadcast', { event: 'schedule_confirmed' }, (payload) => {
        const rideId: string | undefined = payload?.payload?.rideId;
        if (!rideId || notifiedRides.current.has(rideId)) return;
        notifiedRides.current.add(rideId);
        fireNotification(
          '🗓️ Motorista confirmado!',
          'Um motorista aceitou seu agendamento. Confira os detalhes na tela de corridas agendadas.',
          rideId
        );
      })
      .on('broadcast', { event: 'driver_released' }, (payload) => {
        const rideId: string | undefined = payload?.payload?.rideId;
        if (!rideId) return;
        notifiedRides.current.delete(rideId);
        fireNotification(
          '⚠️ Motorista cancelou',
          'O motorista liberou seu agendamento. Aguarde nova confirmação ou solicite agora.',
          rideId
        );
      })
      .on('broadcast', { event: 'new_message' }, (payload) => {
        const { rideId, text } = (payload?.payload ?? {}) as { rideId?: string; text?: string };
        if (!rideId || !text) return;
        // Chat já aberto nessa corrida → não precisa de banner
        if (activeChatRideId.current === rideId) return;
        showBanner(`💬 ${senderLabel}`, text, rideId, senderLabel);
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [userId, fireNotification, showBanner]);

  // ─── Polling de mensagens de chat (mecanismo mais confiável no Expo Go) ──────
  // Realtime/broadcast falham com frequência no Expo Go, então sondamos as
  // mensagens recentes das corridas ativas e disparamos o banner para as novas.
  useEffect(() => {
    if (!userId || !userType) return;
    let active = true;
    // Só consideramos mensagens criadas após o mount (evita banner ao reabrir).
    let since = new Date().toISOString();
    const column = userType === 'driver' ? 'driver_id' : 'passenger_id';
    const senderLabel = userType === 'driver' ? 'Passageiro' : 'Motorista';

    async function checkMessages() {
      if (!active) return;

      // Corridas ativas onde o usuário participa
      const { data: rideRows, error: rideErr } = await supabase
        .from('rides')
        .select('id')
        .eq(column, userId)
        .in('status', ['accepted', 'driver_en_route', 'in_progress']);

      if (rideErr || !active) return;
      const rideIds = (rideRows ?? []).map((r: { id: string }) => r.id);
      if (rideIds.length === 0) return;

      const { data: msgs, error: msgErr } = await supabase
        .from('messages')
        .select('id, ride_id, text, sender_id, created_at')
        .in('ride_id', rideIds)
        .neq('sender_id', userId)
        .gt('created_at', since)
        .order('created_at', { ascending: true });

      if (msgErr || !active || !msgs || msgs.length === 0) return;

      // Avança o cursor para a mensagem mais recente vista
      since = msgs[msgs.length - 1].created_at;

      for (const m of msgs as { ride_id: string; text: string }[]) {
        // Se o chat dessa corrida está aberto, não exibe banner
        if (activeChatRideId.current === m.ride_id) continue;
        showBanner(`💬 ${senderLabel}`, m.text, m.ride_id, senderLabel);
      }
    }

    // Atraso inicial: evita que a primeira sondagem compita por rede/CPU com
    // as queries da tela recém-montada logo após login/troca de sessão. As
    // execuções seguintes continuam no intervalo normal de 4s.
    const kickoff = setTimeout(checkMessages, 1_500);
    const interval = setInterval(checkMessages, 4_000);

    return () => { active = false; clearTimeout(kickoff); clearInterval(interval); };
  }, [userId, userType, showBanner]);

  // ─── Polling a cada 10 s — detecção de motorista confirmado ou liberado ──────
  useEffect(() => {
    if (!userId) return;
    let active = true;
    let initialized = false;
    /** rideId → driver_id (ou null) da última verificação */
    const prevDriverMap = new Map<string, string | null>();

    async function checkConfirmedRides() {
      if (!active) return;

      const { data, error } = await supabase
        .from('rides')
        .select('id, driver_id')
        .eq('passenger_id', userId)
        .eq('status', 'scheduled');

      if (error || !active) return;

      const rides = (data ?? []) as { id: string; driver_id: string | null }[];

      if (!initialized) {
        rides.forEach((r) => {
          prevDriverMap.set(r.id, r.driver_id);
          if (r.driver_id) notifiedRides.current.add(r.id);
        });
        initialized = true;
        return;
      }

      for (const ride of rides) {
        const prev = prevDriverMap.get(ride.id);

        // Motorista acabou de confirmar (null → id)
        if (!prev && ride.driver_id && !notifiedRides.current.has(ride.id)) {
          notifiedRides.current.add(ride.id);
          fireNotification(
            '🗓️ Motorista confirmado!',
            'Um motorista aceitou seu agendamento. Confira os detalhes na tela de corridas agendadas.',
            ride.id
          );
        }

        // Motorista liberou (id → null)
        if (prev && !ride.driver_id) {
          notifiedRides.current.delete(ride.id);
          fireNotification(
            '⚠️ Motorista cancelou',
            'O motorista liberou seu agendamento. Aguarde nova confirmação ou solicite agora.',
            ride.id
          );
        }

        prevDriverMap.set(ride.id, ride.driver_id);
      }

      // Remove corridas que já não existem do mapa
      const currentIds = new Set(rides.map((r) => r.id));
      for (const id of prevDriverMap.keys()) {
        if (!currentIds.has(id)) prevDriverMap.delete(id);
      }
    }

    const kickoff = setTimeout(checkConfirmedRides, 1_500);
    const interval = setInterval(checkConfirmedRides, 10_000);

    return () => { active = false; clearTimeout(kickoff); clearInterval(interval); };
  }, [userId, fireNotification]);

  // ─── Lembretes 15 / 10 / 5 min antes da corrida agendada ─────────────────
  // Funciona para passageiro (passenger_id) e motorista (driver_id).
  useEffect(() => {
    if (!userId || !userType) return;
    let active = true;
    let initialized = false;

    const column = userType === 'passenger' ? 'passenger_id' : 'driver_id';

    async function checkReminders() {
      if (!active) return;

      const now = Date.now();

      const { data, error } = await supabase
        .from('rides')
        .select('id, scheduled_for, origin_address, destination_address')
        .eq(column, userId)
        .eq('status', 'scheduled')
        // Apenas corridas que ainda não começaram (ou começaram há no máx. 10 min)
        .gte('scheduled_for', new Date(now - 10 * 60 * 1000).toISOString())
        .lte('scheduled_for', new Date(now + 24 * 60 * 60 * 1000).toISOString());

      if (error || !active) return;

      const rides = (data ?? []) as {
        id: string;
        scheduled_for: string;
        origin_address: string;
        destination_address: string;
      }[];

      for (const ride of rides) {
        const minutesUntil = (new Date(ride.scheduled_for).getTime() - now) / 60000;

        for (const threshold of REMINDER_THRESHOLDS) {
          const key = `${ride.id}-${threshold}`;

          if (minutesUntil <= threshold) {
            if (!initialized) {
              // Primeira execução: marca como visto sem notificar
              firedReminders.current.add(key);
            } else if (minutesUntil > -2 && !firedReminders.current.has(key)) {
              // Limiar cruzado enquanto o app estava aberto → dispara lembrete
              firedReminders.current.add(key);

              const title = `⏰ Corrida em ${threshold} minutos!`;
              const body =
                userType === 'passenger'
                  ? threshold === 5
                    ? 'Seu motorista está quase chegando. Fique pronto na entrada!'
                    : `Sua corrida agendada começa em ${threshold} minutos. Prepare-se!`
                  : threshold === 5
                    ? 'Faltam 5 minutos! Siga para o ponto de embarque agora.'
                    : `Você tem uma corrida em ${threshold} minutos. Dirija-se ao local de embarque.`;

              fireNotification(title, body, ride.id);
            }
          }
        }
      }

      initialized = true;
    }

    const kickoff = setTimeout(checkReminders, 1_500);
    const interval = setInterval(checkReminders, 60_000); // verifica a cada 1 minuto

    return () => { active = false; clearTimeout(kickoff); clearInterval(interval); };
  }, [userId, userType, fireNotification]);


  return {
    inAppMessage,
    clearInAppMessage: () => setInAppMessage(null),
    showBanner,
  };
}
