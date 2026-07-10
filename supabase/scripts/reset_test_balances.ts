// reset_test_balances.ts — DESTRAVE de repasse em ambiente de TESTE.
//
// O que faz (nesta ordem):
//   1) TRAVA DE SEGURANÇA (obrigatória): recusa rodar se detectar produção —
//      chave live do Stripe (sk_live_/rk_live_) OU APP_ENV de produção. Aborta.
//   2) Marca 'failed' todos os payouts presos em pending/processing e devolve as
//      corridas deles ao saldo (o que destrava o motorista).
//   3) ZERA o saldo de todos os motoristas ARQUIVANDO as corridas elegíveis: cria
//      um payout 'completed' (failure_reason='archived_by_reset') por motorista e
//      vincula as corridas a ele — histórico preservado, saldo = 0.
//   4) (Opcional) REVERTE no sandbox do Stripe os transfers órfãos dos payouts
//      presos que já tinham stripe_transfer_id (best-effort).
//
// Segurança de execução:
//   • DRY-RUN por padrão: sem `--yes` só RELATA o que faria, sem mudar nada.
//   • Idempotente: rodar de novo após um reset não recria saldo (não há elegíveis).
//
// Como rodar (o USUÁRIO roda; a IA não tem os segredos):
//   export SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... STRIPE_SECRET_KEY=sk_test_...
//   # relatório (não muda nada):
//   deno run --allow-env --allow-net supabase/scripts/reset_test_balances.ts
//   # aplicar de verdade:
//   deno run --allow-env --allow-net supabase/scripts/reset_test_balances.ts --yes
//   # aplicar sem tocar no Stripe:
//   deno run --allow-env --allow-net supabase/scripts/reset_test_balances.ts --yes --no-stripe

import Stripe from 'npm:stripe@17';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { assertTestEnvironment, isLiveStripeKey } from '../functions/_shared/payout.ts';
import { centsToDollars, sumDollarsToCents } from '../functions/_shared/money.ts';

interface EligibleRide { id: string; driver_id: string; driver_amount: number }
interface ActivePayout { id: string; driver_id: string; stripe_transfer_id: string | null }

const APPLY = Deno.args.includes('--yes') || Deno.args.includes('-y');
const SKIP_STRIPE = Deno.args.includes('--no-stripe');

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const STRIPE_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const APP_ENV = Deno.env.get('APP_ENV') ?? Deno.env.get('NODE_ENV') ?? '';

function line(s = '') { console.log(s); }

