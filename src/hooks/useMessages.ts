import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import type { Message } from '../types';

/**
 * Envia um broadcast de notificação de nova mensagem para o destinatário.
 * Usa o canal `msg-notify-{recipientId}` — o mesmo que useNotifications escuta.
 */
async function broadcastMessageNotification(
  recipientId: string,
  rideId: string,
  text: string,
  senderId: string,
) {
  // Usa o mesmo canal pax-notify que já funciona para outras notificações
  const ch = supabase.channel(`pax-notify-${recipientId}`);
  await new Promise<void>((resolve) => {
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        ch.send({
          type: 'broadcast',
          event: 'new_message',
          payload: { rideId, text, senderId },
        })
          .then(() => { supabase.removeChannel(ch); resolve(); })
          .catch(() => { supabase.removeChannel(ch); resolve(); });
      }
    });
    // timeout de segurança
    setTimeout(() => { supabase.removeChannel(ch); resolve(); }, 5000);
  });
}

export function useMessages(rideId: string, senderId: string | undefined) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  /** ID do outro participante da corrida (destinatário das notificações) */
  const recipientIdRef = useRef<string | null>(null);

  // Descobre o destinatário buscando a corrida uma vez
  useEffect(() => {
    if (!senderId) return;
    supabase
      .from('rides')
      .select('passenger_id, driver_id')
      .eq('id', rideId)
      .single()
      .then(({ data }) => {
        if (!data) return;
        const ride = data as { passenger_id: string; driver_id: string | null };
        recipientIdRef.current =
          ride.passenger_id === senderId ? ride.driver_id : ride.passenger_id;
      });
  }, [rideId, senderId]);

  // Carrega mensagens + escuta novas via postgres_changes
  useEffect(() => {
    let active = true;

    supabase
      .from('messages')
      .select('*')
      .eq('ride_id', rideId)
      .order('created_at', { ascending: true })
      .then(({ data }) => {
        if (active) {
          setMessages((data as Message[]) ?? []);
          setLoading(false);
        }
      });

    const channel = supabase
      .channel(`chat-${rideId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `ride_id=eq.${rideId}` },
        (payload) => {
          const msg = payload.new as Message;
          if (active) {
            setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
          }
        }
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [rideId]);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !senderId) return;

      // 1. Persiste no banco
      const { data } = await supabase
        .from('messages')
        .insert({ ride_id: rideId, sender_id: senderId, text: trimmed })
        .select()
        .single();

      // 2. Adiciona otimisticamente na própria tela (não depende de realtime)
      if (data) {
        setMessages((prev) =>
          prev.some((m) => m.id === (data as Message).id) ? prev : [...prev, data as Message]
        );
      }

      // 3. Notifica o destinatário via Broadcast (independe de RLS/realtime)
      const recipientId = recipientIdRef.current;
      if (recipientId) {
        broadcastMessageNotification(recipientId, rideId, trimmed, senderId);
      }
    },
    [rideId, senderId]
  );

  return { messages, loading, sendMessage };
}
