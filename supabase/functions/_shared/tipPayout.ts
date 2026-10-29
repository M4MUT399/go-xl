// Repasse de GORJETA ao motorista — compartilhado por request-payout (sob
// demanda) e run-weekly-payouts (cron).
//
// Por que a gorjeta não entra no transfer da tarifa:
// o transfer é sacado da cobrança de origem (`source_transaction`) e o Stripe
// rejeita transfer maior que essa cobrança. Tarifa e gorjeta são PaymentIntents
// separados (`charge_<id>` e `tip_<id>`), então a gorjeta precisa do transfer
// dela, sacado da cobrança dela. Ver migração 0064.
//
// E a gorjeta vai INTEIRA para o motorista: não incide a comissão da plataforma.
// Gorjeta é do motorista, não receita do app.

import Stripe from 'npm:stripe@17';
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { dollarsToCents } from './money.ts';

export interface PendingTip {
  id: string;
  tip_amount: number;
  tip_payment_intent_id?: string | null;
}

export interface TipSettlement {
  /** Centavos de gorjeta efetivamente transferidos. */
  transferredCents: number;
  /** Quantas gorjetas saíram. */
  transferredCount: number;
  /** Corridas cuja gorjeta falhou — devolvidas ao saldo (tip_payout_id = null). */
  failedRideIds: string[];
}

/**
 * RESERVA ATÔMICA das gorjetas pendentes deste motorista.
 *
 * Espelha a reserva das corridas: só marca as que ainda estão livres
 * (tip_payout_id IS NULL) e o RETURNING devolve exatamente o que foi reservado.
 * Exige `paid = true` pelo mesmo motivo da tarifa — corrida cuja cobrança não
 * entrou não gera repasse de nada.
 */
export async function claimPendingTips(
  admin: SupabaseClient,
  driverId: string,
  payoutId: string,
): Promise<PendingTip[]> {
  const { data } = await admin
    .from('rides')
    .update({ tip_payout_id: payoutId })
    .eq('driver_id', driverId)
    .eq('paid', true)
    .is('tip_payout_id', null)
    .gt('tip_amount', 0)
    .select('id, tip_amount, tip_payment_intent_id');
  return (data as PendingTip[]) ?? [];
}

/**
 * UM transfer por gorjeta, idempotente por `payout_<id>_<rideId>_tip` — chave
 * distinta da tarifa (`payout_<id>_<rideId>`), senão o Stripe devolveria o
 * transfer da tarifa em vez de criar o da gorjeta.
 */
export async function settleTips(
  stripe: Stripe,
  accountId: string,
  payoutId: string,
  tips: PendingTip[],
  meta: Record<string, string>,
  resolveChargeId: (pi?: string | null) => Promise<string | null>,
): Promise<TipSettlement> {
  let transferredCents = 0;
  let transferredCount = 0;
  const failedRideIds: string[] = [];

  for (const tip of tips) {
    const cents = dollarsToCents(tip.tip_amount);
    if (cents <= 0) {
      failedRideIds.push(tip.id);
      continue;
    }
    try {
      const params: Stripe.TransferCreateParams = {
        amount: cents, // 100% — gorjeta não sofre comissão
        currency: 'usd',
        destination: accountId,
        metadata: { ...meta, payout_id: payoutId, ride_id: tip.id, kind: 'tip' },
      };
      const chargeId = await resolveChargeId(tip.tip_payment_intent_id);
      if (chargeId) params.source_transaction = chargeId;

      await stripe.transfers.create(params, {
        idempotencyKey: `payout_${payoutId}_${tip.id}_tip`,
      });
      transferredCents += cents;
      transferredCount += 1;
    } catch {
      // Gorjeta que falhou volta ao saldo e tenta de novo no próximo repasse.
      // Nunca derruba o repasse da tarifa: são dinheiros independentes.
      failedRideIds.push(tip.id);
    }
  }

  return { transferredCents, transferredCount, failedRideIds };
}
