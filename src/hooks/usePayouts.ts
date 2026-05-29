import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';

export interface Payout {
  id: string;
  driver_id: string;
  amount: number;
  rides_count: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  requested_at: string;
  processed_at?: string;
}

export function usePayouts(driverId: string | undefined) {
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [pendingBalance, setPendingBalance] = useState(0);
  const [pendingRidesCount, setPendingRidesCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!driverId) return;
    setLoading(true);

    const [{ data: payoutRows }, { data: unpaidRides }] = await Promise.all([
      supabase
        .from('payouts')
        .select('*')
        .eq('driver_id', driverId)
        .order('requested_at', { ascending: false }),
      supabase
        .from('rides')
        .select('driver_amount')
        .eq('driver_id', driverId)
        .eq('paid', true)
        .is('payout_id', null)
        .not('driver_amount', 'is', null),
    ]);

    setPayouts((payoutRows as Payout[]) ?? []);

    const rows = (unpaidRides as { driver_amount: number }[]) ?? [];
    setPendingRidesCount(rows.length);
    setPendingBalance(
      Math.round(rows.reduce((s, r) => s + Number(r.driver_amount), 0) * 100) / 100
    );

    setLoading(false);
  }, [driverId]);

  useEffect(() => { refresh(); }, [refresh]);

  /**
   * Solicita repasse do saldo disponível.
   * Cria o payout e vincula todas as corridas elegíveis a ele.
   */
  const requestPayout = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (!driverId) return { ok: false, error: 'Não autenticado' };
    if (pendingBalance <= 0) return { ok: false, error: 'Sem saldo disponível' };

    // Busca IDs das corridas elegíveis
    const { data: eligible } = await supabase
      .from('rides')
      .select('id, driver_amount')
      .eq('driver_id', driverId)
      .eq('paid', true)
      .is('payout_id', null)
      .not('driver_amount', 'is', null);

    if (!eligible || eligible.length === 0) return { ok: false, error: 'Sem corridas pagas para repassar' };

    const rows = eligible as { id: string; driver_amount: number }[];
    const total = Math.round(rows.reduce((s, r) => s + Number(r.driver_amount), 0) * 100) / 100;

    // Cria o payout
    const { data: payout, error } = await supabase
      .from('payouts')
      .insert({ driver_id: driverId, amount: total, rides_count: rows.length })
      .select()
      .single();

    if (error || !payout) return { ok: false, error: error?.message ?? 'Erro ao criar repasse' };

    // Vincula as corridas ao payout
    await supabase
      .from('rides')
      .update({ payout_id: (payout as Payout).id })
      .in('id', rows.map((r) => r.id));

    await refresh();
    return { ok: true };
  }, [driverId, pendingBalance, refresh]);

  return { payouts, pendingBalance, pendingRidesCount, loading, refresh, requestPayout };
}
