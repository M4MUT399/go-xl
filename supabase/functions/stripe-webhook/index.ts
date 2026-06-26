// Supabase Edge Function — recebe eventos do Stripe e atualiza o banco.
//
// Eventos tratados:
//   checkout.session.completed (mode=setup) → grava payment_method_id + card_last4 + card_brand
//   payment_intent.succeeded                → marca rides.paid = true (backup do charge-ride)
//
// Deploy:  npx supabase functions deploy stripe-webhook
// Segredo: npx supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
//   (obtido no Stripe Dashboard → Developers → Webhooks → seu endpoint)
//   Se não estiver configurado, a assinatura não é verificada (só usar em dev).

import Stripe from 'npm:stripe@17';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2025-01-27.acacia',
});

const webhookSecret       = Deno.env.get('STRIPE_WEBHOOK_SECRET')     ?? '';
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const body = await req.text();
  const sig  = req.headers.get('stripe-signature') ?? '';

  let event: Stripe.Event;
  try {
    event = webhookSecret
      ? stripe.webhooks.constructEvent(body, sig, webhookSecret)
      : (JSON.parse(body) as Stripe.Event);
  } catch (e) {
    return new Response(`Webhook error: ${e}`, { status: 400 });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // ── checkout.session.completed (modo setup) ──────────────────────────────
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;

    if (session.mode === 'setup' && session.setup_intent) {
      const passengerId = session.metadata?.passenger_id;
      if (!passengerId) {
        return new Response(JSON.stringify({ warning: 'passenger_id ausente no metadata' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Recupera o SetupIntent para obter o payment_method
      const setupIntent = await stripe.setupIntents.retrieve(
        session.setup_intent as string,
      );
      const pmId = setupIntent.payment_method as string | null;
      if (!pmId) {
        return new Response(JSON.stringify({ warning: 'payment_method ausente no setup_intent' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Detalhes do cartão (last4, brand)
      const pm   = await stripe.paymentMethods.retrieve(pmId);
      const card = pm.card;

      // Define como método padrão do Customer
      await stripe.customers.update(session.customer as string, {
        invoice_settings: { default_payment_method: pmId },
      });

      // Busca dados do customer para popular o perfil se ele não existir
      const customer = await stripe.customers.retrieve(session.customer as string) as Stripe.Customer;

      // Busca o perfil atual para PRESERVAR os campos já preenchidos —
      // o upsert sobrescreveria phone/rating/total_rides/full_name com defaults.
      const { data: existing } = await admin
        .from('profiles')
        .select('*')
        .eq('id', passengerId)
        .single();
      const ex = existing as Record<string, unknown> | null;

      // UPSERT: se o perfil não existir no banco (ex: signup incompleto),
      // cria um mínimo válido com os dados do Stripe para não perder o cartão.
      // Se já existir, mantém os valores atuais (?? preserva).
      await admin.from('profiles').upsert({
        id:                       passengerId,
        email:                    (ex?.email as string)      ?? customer.email ?? '',
        full_name:                (ex?.full_name as string)  ?? customer.name  ?? '',
        phone:                    (ex?.phone as string)      ?? '',
        type:                     (ex?.type as string)       ?? 'passenger',
        rating:                   (ex?.rating as number)     ?? 5.0,
        total_rides:              (ex?.total_rides as number) ?? 0,
        language:                 (ex?.language as string)   ?? 'en',
        stripe_customer_id:       session.customer as string,
        stripe_payment_method_id: pmId,
        card_last4:               card?.last4  ?? null,
        card_brand:               card?.brand  ?? null,
      }, { onConflict: 'id' });
    }
  }

  // ── payment_intent.succeeded (backup) ───────────────────────────────────
  if (event.type === 'payment_intent.succeeded') {
    const pi     = event.data.object as Stripe.PaymentIntent;
    const rideId = pi.metadata?.rideId;
    if (rideId) {
      await admin.from('rides').update({ paid: true }).eq('id', rideId);
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
