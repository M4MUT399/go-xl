// Supabase Edge Function — salva cartão do passageiro via Stripe Checkout (modo setup).
// O passageiro abre a URL no navegador, digita o cartão, e o webhook stripe-webhook
// grava o payment_method_id + card_last4 + card_brand no perfil dele.
//
// Deploy:  npx supabase functions deploy setup-card
// Segredos necessários (já devem estar configurados):
//   STRIPE_SECRET_KEY=sk_...
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY (automáticos)

import Stripe from 'npm:stripe@17';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2025-01-27.acacia',
});

const SUPABASE_URL        = Deno.env.get('SUPABASE_URL')             ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY   = Deno.env.get('SUPABASE_ANON_KEY')         ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

function page(opts: { title: string; subtitle: string; ok: boolean }) {
  const accent = '#C9A84C';
  const navy = '#0A0D1C';
  const ring = opts.ok ? '#22C55E' : '#9CA3AF';
  const mark = opts.ok ? '&#10003;' : '&#10005;';
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Go XL</title>
  <style>
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body {
      background: #FFFFFF;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex; align-items: center; justify-content: center;
      padding: 24px; text-align: center;
    }
    .wrap { max-width: 360px; width: 100%; }
    .logo {
      width: 96px; height: 96px; border-radius: 24px; margin: 0 auto 28px;
      background: ${navy}; color: ${accent};
      display: flex; align-items: center; justify-content: center;
      font-size: 34px; font-weight: 900; letter-spacing: 1px;
      box-shadow: 0 10px 30px rgba(201,168,76,0.25);
    }
    .brand { color: ${accent}; font-size: 15px; font-weight: 800; letter-spacing: 5px; margin-bottom: 28px; }
    .badge {
      width: 64px; height: 64px; border-radius: 50%; margin: 0 auto 22px;
      background: ${ring}; color: #fff; font-size: 34px; font-weight: 900;
      display: flex; align-items: center; justify-content: center;
    }
    h1 { color: ${navy}; font-size: 24px; margin: 0 0 10px; }
    p { color: #6B7280; font-size: 15px; line-height: 1.5; margin: 0; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="logo">GX</div>
    <div class="brand">GO XL</div>
    <div class="badge">${mark}</div>
    <h1>${opts.title}</h1>
    <p>${opts.subtitle}</p>
  </div>
</body>
</html>`;
  return new Response(html, { headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const url  = new URL(req.url);
  const base = `${SUPABASE_URL}/functions/v1/setup-card`;

  // ── Páginas de retorno do Checkout ──────────────────────────────────────────
  if (req.method === 'GET') {
    const status = url.searchParams.get('status');
    if (status === 'success') {
      return page({
        title: 'Cartão confirmado!',
        subtitle: 'Feche esta janela e volte ao app Go XL para solicitar sua viagem.',
        ok: true,
      });
    }
    return page({
      title: 'Cadastro cancelado',
      subtitle: 'Nenhum cartão foi salvo. Você pode tentar novamente no app.',
      ok: false,
    });
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS });
  }

  try {
    // ── Autentica o passageiro via JWT ───────────────────────────────────────
    const authHeader = req.headers.get('Authorization') ?? '';
    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await anonClient.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: 'Não autorizado' }), {
        status: 401, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // ── Busca perfil para pegar stripe_customer_id existente ─────────────────
    const { data: profile } = await admin
      .from('profiles')
      .select('stripe_customer_id, full_name, email')
      .eq('id', user.id)
      .single();

    const p = profile as { stripe_customer_id?: string; full_name?: string; email?: string } | null;

    // ── Cria Customer no Stripe se ainda não existe ──────────────────────────
    let customerId = p?.stripe_customer_id ?? '';
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: p?.email ?? user.email ?? '',
        name:  p?.full_name ?? '',
        metadata: { supabase_user_id: user.id },
      });
      customerId = customer.id;

      // Persiste o customer_id. Se o perfil já existe, só atualiza o campo
      // (preservando o resto). Se NÃO existe — caso de cadastro incompleto —,
      // cria uma linha mínima via upsert para não perder o vínculo com o Stripe.
      if (p) {
        await admin.from('profiles').update({ stripe_customer_id: customerId }).eq('id', user.id);
      } else {
        await admin.from('profiles').upsert({
          id:                 user.id,
          full_name:          (user.user_metadata?.full_name as string) ?? '',
          phone:              '',
          email:              user.email ?? '',
          type:               'passenger',
          rating:             5.0,
          total_rides:        0,
          language:           'en',
          stripe_customer_id: customerId,
        }, { onConflict: 'id' });
      }
    }

    // ── Cria Checkout Session em modo setup ──────────────────────────────────
    const session = await stripe.checkout.sessions.create({
      mode: 'setup',
      customer: customerId,
      currency: 'usd',
      metadata: { passenger_id: user.id },
      success_url: `${base}?status=success`,
      cancel_url:  `${base}?status=cancel`,
    });

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});