async function main() {
  line('════════════════════════════════════════════════════════');
  line(' reset_test_balances — destrave de repasse (modo TESTE)');
  line('════════════════════════════════════════════════════════');

  // ── 1) TRAVA DE SEGURANÇA — aborta se detectar produção ───────────────────
  //     (lança e o processo sai com código ≠ 0 antes de tocar em qualquer dado)
  assertTestEnvironment({ stripeKey: STRIPE_KEY, appEnv: APP_ENV });
  line('✓ Trava de segurança OK: ambiente de teste (sem chaves live / APP_ENV de prod).');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error('Faltam SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY no ambiente.');
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);
  const doStripe = !SKIP_STRIPE && !!STRIPE_KEY && !isLiveStripeKey(STRIPE_KEY);
  const stripe = doStripe ? new Stripe(STRIPE_KEY, { apiVersion: '2025-01-27.acacia' }) : null;

  line(APPLY ? '\n► MODO: APLICAR (--yes) — vai alterar dados.' : '\n► MODO: DRY-RUN — nada será alterado. Use --yes para aplicar.');
  if (!SKIP_STRIPE && !STRIPE_KEY) line('  (STRIPE_SECRET_KEY ausente → reversões no Stripe serão puladas.)');
  if (SKIP_STRIPE) line('  (--no-stripe → reversões no Stripe puladas.)');

  // ── Levantamento (report) ──────────────────────────────────────────────────
  const { data: activeRows } = await admin
    .from('payouts')
    .select('id, driver_id, stripe_transfer_id')
    .in('status', ['pending', 'processing']);
  const active = (activeRows as ActivePayout[]) ?? [];

  const { data: eligibleRows } = await admin
    .from('rides')
    .select('id, driver_id, driver_amount')
    .eq('paid', true)
    .is('payout_id', null)
    .not('driver_amount', 'is', null)
    .not('driver_id', 'is', null);
  const eligible = (eligibleRows as EligibleRide[]) ?? [];

  const byDriver = new Map<string, EligibleRide[]>();
  for (const r of eligible) {
    const list = byDriver.get(r.driver_id) ?? [];
    list.push(r);
    byDriver.set(r.driver_id, list);
  }
  const totalCents = sumDollarsToCents(eligible.map((r) => r.driver_amount));
  const withTransfer = active.filter((p) => !!p.stripe_transfer_id);

  line('\n── Situação atual ──────────────────────────────────────');
  line(`  Payouts presos (pending/processing): ${active.length}`);
  line(`    └ com transfer no Stripe p/ reverter: ${withTransfer.length}`);
  line(`  Motoristas com saldo elegível:        ${byDriver.size}`);
  line(`  Corridas elegíveis a arquivar:        ${eligible.length}`);
  line(`  Saldo total a zerar:                  $${centsToDollars(totalCents).toFixed(2)}`);

  if (!APPLY) {
    line('\nDRY-RUN concluído. Reveja acima e rode de novo com --yes para aplicar.');
    return;
  }

  // ── 2) Destrava payouts presos: 'failed' + devolve as corridas ─────────────
  if (active.length) {
    const ids = active.map((p) => p.id);
    await admin.from('payouts').update({ status: 'failed', failure_reason: 'reset_test_balances' }).in('id', ids);
    await admin.from('rides').update({ payout_id: null }).in('payout_id', ids);
    line(`\n✓ ${active.length} payout(s) preso(s) marcados 'failed' e corridas devolvidas ao saldo.`);
  }

  // ── 3) Zera saldos: arquiva as corridas elegíveis num payout 'completed' ────
  //     Reconsulta os elegíveis (agora inclui as corridas devolvidas no passo 2).
  const { data: freshRows } = await admin
    .from('rides')
    .select('id, driver_id, driver_amount')
    .eq('paid', true)
    .is('payout_id', null)
    .not('driver_amount', 'is', null)
    .not('driver_id', 'is', null);
  const fresh = (freshRows as EligibleRide[]) ?? [];
  const freshByDriver = new Map<string, EligibleRide[]>();
  for (const r of fresh) {
    const list = freshByDriver.get(r.driver_id) ?? [];
    list.push(r);
    freshByDriver.set(r.driver_id, list);
  }

  let archivedDrivers = 0;
  let archivedRides = 0;
  for (const [driverId, rides] of freshByDriver) {
    const amount = centsToDollars(sumDollarsToCents(rides.map((r) => r.driver_amount)));
    const { data: payoutRow, error: insErr } = await admin
      .from('payouts')
      .insert({
        driver_id: driverId,
        amount,
        rides_count: rides.length,
        status: 'completed',
        failure_reason: 'archived_by_reset',
        processed_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (insErr || !payoutRow) {
      line(`  ! Falha ao arquivar motorista ${driverId}: ${insErr?.message ?? 'sem id'}`);
      continue;
    }
    const payoutId = (payoutRow as { id: string }).id;
    await admin.from('rides').update({ payout_id: payoutId }).in('id', rides.map((r) => r.id));
    archivedDrivers += 1;
    archivedRides += rides.length;
  }
  line(`✓ Saldo zerado: ${archivedRides} corrida(s) arquivada(s) para ${archivedDrivers} motorista(s).`);

  // ── 4) Reverte transfers órfãos no sandbox do Stripe (best-effort) ─────────
  if (stripe && withTransfer.length) {
    let reversed = 0;
    for (const p of withTransfer) {
      try {
        await stripe.transfers.createReversal(p.stripe_transfer_id as string);
        reversed += 1;
      } catch (e) {
        line(`  ! Reversão falhou p/ transfer ${p.stripe_transfer_id}: ${String(e)}`);
      }
    }
    line(`✓ Reversões no Stripe (sandbox): ${reversed}/${withTransfer.length}.`);
  } else if (!doStripe && withTransfer.length) {
    line(`ℹ ${withTransfer.length} transfer(s) NÃO revertidos (Stripe pulado).`);
  }

  line('\n✅ Reset concluído. Motoristas destravados e saldos zerados. Gere novas');
  line('   corridas de teste para validar o repasse ponta-a-ponta.');
}

main().catch((e) => {
  console.error(`\n✗ ABORTADO: ${String(e?.message ?? e)}`);
  Deno.exit(1);
});
