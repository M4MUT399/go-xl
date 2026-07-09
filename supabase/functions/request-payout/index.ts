// Supabase Edge Function — repasse REAL do saldo do motorista via Stripe Connect.
//
// Por que isso existe:
//   Antes, usePayouts.requestPayout() apenas inseria uma linha 'pending' no
//   banco — nenhum dinheiro se movia. Agora o repasse é de verdade: a
//   plataforma cobrou o passageiro (charge-ride) e aqui o servidor cria um
//   `transfers.create` do saldo da plataforma para a conta conectada (Express)
//   do motorista ("separate charges & transfers").
//
// Por que server-side:
//   Mover dinheiro NUNCA pode depender do cliente. O app só dispara; o valor,
//   as corridas elegíveis e o transfer são calculados/criados aqui com a chave
//   secreta e a service-role key.
//
// Idempotência / segurança contra repasse duplo:
//   1) cria payout 'processing' e VINCULA as corridas (payout_id) antes de
//      mover dinheiro — assim uma corrida nunca entra em dois repasses;
//   2) o transfer usa idempotencyKey = payout_<id>;
//   3) sucesso → 'completed' + stripe_transfer_id; falha → 'failed' + desvincula
//      as corridas para poderem ser repassadas numa nova tentativa.
//
// Deploy:  npx supabase functions deploy request-payout
// Segredos: STRIPE_SECRET_KEY + (SUPABASE_URL / SERVICE_ROLE_KEY / ANON_KEY automáticos)

import Stripe from 'npm:stripe@17';
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2025-01-27.acacia',
});

interface EligibleRide { id: string; driver_amount: number; stripe_payment_intent_id?: string | null }

/**
 * PaymentIntent → id da COBRANÇA (charge) que a lastreia. Necessário para
 * `source_transaction`: o transfer é sacado DAQUELA cobrança (mesmo que ainda
 * "pending") em vez de exigir saldo disponível na plataforma.
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

interface SettleResult { transferred: number; amount: number; firstTransferId?: string; reason?: string }

/**
 * Cria UM transfer por corrida, amarrado à cobrança de origem via
 * `source_transaction` quando disponível — o que remove a exigência de saldo
 * disponível na plataforma (causa do "Insufficient funds" em modo teste).
 * Corridas cujo transfer falha são DESVINCULADAS do payout (payout_id = null)
 * para nova tentativa futura. Idempotência por corrida: `payout_<id>_<rideId>`.
 */
async function settleTransfers(
  admin: SupabaseClient,
  accountId: string,
  payoutId: string,
  rides: EligibleRide[],
  meta: Record<string, string>,
): Promise<SettleResult> {
  let transferred = 0;
  let amount = 0;
  let firstTransferId: string | undefined;
  let lastReason: string | undefined;
  const failedIds: string[] = [];

  for (const ride of rides) {
    const cents = Math.round(Number(ride.driver_amount) * 100);
    if (cents <= 0) { failedIds.push(ride.id); continue; }
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
      transferred += 1;
      amount = Math.round((amount + Number(ride.driver_amount)) * 100) / 100;
      if (!firstTransferId) firstTransferId = transfer.id;
    } catch (e) {
      lastReason = String(e);
      failedIds.push(ride.id);
    }
  }

  if (failedIds.length) {
    await admin.from('rides').update({ payout_id: null }).in('id', failedIds);
  }
  return { transferred, amount, firstTransferId, reason: lastReason };
}

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')         ?? '';

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await anonClient.auth.getUser();
    if (authErr || !user) return json({ error: 'Não autorizado' }, 401);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: profile } = await admin
      .from('profiles')
      .select('stripe_account_id, type')
      .eq('id', user.id)
      .single();

    const p = profile as { stripe_account_id?: string; type?: string } | null;
    if (p?.type !== 'driver') return json({ error: 'Apenas motoristas podem solicitar repasse' }, 403);

    const accountId = p?.stripe_account_id ?? '';
    if (!accountId) {
      return json({ error: 'Configure sua conta de recebimento antes de solicitar repasse.', code: 'no_account' }, 400);
    }

    // ── A conta precisa poder receber payouts AGORA (fonte da verdade: Stripe) ──
    const account = await stripe.accounts.retrieve(accountId);
    if (!account.payouts_enabled) {
      return json({
        error: 'Sua conta de recebimento ainda não está habilitada. Conclua o cadastro para receber.',
        code: 'payouts_disabled',
      }, 400);
    }

    // ── Corridas elegíveis: pagas, com valor definido, ainda não repassadas ─────
    const { data: eligible } = await admin
      .from('rides')
      .select('id, driver_amount, stripe_payment_intent_id')
      .eq('driver_id', user.id)
      .eq('paid', true)
      .is('payout_id', null)
      .not('driver_amount', 'is', null);

    const rows = (eligible as EligibleRide[]) ?? [];
    if (rows.length === 0) return json({ error: 'Sem corridas pagas para repassar', code: 'no_balance' }, 400);

    const total = Math.round(rows.reduce((s, r) => s + Number(r.driver_amount), 0) * 100) / 100;
    if (Math.round(total * 100) <= 0) return json({ error: 'Saldo indisponível', code: 'no_balance' }, 400);

    // ── 1) Cria o payout 'processing' e reserva as corridas ────────────────────
    const { data: payoutRow, error: insErr } = await admin
      .from('payouts')
      .insert({ driver_id: user.id, amount: total, rides_count: rows.length, status: 'processing' })
      .select()
      .single();

    if (insErr || !payoutRow) return json({ error: insErr?.message ?? 'Erro ao criar repasse' }, 500);
    const payoutId = (payoutRow as { id: string }).id;

    // Vincula as corridas ANTES de mover dinheiro (evita repasse duplo numa corrida).
    await admin.from('rides').update({ payout_id: payoutId }).in('id', rows.map((r) => r.id));

    // ── 2) Transfer real: UM por corrida, amarrado à cobrança de origem ─────────
    const settled = await settleTransfers(admin, accountId, payoutId, rows, { driver_id: user.id });

    if (settled.transferred === 0) {
      await admin.from('payouts')
        .update({ status: 'failed', failure_reason: settled.reason ?? 'transfer_failed' })
        .eq('id', payoutId);
      await admin.from('rides').update({ payout_id: null }).eq('payout_id', payoutId);

      const reason = settled.reason ?? '';
      const friendly = /[Ii]nsufficient/.test(reason)
        ? 'Saldo insuficiente na conta da plataforma para este repasse. Tente novamente após novas cobranças.'
        : /No such|charge|source_transaction/i.test(reason)
          ? 'Estas corridas não têm cobrança real no Stripe para repassar (dados de teste). Rode uma corrida cobrando um cartão de teste e tente de novo.'
          : 'Não foi possível concluir o repasse agora. Tente novamente em instantes.';
      return json({ error: friendly, code: 'transfer_failed' }, 400);
    }

    // Sucesso (total ou parcial): reflete o que realmente foi repassado.
    await admin.from('payouts').update({
      status: 'completed',
      processed_at: new Date().toISOString(),
      stripe_transfer_id: settled.firstTransferId,
      amount: settled.amount,
      rides_count: settled.transferred,
    }).eq('id', payoutId);

    return json({
      ok: true,
      payout_id: payoutId,
      transfer_id: settled.firstTransferId,
      amount: settled.amount,
      rides_count: settled.transferred,
      skipped: rows.length - settled.transferred,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
