import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../lib/supabase';

export interface ChatRide {
  rideId: string;
  title: string;
  unread: number;
}

const storageKey = (rideId: string) => `@goxl:chat_read:${rideId}`;

/**
 * Marca as mensagens da corrida como lidas. Passe `upToTs` com o timestamp da
 * última mensagem carregada (em ms) para evitar badge preso por diferença de
 * relógio entre o aparelho e o servidor. Guarda sempre o maior valor.
 */
export async function markChatRead(rideId: string, upToTs?: number) {
  // Se upToTs veio do servidor (timestamp da última mensagem), usa direto.
  // Quando é undefined (chat vazio), adiciona 30s de buffer para cobrir
  // diferença de relógio entre o aparelho e o servidor (clock skew).
  const ts = upToTs ?? (Date.now() + 30_000);
  const prev = await AsyncStorage.getItem(storageKey(rideId));
  const prevTs = prev ? parseInt(prev, 10) : 0;
  await AsyncStorage.setItem(storageKey(rideId), String(Math.max(ts, prevTs)));
}

/**
 * Tracks unread messages for a passenger across all their rides that have a
 * confirmed driver. Uses AsyncStorage to persist the "last read" timestamp per
 * ride so the badge survives app restarts.
 */
export function useUnreadMessages(passengerId: string | undefined) {
  const [chatRides, setChatRides] = useState<ChatRide[]>([]);

  const refresh = useCallback(async () => {
    if (!passengerId) { setChatRides([]); return; }

    // 1. Somente a corrida que está EM ANDAMENTO agora (do aceite ao encerramento).
    //    O balão de chat do passageiro vale APENAS durante a viagem ao vivo:
    //    da aceitação (`accepted`) até o embarque/desembarque (`driver_en_route`,
    //    `in_progress`). Assim que a corrida vira `completed`/`cancelled` ela sai
    //    desta lista e o balão SOME na hora (via realtime UPDATE em `rides`).
    //    • `accepted_at IS NOT NULL` = o motorista de fato ACEITOU (oferta ainda
    //      pendente ou recusada NÃO gera balão).
    //    • `'scheduled'` NÃO entra: um agendamento confirmado fica `scheduled`
    //      por horas antes de começar — o chat só deve abrir quando a viagem
    //      efetivamente inicia (o motorista tem o botão de chat próprio na Agenda).
    const { data: rides } = await supabase
      .from('rides')
      .select('id, driver_id, status')
      .eq('passenger_id', passengerId)
      .not('driver_id', 'is', null)
      .not('accepted_at', 'is', null)
      .in('status', ['accepted', 'driver_en_route', 'in_progress']);

    if (!rides?.length) { setChatRides([]); return; }

    const rideIds = (rides as { id: string; driver_id: string }[]).map((r) => r.id);

    // 2. Recent messages sent by someone other than the passenger
    const { data: msgs } = await supabase
      .from('messages')
      .select('id, ride_id, sender_id, created_at')
      .in('ride_id', rideIds)
      .neq('sender_id', passengerId)
      .order('created_at', { ascending: false })
      .limit(100);

    // 3. Driver display names (single batch query)
    const driverIds = [...new Set((rides as { driver_id: string }[]).map((r) => r.driver_id))];
    const { data: drivers } = await supabase
      .from('profiles_public')
      .select('id, full_name')
      .in('id', driverIds);

    const driverMap: Record<string, string> = {};
    ((drivers ?? []) as { id: string; full_name: string | null }[]).forEach((d) => {
      driverMap[d.id] = d.full_name ?? 'Motorista';
    });

    // 4. Count unread per ride using AsyncStorage timestamps
    const result: ChatRide[] = [];
    for (const ride of rides as { id: string; driver_id: string }[]) {
      const lastReadStr = await AsyncStorage.getItem(storageKey(ride.id));
      const lastReadAt = lastReadStr ? parseInt(lastReadStr, 10) : 0;

      const unread = ((msgs ?? []) as { ride_id: string; created_at: string }[]).filter(
        (m) => m.ride_id === ride.id && new Date(m.created_at).getTime() > lastReadAt
      ).length;

      result.push({
        rideId: ride.id,
        title: driverMap[ride.driver_id] ?? 'Motorista',
        unread,
      });
    }

    setChatRides(result);
  }, [passengerId]);

  // Initial load + Realtime: re-run on any new message in any ride chat
  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => {
    if (!passengerId) return;
    let active = true;

    // Subscribe to new messages in passenger's ride chats, AND to updates on the
    // passenger's own rides. O UPDATE em `rides` é o que faz o balão SUMIR na
    // hora quando o motorista recusa (driver_id → null / accepted_at → null),
    // cancela ou conclui a corrida — sem depender do polling de 30 s.
    const channel = supabase
      .channel(`unread-msgs-${passengerId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        () => { if (active) refresh(); }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'rides', filter: `passenger_id=eq.${passengerId}` },
        () => { if (active) refresh(); }
      )
      .subscribe();

    return () => {
      active = false;
      supabase.removeChannel(channel);
    };
  }, [passengerId, refresh]);

  // Polling fallback every 30 s
  useEffect(() => {
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  const totalUnread = chatRides.reduce((sum, r) => sum + r.unread, 0);

  return { chatRides, totalUnread, refresh };
}
