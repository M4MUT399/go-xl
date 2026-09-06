// Supabase Edge Function — repasse SEMANAL automático (em lote) via Stripe Connect.
//
// Por que isso existe:
//   Além do botão "Solicitar repasse" (request-payout), a plataforma faz o
//   repasse de forma automática uma vez por semana — toda segunda-feira após o
//   meio-dia (horário de Orlando/ET). Esta função varre TODOS os motoristas com
//   conta Express habilitada e saldo pendente e cria um transfer por motorista.
//
// Quem chama:
//   O agendador do Postgres (pg_cron + pg_net) — NÃO um cliente. Nenhuma tela
//   do app chama esta função (conferido com grep em src/); o único call site é
//   a migração 0035. O agendador manda a service-role key, lida do Vault, no
//   header Authorization, e aqui dentro ela é COMPARADA com a chave do projeto
//   em tempo constante (_shared/serviceAuth.ts).
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE A AUTENTICAÇÃO MUDOU (06/09/2026)
// ─────────────────────────────────────────────────────────────────────────────
//
// A versão anterior fazia `atob` do payload do JWT e lia o claim `role`. Duas
// coisas quebradas nisso, e a segunda foi medida em produção:
//
//   1. `atob` é base64, não criptografia, e esta função está publicada com
//      `verify_jwt = false` (conferido em `supabase functions list`) — o
//      gateway NÃO valida assinatura nenhuma antes de chegar aqui. Ou seja:
//      `Bearer x.<base64 de {"role":"service_role"}>.x` disparava o REPASSE
//      SEMANAL INTEIRO, de qualquer pessoa, sem credencial. O cabeçalho antigo
//      afirmava "publicada COM verify_jwt" e contradizia a própria linha de
//      deploy logo abaixo dele; era a contradição apontada na AUDITORIA, e o
//      lado errado dela é que estava em produção.
//
//   2. O projeto rotacionou as chaves em 04/09/2026: a service-role key deixou
//      de ser um JWT (`eyJ…`) e passou ao formato novo (`sb_secret_…`), que não
//      tem ponto nem payload. `token.split('.')[1]` devolve `undefined` e a
//      checagem REPROVA a chave legítima. Enquanto o Vault guardar a chave
//      antiga isso não aparece — e foi exatamente esse descompasso que deixou
//      `sweep-stale-requesting` e `sweep-unpaid-completed` levando 401 do cron
//      (32 respostas 404 e depois 5 respostas 401 em `net._http_response`).
//
// A comparação com a env resolve os dois: não depende de assinatura (funciona
// com ou sem `verify_jwt`), não depende do FORMATO da chave, e não aceita nada
// que não seja a chave do projeto.
//
// ⚠️ ORDEM DE IMPLANTAÇÃO. Esta função passa a exigir a chave que está em
// `SUPABASE_SERVICE_ROLE_KEY` (a NOVA). O `vault.secrets.service_role_key`, que
// é o que o cron apresenta, precisa ser atualizado para essa mesma chave — ver
// a migração 0035. Enquanto ele guardar a antiga, o repasse semanal leva 401
// (o job roda segundas, 17:00 UTC). Os dois passos são independentes: publicar
// esta função e atualizar o Vault. Depois do segundo, os QUATRO jobs que leem
// esse segredo voltam a funcionar de uma vez.
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
import { reconcileSettlement, type RideTransferResult } from '../_shared/payout.ts';
import { centsToDollars, dollarsToCents, sumDollarsToCents } from '../_shared/money.ts';
import { claimPendingTips, settleTips, type PendingTip } from '../_shared/tipPayout.ts';
import { isServiceRoleCaller } from '../_shared/serviceAuth.ts';

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
  pendingTips: PendingTip[],
): Promise<DriverResult> {
  // Confirma no Stripe que a conta pode receber payouts AGORA (flag do banco
  // pode estar desatualizada — só é sincronizada quando o motorista abre o app).
  const account = await stripe.accounts.retrieve(accountId);
  if (!account.payouts_enabled) {
    return { driver_id: driverId, status: 'skipped', reason: 'payouts_disabled' };
  }

  // Saldo em CENTAVOS inteiros (fim do "saldo fantasma" de float; _shared/money).
  // A gorjeta entra no saldo: é dinheiro do motorista igual à tarifa (ver 0064).
  const fareCents = sumDollarsToCents(rides.map((r) => r.driver_amount));
  const tipCents = sumDollarsToCents(pendingTips.map((t) => t.tip_amount));
  const amountCents = fareCents + tipCents;
  if (amountCents <= 0) {
    return { driver_id: driverId, status: 'skipped', reason: 'no_balance' };
  }

  // 1) Cria o payout 'processing'. O índice único parcial (migração 0046) garante
  //    UM payout ativo por motorista: se houver um repasse manual em andamento, o
  //    insert falha com 23505 e este motorista é PULADO (não repassa em dobro).
  const { data: payoutRow, error: insErr } = await admin
    .from('payouts')
    .insert({ driver_id: driverId, amount: centsToDollars(amountCents), rides_count: rides.length, status: 'processing' })
    .select('id')
    .single();

  if (insErr || !payoutRow) {
    if (insErr?.code === '23505') {
      return { driver_id: driverId, status: 'skipped', reason: 'payout_in_progress' };
    }
    return { driver_id: driverId, status: 'failed', reason: insErr?.message ?? 'insert_failed' };
  }
  const payoutId = (payoutRow as { id: string }).id;

  // RESERVA ATÔMICA: só vincula as corridas AINDA livres (payout_id IS NULL); o
  // RETURNING (.select) devolve exatamente o que foi reservado.
  const { data: claimed } = await admin
    .from('rides')
    .update({ payout_id: payoutId })
    .in('id', rides.map((r) => r.id))
    .is('payout_id', null)
    .select('id, driver_id, driver_amount, stripe_payment_intent_id');
  const claimedRows = (claimed as EligibleRide[]) ?? [];

  // Mesma reserva atômica para as GORJETAS, por coluna própria (tip_payout_id).
  const claimedTips = await claimPendingTips(admin, driverId, payoutId);

  if (claimedRows.length === 0 && claimedTips.length === 0) {
    await admin.from('payouts').update({ status: 'failed', failure_reason: 'no_rides_claimed' }).eq('id', payoutId);
    return { driver_id: driverId, status: 'skipped', reason: 'no_rides_claimed' };
  }

  // 2) Transfer real: UM por corrida, amarrado à cobrança de origem via
  //    `source_transaction` quando disponível — remove a exigência de saldo
  //    disponível na plataforma (causa do "Insufficient funds" em modo teste).
  const results: RideTransferResult[] = [];
  for (const ride of claimedRows) {
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
        metadata: { payout_id: payoutId, driver_id: driverId, ride_id: ride.id, source: 'weekly_cron' },
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

  // 3) Gorjetas: transfer PRÓPRIO por corrida, sacado da cobrança da gorjeta e
  //    INTEIRO (sem comissão da plataforma). Ver _shared/tipPayout.ts.
  const tipSettled = await settleTips(
    stripe,
    accountId,
    payoutId,
    claimedTips,
    { driver_id: driverId, source: 'weekly_cron' },
    resolveChargeId,
  );

  // Conciliação pura (mesma regra do request-payout): completed/failed + quais desvincular.
  const settled = reconcileSettlement(results);
  if (settled.failedRideIds.length) {
    await admin.from('rides').update({ payout_id: null }).in('id', settled.failedRideIds);
  }
  if (tipSettled.failedRideIds.length) {
    await admin.from('rides').update({ tip_payout_id: null }).in('id', tipSettled.failedRideIds);
  }

  // Falha total só quando NADA saiu — nem tarifa, nem gorjeta. Um repasse só de
  // gorjeta é legítimo: a corrida pode já ter sido paga num repasse anterior.
  if (settled.transferredCount === 0 && tipSettled.transferredCount === 0) {
    await admin.from('payouts')
      .update({ status: 'failed', failure_reason: settled.lastReason ?? 'transfer_failed' })
      .eq('id', payoutId);
    await admin.from('rides').update({ payout_id: null }).eq('payout_id', payoutId);
    await admin.from('rides').update({ tip_payout_id: null }).eq('tip_payout_id', payoutId);
    return { driver_id: driverId, status: 'failed', reason: settled.lastReason ?? 'transfer_failed' };
  }

  const totalCents = settled.transferredCents + tipSettled.transferredCents;
  // Corridas DISTINTAS: a mesma corrida pode ter mandado tarifa e gorjeta.
  const paidRideIds = new Set<string>([
    ...results.filter((r) => r.ok).map((r) => r.rideId),
    ...claimedTips.filter((t) => !tipSettled.failedRideIds.includes(t.id)).map((t) => t.id),
  ]);

  await admin.from('payouts').update({
    status: 'completed',
    processed_at: new Date().toISOString(),
    stripe_transfer_id: settled.firstTransferId,
    amount: centsToDollars(totalCents),
    rides_count: paidRideIds.size,
  }).eq('id', payoutId);

  return {
    driver_id: driverId,
    status: 'paid',
    amount: centsToDollars(totalCents),
    rides_count: paidRideIds.size,
    transfer_id: settled.firstTransferId,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  // ── Só quem porta a service-role key pode disparar o repasse em lote ───────
  // Não decodifica JWT: COMPARA com a chave de serviço, em tempo constante.
  // Ver o bloco "POR QUE A AUTENTICAÇÃO MUDOU" no cabeçalho.
  if (!isServiceRoleCaller(req.headers.get('Authorization'), SUPABASE_SERVICE_KEY)) {
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

    // ── Gorjetas pendentes de TODOS os motoristas ─────────────────────────────
    // Varredura SEPARADA de propósito: a gorjeta tem reserva própria
    // (tip_payout_id), então uma corrida já repassada pode continuar devendo
    // gorjeta. Se dependêssemos só da varredura acima, essa gorjeta nunca
    // entraria em repasse nenhum.
    const { data: eligibleTips } = await admin
      .from('rides')
      .select('id, driver_id, tip_amount, tip_payment_intent_id')
      .eq('paid', true)
      .is('tip_payout_id', null)
      .gt('tip_amount', 0)
      .not('driver_id', 'is', null);

    const tipRows = ((eligibleTips as (PendingTip & { driver_id: string })[]) ?? []);

    if (rows.length === 0 && tipRows.length === 0) {
      return json({ ok: true, dry_run: dryRun, drivers: 0, paid: 0, total: 0, results: [] });
    }

    // Agrupa as corridas por motorista.
    const byDriver = new Map<string, EligibleRide[]>();
    for (const r of rows) {
      const list = byDriver.get(r.driver_id) ?? [];
      list.push(r);
      byDriver.set(r.driver_id, list);
    }

    // Gorjetas por motorista — e motorista que só tem gorjeta a receber também
    // entra na fila (entrada vazia de corridas).
    const tipsByDriver = new Map<string, PendingTip[]>();
    for (const t of tipRows) {
      const list = tipsByDriver.get(t.driver_id) ?? [];
      list.push(t);
      tipsByDriver.set(t.driver_id, list);
      if (!byDriver.has(t.driver_id)) byDriver.set(t.driver_id, []);
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

      const tips = tipsByDriver.get(driverId) ?? [];

      if (dryRun) {
        const total = centsToDollars(
          sumDollarsToCents(rides.map((r) => r.driver_amount)) + sumDollarsToCents(tips.map((t) => t.tip_amount)),
        );
        results.push({ driver_id: driverId, status: 'paid', amount: total, rides_count: rides.length });
        continue;
      }

      try {
        results.push(await payoutDriver(admin, driverId, accountId, rides, tips));
      } catch (e) {
        // Isola a falha de um motorista para não travar a fila inteira.
        results.push({ driver_id: driverId, status: 'failed', reason: String(e) });
      }
    }

    const paid = results.filter((r) => r.status === 'paid');
    const total = centsToDollars(sumDollarsToCents(paid.map((r) => r.amount)));

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
