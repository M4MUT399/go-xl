// Supabase Edge Function — cria/continua o onboarding Stripe Connect Express do motorista.
//
// Por que isso existe:
//   O repasse ao motorista (request-payout) faz um `transfers.create` para a
//   conta conectada do motorista. Para existir uma conta conectada, o motorista
//   precisa passar pelo onboarding Express (dados pessoais + conta bancária).
//   Esta função cria a conta Express (se ainda não existir) e devolve uma URL
//   de Account Link que o app abre no navegador — mesmo padrão do setup-card.
//
// Fluxo no app (EarningsScreen):
//   POST → { url } → WebBrowser.openBrowserAsync(url) → volta → connect-account-status
//
// Deploy:  npx supabase functions deploy connect-onboard-driver
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
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

// Página simples de retorno do Account Link (sucesso ou "refresh"/expirado).
function page(opts: { title: string; subtitle: string; ok: boolean }) {
  const accent = '#C9A84C';
  const navy = '#0A0D1C';
  const ring = opts.ok ? '#22C55E' : '#9CA3AF';
  const mark = opts.ok ? '&#10003;' : '&#8635;';
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

  const url = new URL(req.url);

  // ── Páginas de retorno do Account Link ──────────────────────────────────────
  if (req.method === 'GET') {
    const status = url.searchParams.get('status');
    if (status === 'return') {
      return page({
        title: 'Cadastro recebido!',
        subtitle: 'Feche esta janela e volte ao app Go XL para conferir o status do seu repasse.',
        ok: true,
      });
    }
    // status === 'refresh' → link expirou/incompleto; o app gera outro
    return page({
      title: 'Link expirado',
      subtitle: 'Volte ao app Go XL e toque novamente em "Configurar repasse" para continuar.',
      ok: false,
    });
  }

  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await anonClient.auth.getUser();
    if (authErr || !user) return json({ error: 'Não autorizado' }, 401);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: profile } = await admin
      .from('profiles')
      .select('stripe_account_id, type, full_name, email')
      .eq('id', user.id)
      .single();

    const p = profile as {
      stripe_account_id?: string; type?: string; full_name?: string; email?: string;
    } | null;

    // Só motoristas recebem repasse — evita passageiro criar conta conectada à toa.
    if (p?.type !== 'driver') {
      return json({ error: 'Apenas motoristas podem configurar repasse' }, 403);
    }

    // ── Cria a conta Express se ainda não existe ──────────────────────────────
    let accountId = p?.stripe_account_id ?? '';
    if (!accountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: 'US',
        email: p?.email ?? user.email ?? undefined,
        business_type: 'individual',
        capabilities: { transfers: { requested: true } },
        metadata: { supabase_user_id: user.id },
      });
      accountId = account.id;
      await admin.from('profiles').update({ stripe_account_id: accountId }).eq('id', user.id);
    }

    // ── Account Link de onboarding ────────────────────────────────────────────
    const base = `${SUPABASE_URL}/functions/v1/connect-onboard-driver`;
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${base}?status=refresh`,
      return_url:  `${base}?status=return`,
      type: 'account_onboarding',
    });

    return json({ url: link.url, account_id: accountId });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
