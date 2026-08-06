import { useEffect, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { notifyInApp } from '../lib/inAppNotify';
import type { Message } from '../types';

/**
 * Escuta novas mensagens da corrida via postgres_changes e dispara o banner
 * in-app quando chega mensagem do outro participante.
 *
 * `enabled` deve ser true apenas quando o usuário NÃO está na tela de chat
 * (ex.: passe isFocused da tela de corrida) para não duplicar o aviso.
 *
 * `senderLabel` define o nome do remetente no banner (ex.: 'Motorista' ou 'Passageiro').
 */
export function useChatAlert(
  rideId: string | undefined,
  userId: string | undefined,
  enabled: boolean,
  senderLabel = 'Nova mensagem',
) {
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
            // Banner in-app clicável — abre o chat ao toque
            notifyInApp(`💬 ${senderLabel}`, msg.text, rideId, senderLabel);
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [rideId, userId, enabled, senderLabel, channelId]);
}
