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
import { createClient } from 'jsr:@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2025-01-27.acacia',
});

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
      .select('id, driver_amount')
      .eq('driver_id', user.id)
      .eq('paid', true)
      .is('payout_id', null)
      .not('driver_amount', 'is', null);

    const rows = (eligible as { id: string; driver_amount: number }[]) ?? [];
    if (rows.length === 0) return json({ error: 'Sem corridas pagas para repassar', code: 'no_balance' }, 400);

    const total = Math.round(rows.reduce((s, r) => s + Number(r.driver_amount), 0) * 100) / 100;
    const amountCents = Math.round(total * 100);
    if (amountCents <= 0) return json({ error: 'Saldo indisponível', code: 'no_balance' }, 400);

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

    // ── 2) Transfer real para a conta conectada do motorista ───────────────────
    try {
      const transfer = await stripe.transfers.create({
        amount: amountCents,
        currency: 'usd',
        destination: accountId,
        metadata: { payout_id: payoutId, driver_id: user.id, rides_count: String(rows.length) },
      }, { idempotencyKey: `payout_${payoutId}` });

      await admin.from('payouts').update({
        status: 'completed',
        processed_at: new Date().toISOString(),
        stripe_transfer_id: transfer.id,
      }).eq('id', payoutId);

      return json({ ok: true, payout_id: payoutId, transfer_id: transfer.id, amount: total, rides_count: rows.length });
    } catch (transferErr) {
      // Falha ao mover dinheiro — desfaz a reserva para nova tentativa futura.
      const reason = String(transferErr);
      await admin.from('payouts').update({ status: 'failed', failure_reason: reason }).eq('id', payoutId);
      await admin.from('rides').update({ payout_id: null }).eq('payout_id', payoutId);

      // Saldo insuficiente é o erro mais comum em modo teste (sem cargas reais).
      const friendly = /[Ii]nsufficient/.test(reason)
        ? 'Saldo insuficiente na conta da plataforma para este repasse. Tente novamente após novas cobranças.'
        : 'Não foi possível concluir o repasse agora. Tente novamente em instantes.';
      return json({ error: friendly, code: 'transfer_failed' }, 400);
    }
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
