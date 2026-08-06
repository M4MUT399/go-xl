// Supabase Edge Function — repasse REAL do saldo do motorista via Stripe Connect.
//
// Por que isso existe:
//   A plataforma cobrou o passageiro (charge-ride) e aqui o servidor cria um
//   `transfers.create` do saldo da plataforma para a conta conectada (Express)
//   do motorista ("separate charges & transfers"). Mover dinheiro NUNCA depende
//   do cliente: o app só dispara; valor, corridas elegíveis e transfer são
//   calculados/criados aqui com a chave secreta e a service-role key.
//
// Endurecimento (por que motoristas destravaram):
//   1) DINHEIRO EM CENTAVOS INTEIROS (_shared/money.ts) — fim do "saldo fantasma"
//      de float que barrava o repasse.
//   2) DECISÃO com CÓDIGO CLARO (_shared/payout.ts → classifyPayoutRequest):
//      NO_ACCOUNT / KYC_PENDING / PAYOUT_IN_PROGRESS / BALANCE_BELOW_MINIMUM /
//      PROVIDER_ERROR — nunca mais erro genérico.
//   3) AUTO-DESTRAVE: payouts presos em 'processing' há muito tempo (crash/timeout
//      de uma execução anterior) são marcados 'failed' e suas corridas voltam ao
//      saldo — assim o motorista não fica travado para sempre (bug relatado).
//   4) GUARDA DE CONCORRÊNCIA: índice único parcial (migração 0046) garante UM
//      payout ativo por motorista; dois toques simultâneos → o 2º recebe
//      PAYOUT_IN_PROGRESS em vez de repassar em dobro.
//   5) RESERVA ATÔMICA das corridas via UPDATE ... RETURNING (só reserva o que
//      ainda estava livre) e REVERSÃO em falha do provedor (payout 'failed' +
//      desvincula as corridas).
//   6) LOG ESTRUTURADO em cada etapa (sem segredos/PII) para diagnóstico.
//
// Deploy:  npx supabase functions deploy request-payout
// Segredos: STRIPE_SECRET_KEY + (SUPABASE_URL / SERVICE_ROLE_KEY / ANON_KEY automáticos)

import Stripe from 'npm:stripe@17';
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import {
  classifyPayoutRequest,
  reconcileSettlement,
  friendlyProviderError,
  httpStatusForCode,
  type RideTransferResult,
} from '../_shared/payout.ts';
import { centsToDollars, dollarsToCents, sumDollarsToCents } from '../_shared/money.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2025-01-27.acacia',
});

/** Payout 'processing' mais velho que isto = execução morta → auto-destravar. */
const STUCK_PAYOUT_MS = 15 * 60 * 1000; // 15 min (> teto de wall-clock da função)

