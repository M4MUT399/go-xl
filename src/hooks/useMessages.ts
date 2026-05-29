import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import type { Message } from '../types';

export function useMessages(rideId: string, senderId: string | undefined) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);

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
          setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
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
      await supabase.from('messages').insert({ ride_id: rideId, sender_id: senderId, text: trimmed });
    },
    [rideId, senderId]
  );

  return { messages, loading, sendMessage };
}
