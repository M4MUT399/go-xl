// Supabase Edge Function — repasse SEMANAL automático (em lote) via Stripe Connect.
//
// Por que isso existe:
//   Além do botão "Solicitar repasse" (request-payout), a plataforma faz o
//   repasse de forma automática uma vez por semana — toda segunda-feira após o
//   meio-dia (horário de Orlando/ET). Esta função varre TODOS os motoristas com
//   conta Express habilitada e saldo pendente e cria um transfer por motorista.
//
// Quem chama:
//   O agendador do Postgres (pg_cron + pg_net) — NÃO um cliente. Por isso a
//   função é publicada com `--no-verify-jwt` e valida o próprio chamador
//   exigindo o header Authorization: Bearer <SERVICE_ROLE_KEY> (só a nossa
//   infraestrutura conhece essa chave). O agendador lê a chave do Vault.
//
// Idempotência (idêntica ao request-payout, por motorista):
//   1) cria payout 'processing' e VINCULA as corridas (payout_id) antes de
//      mover dinheiro — uma corrida nunca entra em dois repasses;
//   2) transfer com idempotencyKey = payout_<id>;
//   3) sucesso → 'completed' + stripe_transfer_id; falha → 'failed' + desvincula
//      as corridas para nova tentativa (no próximo botão ou na próxima segunda).
//
// A varredura é resiliente: a falha de um motorista NÃO interrompe os demais.
//
// Deploy:  npx supabase functions deploy run-weekly-payouts --no-verify-jwt
// Segredos: STRIPE_SECRET_KEY + (SUPABASE_URL / SERVICE_ROLE_KEY automáticos)

import Stripe from 'npm:stripe@17';
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2025-01-27.acacia',
});

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

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

interface EligibleRide { id: string; driver_id: string; driver_amount: number }
interface DriverResult {
  driver_id: string;
  status: 'paid' | 'skipped' | 'failed';
  amount?: number;
  rides_count?: number;
  transfer_id?: string;
  reason?: string;
}

/**
 * Repassa o saldo pendente de UM motorista. Mesma sequência idempotente do
 * request-payout: reserva as corridas, transfere, e concilia o status.
 * A fonte da verdade de "pode receber agora" é o Stripe (payouts_enabled).
 */
async function payoutDriver(
  admin: SupabaseClient,
  driverId: string,
  accountId: string,
  rides: EligibleRide[],
): Promise<DriverResult> {
  // Confirma no Stripe que a conta pode receber payouts AGORA (flag do banco
  // pode estar desatualizada — só é sincronizada quando o motorista abre o app).
  const account = await stripe.accounts.retrieve(accountId);
  if (!account.payouts_enabled) {
    return { driver_id: driverId, status: 'skipped', reason: 'payouts_disabled' };
  }

  const total = Math.round(rides.reduce((s, r) => s + Number(r.driver_amount), 0) * 100) / 100;
  const amountCents = Math.round(total * 100);
  if (amountCents <= 0) {
    return { driver_id: driverId, status: 'skipped', reason: 'no_balance' };
  }

  // 1) Cria o payout 'processing' e reserva as corridas ANTES de mover dinheiro.
  const { data: payoutRow, error: insErr } = await admin
    .from('payouts')
    .insert({ driver_id: driverId, amount: total, rides_count: rides.length, status: 'processing' })
    .select()
    .single();

  if (insErr || !payoutRow) {
    return { driver_id: driverId, status: 'failed', reason: insErr?.message ?? 'insert_failed' };
  }
  const payoutId = (payoutRow as { id: string }).id;

  await admin.from('rides').update({ payout_id: payoutId }).in('id', rides.map((r) => r.id));

  // 2) Transfer real para a conta conectada do motorista.
  try {
    const transfer = await stripe.transfers.create({
      amount: amountCents,
      currency: 'usd',
      destination: accountId,
      metadata: {
        payout_id: payoutId,
        driver_id: driverId,
        rides_count: String(rides.length),
        source: 'weekly_cron',
      },
    }, { idempotencyKey: `payout_${payoutId}` });

    await admin.from('payouts').update({
      status: 'completed',
      processed_at: new Date().toISOString(),
      stripe_transfer_id: transfer.id,
    }).eq('id', payoutId);

    return {
      driver_id: driverId,
      status: 'paid',
      amount: total,
      rides_count: rides.length,
      transfer_id: transfer.id,
    };
  } catch (transferErr) {
    // Falha ao mover dinheiro — desfaz a reserva para nova tentativa futura.
    const reason = String(transferErr);
    await admin.from('payouts').update({ status: 'failed', failure_reason: reason }).eq('id', payoutId);
    await admin.from('rides').update({ payout_id: null }).eq('payout_id', payoutId);
    return { driver_id: driverId, status: 'failed', reason };
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // ── Só a nossa infraestrutura pode disparar o repasse em lote ──────────────
  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!SUPABASE_SERVICE_KEY || token !== SUPABASE_SERVICE_KEY) {
    return json({ error: 'Não autorizado' }, 401);
  }

  try {
    // dry_run: apura quem receberia e quanto, sem mover dinheiro (para testes).
    let dryRun = false;
    try {
      const body = await req.json();
      dryRun = body?.dry_run === true;
    } catch { /* corpo vazio é ok */ }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // ── Corridas elegíveis de TODOS os motoristas ──────────────────────────────
    const { data: eligible } = await admin
      .from('rides')
      .select('id, driver_id, driver_amount')
      .eq('paid', true)
      .is('payout_id', null)
      .not('driver_amount', 'is', null)
      .not('driver_id', 'is', null);

    const rows = (eligible as EligibleRide[]) ?? [];
    if (rows.length === 0) {
      return json({ ok: true, dry_run: dryRun, drivers: 0, paid: 0, total: 0, results: [] });
    }

    // Agrupa as corridas por motorista.
    const byDriver = new Map<string, EligibleRide[]>();
    for (const r of rows) {
      const list = byDriver.get(r.driver_id) ?? [];
      list.push(r);
      byDriver.set(r.driver_id, list);
    }

    // Só motoristas com conta Express configurada entram no repasse.
    const driverIds = [...byDriver.keys()];
    const { data: drivers } = await admin
      .from('profiles')
      .select('id, stripe_account_id')
      .eq('type', 'driver')
      .in('id', driverIds)
      .not('stripe_account_id', 'is', null);

    const accountByDriver = new Map<string, string>();
    for (const d of (drivers as { id: string; stripe_account_id: string }[]) ?? []) {
      accountByDriver.set(d.id, d.stripe_account_id);
    }

    const results: DriverResult[] = [];

    for (const [driverId, rides] of byDriver) {
      const accountId = accountByDriver.get(driverId);
      if (!accountId) {
        results.push({ driver_id: driverId, status: 'skipped', reason: 'no_account' });
        continue;
      }

      if (dryRun) {
        const total = Math.round(rides.reduce((s, r) => s + Number(r.driver_amount), 0) * 100) / 100;
        results.push({ driver_id: driverId, status: 'paid', amount: total, rides_count: rides.length });
        continue;
      }

      try {
        results.push(await payoutDriver(admin, driverId, accountId, rides));
      } catch (e) {
        // Isola a falha de um motorista para não travar a fila inteira.
        results.push({ driver_id: driverId, status: 'failed', reason: String(e) });
      }
    }

    const paid = results.filter((r) => r.status === 'paid');
    const total = Math.round(paid.reduce((s, r) => s + (r.amount ?? 0), 0) * 100) / 100;

    return json({
      ok: true,
      dry_run: dryRun,
      drivers: byDriver.size,
      paid: paid.length,
      total,
      results,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