interface EligibleRide {
  id: string;
  driver_amount: number;
  stripe_payment_intent_id?: string | null;
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/** Log estruturado (JSON de uma linha). Nunca inclui segredos nem PII. */
function makeLogger(reqId: string) {
  return (stage: string, data: Record<string, unknown> = {}) => {
    console.log(JSON.stringify({ fn: 'request-payout', reqId, stage, ...data }));
  };
}

/**
 * PaymentIntent → id da COBRANÇA (charge) que a lastreia. Necessário para
 * `source_transaction`: o transfer é sacado DAQUELA cobrança (mesmo "pending")
 * em vez de exigir saldo disponível na plataforma (causa do "Insufficient funds"
 * em modo teste).
 */
async function resolveChargeId(pi?: string | null): Promise<string | null> {
  if (!pi) return null;
  try {
    const intent = await stripe.paymentIntents.retrieve(pi);
    const lc = intent.latest_charge as string | { id?: string } | null | undefined;
    return typeof lc === 'string' ? lc : (lc?.id ?? null);
  } catch {
    return null;
  }
}

/**
 * Auto-destrava payouts presos: marca 'failed' os 'processing' mais velhos que
 * STUCK_PAYOUT_MS e devolve as corridas deles ao saldo (payout_id = null). Sem
 * isto, um payout que morreu no meio (crash/timeout) trava o motorista para
 * sempre — inclusive por causa do índice único (só 1 payout ativo por motorista).
 */
async function unstickStalePayouts(admin: SupabaseClient, driverId: string, now: number, log: ReturnType<typeof makeLogger>) {
  const cutoff = new Date(now - STUCK_PAYOUT_MS).toISOString();
  const { data: stale } = await admin
    .from('payouts')
    .select('id')
    .eq('driver_id', driverId)
    .eq('status', 'processing')
    .lt('requested_at', cutoff);

  const ids = ((stale as { id: string }[]) ?? []).map((p) => p.id);
  if (ids.length === 0) return;

  await admin
    .from('payouts')
    .update({ status: 'failed', failure_reason: 'auto_unstuck_timeout' })
    .in('id', ids);
  await admin.from('rides').update({ payout_id: null }).in('payout_id', ids);
  log('self_heal', { unstuck: ids.length });
}

/** Existe um payout ativo (pending/processing) para o motorista? */
async function hasActivePayout(admin: SupabaseClient, driverId: string): Promise<boolean> {
  const { data } = await admin
    .from('payouts')
    .select('id')
    .eq('driver_id', driverId)
    .in('status', ['pending', 'processing'])
    .limit(1);
  return ((data as { id: string }[]) ?? []).length > 0;
}

/**
 * Cria UM transfer por corrida (idempotente: `payout_<id>_<rideId>`), amarrado à
 * cobrança de origem via `source_transaction` quando disponível. Devolve o
 * resultado POR corrida — a decisão de conciliação (completed/failed, quais
 * desvincular) é pura em `reconcileSettlement`.
 */
async function settleTransfers(
  accountId: string,
  payoutId: string,
  rides: EligibleRide[],
  meta: Record<string, string>,
): Promise<RideTransferResult[]> {
  const results: RideTransferResult[] = [];
  for (const ride of rides) {
    const cents = dollarsToCents(ride.driver_amount);
    if (cents <= 0) {
      results.push({ rideId: ride.id, ok: false, amountCents: 0, reason: 'non_positive_amount' });
      continue;
    }
    const chargeId = await resolveChargeId(ride.stripe_payment_intent_id);
    try {
      const params: Stripe.TransferCreateParams = {
        amount: cents,
        currency: 'usd',
        destination: accountId,
        metadata: { ...meta, payout_id: payoutId, ride_id: ride.id },
      };
      if (chargeId) params.source_transaction = chargeId;
      const transfer = await stripe.transfers.create(params, {
        idempotencyKey: `payout_${payoutId}_${ride.id}`,
      });
      results.push({ rideId: ride.id, ok: true, amountCents: cents, transferId: transfer.id });
    } catch (e) {
      results.push({ rideId: ride.id, ok: false, amountCents: 0, reason: String(e) });
    }
  }
  return results;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const reqId = crypto.randomUUID().slice(0, 8);
  const log = makeLogger(reqId);
  const now = Date.now();
  log('start');

  try {
    // ── Autenticação ────────────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization') ?? '';
    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await anonClient.auth.getUser();
    if (authErr || !user) {
      log('unauthorized');
      return json({ error: 'Não autorizado', code: 'unauthorized' }, 401);
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: profile } = await admin
      .from('profiles')
      .select('stripe_account_id, type')
      .eq('id', user.id)
      .single();

    const p = profile as { stripe_account_id?: string; type?: string } | null;
    if (p?.type !== 'driver') {
      log('not_driver');
      return json({ error: 'Apenas motoristas podem solicitar repasse', code: 'not_driver' }, 403);
    }
    const accountId = p?.stripe_account_id ?? '';
    const hasAccount = !!accountId;

    // ── payouts_enabled AGORA (fonte da verdade: Stripe), só se houver conta ──
    let payoutsEnabled = false;
    if (hasAccount) {
      try {
        const account = await stripe.accounts.retrieve(accountId);
        payoutsEnabled = !!account.payouts_enabled;
      } catch (e) {
        log('account_retrieve_failed', { reason: String(e) });
        return json({ error: friendlyProviderError(String(e)), code: 'PROVIDER_ERROR' }, 502);
      }
    }

    // ── Auto-destrava payouts presos e checa se ainda há um ativo ─────────────
    await unstickStalePayouts(admin, user.id, now, log);
    const hasInFlightPayout = await hasActivePayout(admin, user.id);

    // ── Corridas elegíveis → saldo em CENTAVOS ────────────────────────────────
    const { data: eligible } = await admin
      .from('rides')
      .select('id, driver_amount, stripe_payment_intent_id')
      .eq('driver_id', user.id)
      .eq('paid', true)
      .is('payout_id', null)
      .not('driver_amount', 'is', null);

    const eligibleRows = (eligible as EligibleRide[]) ?? [];
    const eligibleCents = sumDollarsToCents(eligibleRows.map((r) => r.driver_amount));

    // ── DECISÃO única, com código claro ───────────────────────────────────────
    const decision = classifyPayoutRequest({ hasAccount, payoutsEnabled, hasInFlightPayout, eligibleCents });
    log('decision', { hasAccount, payoutsEnabled, hasInFlightPayout, eligibleCents, code: decision.code });
    if (!decision.ok) {
      return json({ error: decision.message, code: decision.code }, httpStatusForCode(decision.code));
    }

    // ── 1) Cria o payout 'processing'. O índice único parcial (migração 0046)
    //        é a GUARDA de concorrência: um 2º pedido simultâneo falha aqui com
    //        23505 → PAYOUT_IN_PROGRESS (nunca repassa em dobro). ────────────────
    const { data: payoutRow, error: insErr } = await admin
      .from('payouts')
      .insert({
        driver_id: user.id,
        amount: centsToDollars(eligibleCents),
        rides_count: eligibleRows.length,
        status: 'processing',
      })
      .select('id')
      .single();

    if (insErr || !payoutRow) {
      if (insErr?.code === '23505') {
        log('insert_conflict');
        return json(
          { error: 'Você já tem um repasse em andamento. Aguarde concluir.', code: 'PAYOUT_IN_PROGRESS' },
          httpStatusForCode('PAYOUT_IN_PROGRESS'),
        );
      }
      log('insert_failed', { reason: insErr?.message });
      return json({ error: insErr?.message ?? 'Erro ao criar repasse', code: 'PROVIDER_ERROR' }, 500);
    }
    const payoutId = (payoutRow as { id: string }).id;

    // ── 2) RESERVA ATÔMICA: só vincula as corridas AINDA livres (payout_id IS
    //        NULL). O RETURNING (.select) devolve exatamente o que foi reservado
    //        — a fonte da verdade do valor a transferir. ───────────────────────
    const { data: claimed } = await admin
      .from('rides')
      .update({ payout_id: payoutId })
      .eq('driver_id', user.id)
      .eq('paid', true)
      .is('payout_id', null)
      .not('driver_amount', 'is', null)
      .select('id, driver_amount, stripe_payment_intent_id');

    const claimedRows = (claimed as EligibleRide[]) ?? [];
    log('rides_claimed', { count: claimedRows.length });

    if (claimedRows.length === 0) {
      // Nada para reservar (corrida a corrida já consumida) — desfaz o payout.
      await admin.from('payouts').update({ status: 'failed', failure_reason: 'no_rides_claimed' }).eq('id', payoutId);
      return json(
        { error: 'Seu saldo disponível mudou. Atualize e tente novamente.', code: 'BALANCE_BELOW_MINIMUM' },
        httpStatusForCode('BALANCE_BELOW_MINIMUM'),
      );
    }

    // ── 3) Transfer real + conciliação pura ───────────────────────────────────
    const results = await settleTransfers(accountId, payoutId, claimedRows, { driver_id: user.id });
    const settled = reconcileSettlement(results);
    log('settle_done', {
      status: settled.status,
      transferred: settled.transferredCount,
      cents: settled.transferredCents,
      failed: settled.failedRideIds.length,
    });

    // Corridas que falharam voltam ao saldo (nova tentativa futura).
    if (settled.failedRideIds.length) {
      await admin.from('rides').update({ payout_id: null }).in('id', settled.failedRideIds);
    }

    if (settled.status === 'failed') {
      // REVERSÃO total: nenhuma saiu → payout 'failed' + desvincula tudo.
      await admin
        .from('payouts')
        .update({ status: 'failed', failure_reason: settled.lastReason ?? 'transfer_failed' })
        .eq('id', payoutId);
      await admin.from('rides').update({ payout_id: null }).eq('payout_id', payoutId);
      log('finalized', { status: 'failed' });
      return json(
        { error: friendlyProviderError(settled.lastReason), code: 'PROVIDER_ERROR' },
        httpStatusForCode('PROVIDER_ERROR'),
      );
    }

    // Sucesso (total ou parcial): reflete o que REALMENTE saiu.
    await admin
      .from('payouts')
      .update({
        status: 'completed',
        processed_at: new Date().toISOString(),
        stripe_transfer_id: settled.firstTransferId,
        amount: centsToDollars(settled.transferredCents),
        rides_count: settled.transferredCount,
      })
      .eq('id', payoutId);
    log('finalized', { status: 'completed' });

    return json({
      ok: true,
      payout_id: payoutId,
      transfer_id: settled.firstTransferId,
      amount: centsToDollars(settled.transferredCents),
      rides_count: settled.transferredCount,
      skipped: claimedRows.length - settled.transferredCount,
    });
  } catch (e) {
    log('error', { reason: String(e) });
    return json({ error: 'Não foi possível concluir o repasse agora. Tente novamente.', code: 'PROVIDER_ERROR' }, 500);
  }
});
