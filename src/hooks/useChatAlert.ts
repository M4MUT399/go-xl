import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { showLocalNotification } from '../lib/notifications';
import type { Message } from '../types';

/**
 * Escuta novas mensagens da corrida e dispara uma notificação local
 * (banner + som) quando chega mensagem do outro participante.
 * `enabled` deve ser true apenas quando o usuário NÃO está na tela de chat
 * (ex.: passe useIsFocused() da tela da corrida), para não duplicar o aviso.
 */
export function useChatAlert(rideId: string | undefined, userId: string | undefined, enabled: boolean) {
  const channelId = useRef(Math.random().toString(36).slice(2)).current;

  useEffect(() => {
    if (!enabled || !rideId || !userId) return;

    const channel = supabase
      .channel(`chat-alert-${rideId}-${channelId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `ride_id=eq.${rideId}` },
        (payload) => {
          const msg = payload.new as Message;
          if (msg.sender_id !== userId) {
            showLocalNotification('💬 Nova mensagem', msg.text, { rideId, type: 'chat' });
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [rideId, userId, enabled, channelId]);
}
