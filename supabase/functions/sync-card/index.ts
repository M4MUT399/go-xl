// Supabase Edge Function — sincroniza o cartão do passageiro DIRETO do Stripe.
//
// Por que isso existe:
//   O fluxo antigo dependia 100% do webhook `checkout.session.completed` chegar
//   no momento exato em que o app fazia o poll. Se o webhook atrasava, falhava
//   (ex: 401) ou tinha retry de minutos, o passageiro travava em "Quase lá".
//
//   Esta função é DETERMINÍSTICA: quando o app volta do Checkout, ele chama
//   /sync-card. A função consulta o Stripe na hora, pega o payment method já
//   anexado ao Customer e grava no perfil. Não há corrida com o webhook.
//
// Deploy:  npx supabase functions deploy sync-card
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
    // ── Autentica o passageiro via JWT ───────────────────────────────────────
    const authHeader = req.headers.get('Authorization') ?? '';
    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await anonClient.auth.getUser();
    if (authErr || !user) return json({ error: 'Não autorizado' }, 401);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // ── Perfil atual (para preservar campos já existentes) ───────────────────
    const { data: profile } = await admin
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .single();

    const p = profile as Record<string, unknown> | null;

    // ── Descobre o Customer do Stripe ────────────────────────────────────────
    let customerId = (p?.stripe_customer_id as string) ?? '';

    // Fallback: se o customer_id não foi salvo no perfil (ex: linha não existia
    // quando o setup-card rodou), procura no Stripe pelo metadata.
    if (!customerId) {
      try {
        const search = await stripe.customers.search({
          query: `metadata['supabase_user_id']:'${user.id}'`,
          limit: 1,
        });
        if (search.data.length) customerId = search.data[0].id;
      } catch { /* search pode não estar indexado ainda */ }
    }
    // Último fallback: por e-mail.
    if (!customerId && user.email) {
      const byEmail = await stripe.customers.list({ email: user.email, limit: 1 });
      if (byEmail.data.length) customerId = byEmail.data[0].id;
    }

    if (!customerId) return json({ found: false });

    // ── Acha o payment method (cartão) anexado ao Customer ───────────────────
    const customer = await stripe.customers.retrieve(customerId) as Stripe.Customer;
    let pmId = (customer.invoice_settings?.default_payment_method as string) ?? '';

    if (!pmId) {
      const pms = await stripe.paymentMethods.list({
        customer: customerId,
        type: 'card',
        limit: 1,
      });
      if (pms.data.length) pmId = pms.data[0].id;
    }

    if (!pmId) return json({ found: false });

    // Garante que esse cartão é o padrão do Customer (para cobranças futuras).
    if (customer.invoice_settings?.default_payment_method !== pmId) {
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: pmId },
      });
    }

    const pm   = await stripe.paymentMethods.retrieve(pmId);
    const card = pm.card;

    // ── Grava no perfil (upsert preservando os campos já existentes) ─────────
    await admin.from('profiles').upsert({
      id:                       user.id,
      full_name:                (p?.full_name as string)  ?? customer.name  ?? '',
      phone:                    (p?.phone as string)      ?? '',
      email:                    (p?.email as string)      ?? customer.email ?? user.email ?? '',
      type:                     (p?.type as string)       ?? 'passenger',
      rating:                   (p?.rating as number)     ?? 5.0,
      total_rides:              (p?.total_rides as number) ?? 0,
      language:                 (p?.language as string)   ?? 'en',
      stripe_customer_id:       customerId,
      stripe_payment_method_id: pmId,
      card_last4:               card?.last4 ?? null,
      card_brand:               card?.brand ?? null,
    }, { onConflict: 'id' });

    return json({
      found:             true,
      payment_method_id: pmId,
      customer_id:       customerId,
      last4:             card?.last4 ?? '',
      brand:             card?.brand ?? '',
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
