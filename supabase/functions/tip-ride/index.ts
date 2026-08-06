// Supabase Edge Function — cobra gorjeta do passageiro após o término da corrida.
//
// Deploy:  npx supabase functions deploy tip-ride --no-verify-jwt
// Chamada: POST com { rideId: string, amountCents: number } + JWT do passageiro

import Stripe from 'npm:stripe@17';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2025-01-27.acacia',
});

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')         ?? '';

// Teto de gorjeta (proteção contra abuso/cobrança de valor arbitrário).
// Configurável por env; default $200.
const MAX_TIP_CENTS = Number(Deno.env.get('MAX_TIP_CENTS') ?? '20000') || 20000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS });
  }

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });

  try {
    const { rideId, amountCents } = await req.json();
    if (!rideId)      return json({ error: 'rideId obrigatório' }, 400);
    if (!amountCents || amountCents < 50)
      return json({ error: 'Valor mínimo de gorjeta: $0.50' }, 400);
    if (amountCents > MAX_TIP_CENTS)
      return json({ error: `Gorjeta acima do máximo permitido ($${(MAX_TIP_CENTS / 100).toFixed(2)}).` }, 400);

    // ── Autenticação do passageiro ───────────────────────────────────────────
    // Esta função é deployada com --no-verify-jwt, então a verificação precisa
    // acontecer AQUI no código (senão o endpoint fica aberto para cobrar o
    // cartão salvo de qualquer passageiro por quem souber o rideId).
    const authHeader = req.headers.get('Authorization') ?? '';
    const { data: { user }, error: authErr } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    }).auth.getUser();
    if (authErr || !user) return json({ error: 'Não autorizado' }, 401);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // ── Busca dados da corrida ───────────────────────────────────────────────
    const { data: ride, error: rideErr } = await admin
      .from('rides')
      .select('passenger_id, status, tip_amount')
      .eq('id', rideId)
      .single();

    if (rideErr || !ride) return json({ error: 'Corrida não encontrada' }, 404);

    const r = ride as { passenger_id: string; status: string; tip_amount?: number };

    // Autorização: só o passageiro DAQUELA corrida pode dar a gorjeta.
    if (user.id !== r.passenger_id) {
      return json({ error: 'Não autorizado a dar gorjeta nesta corrida.' }, 403);
    }

    // Idempotência: gorjeta já registrada
    if (r.tip_amount && r.tip_amount > 0) {
      return json({ success: true, already_tipped: true });
    }

    // ── Busca dados de pagamento do passageiro ───────────────────────────────
    const { data: passenger, error: passengerErr } = await admin
      .from('profiles')
      .select('stripe_customer_id, stripe_payment_method_id')
      .eq('id', r.passenger_id)
      .single();

    const p = passenger as {
      stripe_customer_id?: string;
      stripe_payment_method_id?: string;
    } | null;

    if (passengerErr || !p?.stripe_customer_id || !p?.stripe_payment_method_id) {
      return json({ error: 'Passageiro sem cartão salvo.' }, 400);
    }

    // ── Cobra a gorjeta off-session ──────────────────────────────────────────
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: p.stripe_customer_id,
      payment_method: p.stripe_payment_method_id,
      off_session: true,
      confirm: true,
      metadata: { rideId, type: 'tip' },
      description: 'Go XL — Gorjeta Executive XL',
    }, {
      idempotencyKey: `tip_${rideId}`,
    });

    if (paymentIntent.status === 'succeeded') {
      await admin
        .from('rides')
        .update({ tip_amount: amountCents / 100 })
        .eq('id', rideId);
      return json({ success: true });
    }

    return json({ error: `Status inesperado: ${paymentIntent.status}` }, 400);
  } catch (e: unknown) {
    const stripeErr = e as { raw?: { message?: string }; message?: string };
    const msg = stripeErr?.raw?.message ?? stripeErr?.message ?? String(e);
    return json({ error: msg }, 500);
  }
});
