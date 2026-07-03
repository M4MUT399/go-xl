import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { callEdgeFunction } from '../lib/edgeFunction';

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
   * Solicita repasse REAL do saldo disponível.
   *
   * Antes isto só inseria uma linha no banco (livro-razão). Agora delega à
   * Edge Function `request-payout`, que é quem move o dinheiro: valida a conta
   * conectada, soma as corridas elegíveis e cria o transfer no Stripe. Mover
   * dinheiro nunca pode depender do cliente — o app só dispara e reconsulta.
   */
  const requestPayout = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    if (!driverId) return { ok: false, error: 'Não autenticado' };
    if (pendingBalance <= 0) return { ok: false, error: 'Sem saldo disponível' };

    try {
      await callEdgeFunction<{ ok?: boolean }>('request-payout');
      await refresh();
      return { ok: true };
    } catch (e: any) {
      // Reconsulta mesmo em falha: o servidor pode ter registrado um repasse
      // 'failed' no histórico (e devolvido as corridas ao saldo).
      await refresh();
      return { ok: false, error: e?.message ?? 'Não foi possível solicitar o repasse.' };
    }
  }, [driverId, pendingBalance, refresh]);

  return { payouts, pendingBalance, pendingRidesCount, loading, refresh, requestPayout };
}
