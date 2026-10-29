// Supabase Edge Function — cobra a TAXA DE ESPERA no embarque (0091).
//
// Regra (Edson, 29/10/2026): 5 min grátis depois que o motorista toca
// "Cheguei"; depois, US$ 0,75 por minuto cheio até a corrida começar
// (src/lib/fare.ts → waitFeeFor). Os dois instantes vêm do RELÓGIO DO SERVIDOR:
// driver_arrived_at (RPC mark_driver_arrived) e boarded_at (trigger de 0039,
// carimbado quando a corrida vira in_progress). O app só pede "cobre a espera
// desta corrida" — nunca diz quanto.
//
// Cobrança à parte, no cartão salvo, off-session — o mesmo caminho da gorjeta
// (tip-ride), porque a tarifa já foi cobrada no aceite (charge-ride). A fatia
// do motorista (driver_share_percent, padrão 0,80) é somada a driver_amount e o
// resto a platform_fee; como o repasse soma driver_amount, a espera entra no
// repasse semanal sem mudar nada lá.
//
// Idempotente: repetir a chamada não cobra de novo. A chave do Stripe leva a
// corrida e o valor, e antes de cobrar a função procura no Stripe uma espera já
// paga desta corrida (metadata.type = 'wait_fee') — mesmo reparador da gorjeta.
//
// Quem chama: o app do MOTORISTA, logo depois de iniciar a corrida. Só o
// motorista da corrida (ou o service_role) passa.
//
// Deploy:  npx supabase functions deploy charge-wait-fee --no-verify-jwt

import Stripe from 'npm:stripe@17';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { waitFeeFor } from '../_shared/fare.ts';
import { descreverFalhaDeGorjeta } from '../_shared/tipCharge.ts';

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

const round2 = (n: number) => Math.round(n * 100) / 100;

interface RideRow {
  id: string;
  passenger_id: string;
  driver_id: string | null;
  status: string;
  driver_arrived_at: string | null;
  boarded_at: string | null;
  wait_fee_amount: number | null;
  wait_fee_payment_intent_id: string | null;
  driver_amount: number | null;
  platform_fee: number | null;
  payout_id: string | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: CORS });

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

  try {
    const { rideId } = await req.json();
    if (!rideId) return json({ error: 'rideId obrigatório' }, 400);

    const authHeader = req.headers.get('Authorization') ?? '';
    const { data: { user }, error: authErr } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    }).auth.getUser();
    if (authErr || !user) return json({ error: 'Não autorizado' }, 401);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: rideRow, error: rideErr } = await admin
      .from('rides')
      .select('id, passenger_id, driver_id, status, driver_arrived_at, boarded_at, wait_fee_amount, wait_fee_payment_intent_id, driver_amount, platform_fee, payout_id')
      .eq('id', rideId)
      .single();
    if (rideErr || !rideRow) return json({ error: 'Corrida não encontrada' }, 404);
    const r = rideRow as RideRow;

    if (user.id !== r.driver_id) return json({ error: 'Não autorizado' }, 403);
    if (!['in_progress', 'completed'].includes(r.status) || !r.boarded_at) {
      return json({ error: 'A corrida ainda não começou.' }, 409);
    }
    if (r.wait_fee_amount != null) {
      return json({ success: true, already: true, minutes: null, amount: r.wait_fee_amount });
    }

    const fee = waitFeeFor(
      r.driver_arrived_at ? Date.parse(r.driver_arrived_at) : null,
      Date.parse(r.boarded_at),
    );

    if (fee.amount <= 0) {
      await admin.from('rides').update({ wait_fee_minutes: fee.minutes, wait_fee_amount: 0 }).eq('id', rideId);
      return json({ success: true, minutes: fee.minutes, amount: 0 });
    }

    const { data: pax } = await admin
      .from('profiles')
      .select('stripe_customer_id, stripe_payment_method_id')
      .eq('id', r.passenger_id)
      .single();
    const p = pax as { stripe_customer_id?: string | null; stripe_payment_method_id?: string | null } | null;
    if (!p?.stripe_customer_id || !p?.stripe_payment_method_id) {
      return json({ error: 'Passageiro sem cartão salvo.' }, 400);
    }

    const amountCents = Math.round(fee.amount * 100);

    // Já cobrada antes (chave expirada, gravação que falhou)? Grava e sai.
    let intentId: string | null = null;
    try {
      const lista = await stripe.paymentIntents.list({ customer: p.stripe_customer_id, limit: 100 });
      const paga = lista.data.find((pi) =>
        pi.status === 'succeeded' && pi.metadata?.rideId === rideId && pi.metadata?.type === 'wait_fee');
      if (paga) intentId = paga.id;
    } catch (e) {
      console.error('[charge-wait-fee] falha ao procurar espera já cobrada', e);
      return json({ error: 'Não deu para conferir a cobrança agora. Tente de novo.' }, 503);
    }

    if (!intentId) {
      const pi = await stripe.paymentIntents.create({
        amount: amountCents,
        currency: 'usd',
        customer: p.stripe_customer_id,
        payment_method: p.stripe_payment_method_id,
        off_session: true,
        confirm: true,
        metadata: { rideId, type: 'wait_fee', minutes: String(fee.minutes) },
        description: `Go XL — Wait time (${fee.minutes} min)`,
      }, { idempotencyKey: `wait_${rideId}_${amountCents}` });
      if (pi.status !== 'succeeded') return json({ error: `Status inesperado: ${pi.status}` }, 400);
      intentId = pi.id;
    }

    // Fatia do motorista sobre a espera — mesma faixa da tarifa.
    let driverAmount = r.driver_amount;
    let platformFee = r.platform_fee;
    if (r.payout_id == null && r.driver_id) {
      const { data: prof } = await admin
        .from('profiles').select('driver_share_percent').eq('id', r.driver_id).single();
      const raw = (prof as { driver_share_percent?: number | null } | null)?.driver_share_percent;
      const share = typeof raw === 'number' && raw > 0 && raw <= 1 ? raw : 0.8;
      const driverCut = round2(fee.amount * share);
      driverAmount = round2((r.driver_amount ?? 0) + driverCut);
      platformFee = round2((r.platform_fee ?? 0) + (fee.amount - driverCut));
    } else {
      console.error('[charge-wait-fee] corrida já repassada — espera cobrada fica toda na plataforma até ajuste manual', { rideId });
    }

    const { error: upErr } = await admin
      .from('rides')
      .update({
        wait_fee_minutes: fee.minutes,
        wait_fee_amount: fee.amount,
        wait_fee_payment_intent_id: intentId,
        driver_amount: driverAmount,
        platform_fee: platformFee,
      })
      .eq('id', rideId);
    if (upErr) {
      console.error('[charge-wait-fee] cobrada mas NÃO gravada', { rideId, intentId, upErr });
      return json({ error: 'Cobrada, mas não registrada. Não tente de novo.' }, 500);
    }

    return json({ success: true, minutes: fee.minutes, amount: fee.amount });
  } catch (e: unknown) {
    console.error('[charge-wait-fee] falha', e);
    const falha = descreverFalhaDeGorjeta(e);
    return json({ error: falha.message }, falha.status);
  }
});
