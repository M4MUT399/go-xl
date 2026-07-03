// Supabase Edge Function — define qual cartão salvo é o padrão do passageiro.
//
// Por que isso existe:
//   charge-ride e tip-ride cobram sempre `profiles.stripe_payment_method_id`.
//   Para o passageiro poder "escolher qual dos cartões vai usar" (pedido do
//   usuário), o app chama esta função ao tocar num cartão da lista — ela
//   atualiza o default no Customer do Stripe e espelha no perfil.
//
// Deploy:  npx supabase functions deploy set-default-card
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

    const body = await req.json().catch(() => ({})) as { payment_method_id?: string };
    const pmId = body.payment_method_id;
    if (!pmId) return json({ error: 'payment_method_id é obrigatório' }, 400);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: profile } = await admin
      .from('profiles')
      .select('stripe_customer_id')
      .eq('id', user.id)
      .single();

    const p = profile as { stripe_customer_id?: string } | null;
    const customerId = p?.stripe_customer_id ?? '';
    if (!customerId) return json({ error: 'Cliente Stripe não encontrado' }, 404);

    // ── Segurança: o cartão precisa pertencer a ESTE customer, senão qualquer
    // passageiro autenticado poderia tentar setar um payment_method alheio
    // como seu padrão. ────────────────────────────────────────────────────────
    const pm = await stripe.paymentMethods.retrieve(pmId);
    if (pm.customer !== customerId) {
      return json({ error: 'Este cartão não pertence à sua conta' }, 403);
    }

    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: pmId },
    });

    await admin.from('profiles').update({
      stripe_payment_method_id: pmId,
      card_last4: pm.card?.last4 ?? null,
      card_brand: pm.card?.brand ?? null,
    }).eq('id', user.id);

    return json({
      ok: true,
      payment_method_id: pmId,
      last4: pm.card?.last4 ?? '',
      brand: pm.card?.brand ?? '',
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
