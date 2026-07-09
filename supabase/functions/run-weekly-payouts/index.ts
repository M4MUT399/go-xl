// Supabase Edge Function — repasse SEMANAL automático (em lote) via Stripe Connect.
//
// Por que isso existe:
//   Além do botão "Solicitar repasse" (request-payout), a plataforma faz o
//   repasse de forma automática uma vez por semana — toda segunda-feira após o
//   meio-dia (horário de Orlando/ET). Esta função varre TODOS os motoristas com
//   conta Express habilitada e saldo pendente e cria um transfer por motorista.
//
// Quem chama:
//   O agendador do Postgres (pg_cron + pg_net) — NÃO um cliente. A função é
//   publicada COM verify_jwt: o gateway do Supabase valida a assinatura do
//   token e, aqui dentro, exigimos que o papel seja 'service_role'
//   (isServiceRole). O agendador manda a service-role key (lida do Vault) no
//   header Authorization. Um passageiro logado (role 'authenticated') é barrado.
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

/**
 * Confirma que o chamador porta a service-role key olhando o claim `role` do
 * JWT. A função é publicada COM verify_jwt, então o gateway do Supabase já
 * validou a ASSINATURA do token contra o segredo do projeto antes de chegar
 * aqui — só falta garantir que não é um passageiro logado (role
 * 'authenticated'). Não comparamos com nenhuma env de chave, então funciona
 * tanto com a chave legada (eyJ…) quanto com o novo formato.
 */
function isServiceRole(token: string): boolean {
  try {
    const payload = token.split('.')[1];
    if (!payload) return false;
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')));
    return decoded?.role === 'service_role';
  } catch {
    return false;
  }
}

interface EligibleRide { id: string; driver_id: string; driver_amount: number; stripe_payment_intent_id?: string | null }

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

  // 2) Transfer real: UM por corrida, amarrado à cobrança de origem via
  //    `source_transaction` quando disponível — remove a exigência de saldo
  //    disponível na plataforma (causa do "Insufficient funds" em modo teste).
  //    Corridas cujo transfer falha voltam a payout_id = null para nova tentativa.
  let transferred = 0;
  let paidTotal = 0;
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
        metadata: { payout_id: payoutId, driver_id: driverId, ride_id: ride.id, source: 'weekly_cron' },
      };
      if (chargeId) params.source_transaction = chargeId;
      const transfer = await stripe.transfers.create(params, {
        idempotencyKey: `payout_${payoutId}_${ride.id}`,
      });
      transferred += 1;
      paidTotal = Math.round((paidTotal + Number(ride.driver_amount)) * 100) / 100;
      if (!firstTransferId) firstTransferId = transfer.id;
    } catch (e) {
      lastReason = String(e);
      failedIds.push(ride.id);
    }
  }

  if (failedIds.length) {
    await admin.from('rides').update({ payout_id: null }).in('id', failedIds);
  }

  if (transferred === 0) {
    await admin.from('payouts')
      .update({ status: 'failed', failure_reason: lastReason ?? 'transfer_failed' })
      .eq('id', payoutId);
    return { driver_id: driverId, status: 'failed', reason: lastReason ?? 'transfer_failed' };
  }

  await admin.from('payouts').update({
    status: 'completed',
    processed_at: new Date().toISOString(),
    stripe_transfer_id: firstTransferId,
    amount: paidTotal,
    rides_count: transferred,
  }).eq('id', payoutId);

  return {
    driver_id: driverId,
    status: 'paid',
    amount: paidTotal,
    rides_count: transferred,
    transfer_id: firstTransferId,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // ── Só quem porta a service-role key pode disparar o repasse em lote ───────
  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!isServiceRole(token)) {
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
      .select('id, driver_id, driver_amount, stripe_payment_intent_id')
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
