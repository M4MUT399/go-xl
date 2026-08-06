// Supabase Edge Function — remove um cartão salvo do passageiro.
//
// Por que isso existe:
//   A tela de onboarding de cartão já promete "você pode remover o cartão a
//   qualquer momento no perfil" (AddCardOnboardingScreen), mas não havia
//   nenhuma função de backend para isso. Junto da lista de cartões
//   (list-cards) e da troca de padrão (set-default-card), esta função
//   completa o fluxo de gerenciamento de múltiplos cartões.
//
// Deploy:  npx supabase functions deploy remove-card
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
      .select('stripe_customer_id, stripe_payment_method_id')
      .eq('id', user.id)
      .single();

    const p = profile as { stripe_customer_id?: string; stripe_payment_method_id?: string } | null;
    const customerId = p?.stripe_customer_id ?? '';
    if (!customerId) return json({ error: 'Cliente Stripe não encontrado' }, 404);

    // ── Segurança: só permite remover cartão do próprio customer ────────────
    const pm = await stripe.paymentMethods.retrieve(pmId);
    if (pm.customer !== customerId) {
      return json({ error: 'Este cartão não pertence à sua conta' }, 403);
    }

    await stripe.paymentMethods.detach(pmId);

    const wasDefault = p?.stripe_payment_method_id === pmId;
    if (!wasDefault) {
      return json({ ok: true, newDefault: null });
    }

    // O cartão removido era o padrão — promove outro cartão restante (se
    // houver) para não deixar corridas futuras sem forma de pagamento.
    const remaining = await stripe.paymentMethods.list({
      customer: customerId,
      type: 'card',
      limit: 1,
    });

    if (remaining.data.length) {
      const next = remaining.data[0];
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: next.id },
      });
      await admin.from('profiles').update({
        stripe_payment_method_id: next.id,
        card_last4: next.card?.last4 ?? null,
        card_brand: next.card?.brand ?? null,
      }).eq('id', user.id);

      return json({
        ok: true,
        newDefault: { id: next.id, last4: next.card?.last4 ?? '', brand: next.card?.brand ?? '' },
      });
    }

    // Não sobrou nenhum cartão.
    await admin.from('profiles').update({
      stripe_payment_method_id: null,
      card_last4: null,
      card_brand: null,
    }).eq('id', user.id);

    return json({ ok: true, newDefault: null });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
