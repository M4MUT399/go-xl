// Supabase Edge Function — lista TODOS os cartões salvos do passageiro no Stripe.
//
// Por que isso existe:
//   Até aqui o app só suportava 1 cartão por vez (sync-card usava
//   `limit: 1` ao listar payment methods). O passageiro pediu para poder ver
//   e escolher entre os cartões que já usou. Esta função consulta o Stripe
//   diretamente (fonte da verdade) e devolve a lista completa, marcando qual
//   é o padrão atual (o mesmo que é debitado em charge-ride/tip-ride).
//
// Deploy:  npx supabase functions deploy list-cards
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

    const { data: profile } = await admin
      .from('profiles')
      .select('stripe_customer_id, stripe_payment_method_id')
      .eq('id', user.id)
      .single();

    const p = profile as { stripe_customer_id?: string; stripe_payment_method_id?: string } | null;
    const customerId = p?.stripe_customer_id ?? '';

    if (!customerId) return json({ cards: [] });

    // O customer salvo pode não existir NESTA conta/modo do Stripe (ex.: troca
    // de chave live↔test em testes). Nesse caso devolvemos lista vazia — o app
    // cai no fluxo de adicionar cartão, que recria o customer em setup-card.
    let customer: Stripe.Customer;
    try {
      const c = await stripe.customers.retrieve(customerId);
      if ((c as Stripe.DeletedCustomer).deleted) return json({ cards: [] });
      customer = c as Stripe.Customer;
    } catch {
      return json({ cards: [] });
    }

    const pms = await stripe.paymentMethods.list({
      customer: customerId,
      type: 'card',
      limit: 100,
    });

    // O "padrão" oficial vem do Customer no Stripe — é ele quem
    // charge-ride/tip-ride cobram via profiles.stripe_payment_method_id.
    const defaultId = (customer.invoice_settings?.default_payment_method as string)
      ?? p?.stripe_payment_method_id
      ?? '';

    const cards = pms.data
      .map((pm) => ({
        id: pm.id,
        brand: pm.card?.brand ?? '',
        last4: pm.card?.last4 ?? '',
        expMonth: pm.card?.exp_month ?? null,
        expYear: pm.card?.exp_year ?? null,
        isDefault: pm.id === defaultId,
      }))
      // Cartão padrão sempre primeiro na lista.
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));

    return json({ cards });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
