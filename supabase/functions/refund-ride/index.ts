// Supabase Edge Function — extorna o pagamento de uma corrida via Stripe.
// Chamada pelo motorista ao cancelar uma corrida já aceita (e paga).
//
// Deploy:  npx supabase functions deploy refund-ride --no-verify-jwt

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
    const { rideId } = await req.json();
    if (!rideId) return json({ error: 'rideId obrigatório' }, 400);

    // ── Autenticação: passageiro OU motorista da corrida ─────────────────────
    // Deployada com --no-verify-jwt, então a verificação acontece AQUI. Tanto o
    // passageiro quanto o motorista podem cancelar/estornar a própria corrida.
    const authHeader = req.headers.get('Authorization') ?? '';
    const { data: { user }, error: authErr } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    }).auth.getUser();
    if (authErr || !user) return json({ error: 'Não autorizado' }, 401);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // ── Busca dados da corrida ───────────────────────────────────────────────
    const { data: ride, error: rideErr } = await admin
      .from('rides')
      .select('stripe_payment_intent_id, paid, passenger_id, driver_id')
      .eq('id', rideId)
      .single();

    if (rideErr || !ride) return json({ error: 'Corrida não encontrada' }, 404);

    const r = ride as {
      stripe_payment_intent_id?: string;
      paid?: boolean;
      passenger_id?: string;
      driver_id?: string;
    };

    // Autorização: só quem participa da corrida pode estornar.
    if (user.id !== r.passenger_id && user.id !== r.driver_id) {
      return json({ error: 'Não autorizado a estornar esta corrida.' }, 403);
    }

    // Corrida sem cobrança — nada a extornar
    if (!r.paid || !r.stripe_payment_intent_id) {
      return json({ success: true, no_charge: true });
    }

    // ── Cria o extorno no Stripe ─────────────────────────────────────────────
    const refund = await stripe.refunds.create({
      payment_intent: r.stripe_payment_intent_id,
    });

    if (refund.status === 'succeeded' || refund.status === 'pending') {
      // Marca a corrida como não-paga (extornada)
      await admin.from('rides').update({ paid: false }).eq('id', rideId);
      return json({ success: true, refund_id: refund.id });
    }

    return json({ error: `Extorno retornou status inesperado: ${refund.status}` }, 400);
  } catch (e: unknown) {
    const stripeErr = e as { raw?: { message?: string }; message?: string };
    const msg = stripeErr?.raw?.message ?? stripeErr?.message ?? String(e);
    return json({ error: msg }, 500);
  }
});
