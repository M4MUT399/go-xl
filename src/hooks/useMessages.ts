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
  /**
   * true quando a LEITURA do histórico falhou. Sem isto, um erro de rede/RLS
   * caía no mesmo estado visual de uma conversa vazia ("Nenhuma mensagem
   * ainda"): o usuário concluía que o outro lado não tinha escrito nada, quando
   * na verdade podia haver mensagens que ele nunca veria.
   */
  const [loadFailed, setLoadFailed] = useState(false);
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
      .then(({ data, error }) => {
        if (!active) return;
        // O erro era descartado e caíamos em `?? []` — a tela mostrava o estado
        // vazio de "conversa nova" para uma falha de leitura. Agora distinguimos
        // as duas coisas (ver `loadFailed` acima).
        setLoadFailed(!!error);
        if (!error) setMessages((data as Message[]) ?? []);
        setLoading(false);
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

  /**
   * Devolve se a mensagem foi REALMENTE gravada. Antes era `Promise<void>` e o
   * erro do INSERT era descartado: com RLS negando ou a rede caída, a mensagem
   * simplesmente não aparecia na conversa e o campo de texto era limpo mesmo
   * assim (ver ChatScreen.handleSend) — o passageiro achava que tinha avisado o
   * motorista "estou na porta 3" e ninguém nunca recebeu nada. O preço é que o
   * chamador precisa tratar o `false`; é exatamente o ponto.
   */
  const sendMessage = useCallback(
    async (text: string): Promise<boolean> => {
      const trimmed = text.trim();
      if (!trimmed || !senderId) return false;

      // 1. Persiste no banco
      const { data, error } = await supabase
        .from('messages')
        .insert({ ride_id: rideId, sender_id: senderId, text: trimmed })
        .select()
        .single();

      // Sem linha gravada não há mensagem — não notificamos o destinatário (o
      // broadcast faria o outro lado ver um texto que não existe no histórico)
      // e devolvemos a falha para a tela poder devolver o texto ao campo.
      if (error || !data) return false;

      // 2. Adiciona otimisticamente na própria tela (não depende de realtime)
      setMessages((prev) =>
        prev.some((m) => m.id === (data as Message).id) ? prev : [...prev, data as Message]
      );

      // 3. Notifica o destinatário via Broadcast (independe de RLS/realtime)
      const recipientId = recipientIdRef.current;
      if (recipientId) {
        broadcastMessageNotification(recipientId, rideId, trimmed, senderId);
      }
      return true;
    },
    [rideId, senderId]
  );

  return { messages, loading, loadFailed, sendMessage };
}
