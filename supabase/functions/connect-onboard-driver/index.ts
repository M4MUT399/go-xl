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

// URL pública HTTPS desta própria função — alvo do Account Link do Stripe.
//
// Por que NÃO usamos o deep link do app (goxl://) direto no return_url/refresh_url:
// o Stripe finaliza o onboarding com um redirect 302 do navegador para essas URLs.
// No Android, o Chrome Custom Tabs NÃO consegue seguir um 302 para um esquema
// desconhecido (goxl://) e mostra "Invalid URL" — exatamente o erro relatado. No
// iOS o ASWebAuthenticationSession trata o esquema e por isso "funcionava" só lá.
// Solução: o Stripe volta para esta página HTTPS (que o Custom Tabs abre sem
// problema) e ELA rebota para goxl:// via JS no cliente (permitido como Intent
// Android / handler de esquema iOS), fechando o navegador automaticamente.
const FN_RETURN_BASE = `${SUPABASE_URL}/functions/v1/connect-onboard-driver`;
const APP_RETURN_SCHEME = 'goxl://payout-return';

// Logo GoXL embutido em base64 (evita depender de asset externo na página de retorno).
const LOGO_B64 = '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';

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
//
// Além do texto, ela rebota SOZINHA para o app via `appLink` (goxl://…). Esse
// salto client-side é o que o Chrome Custom Tabs do Android aceita (vira um
// Intent) — diferente do redirect 302 do Stripe direto para goxl://, que falha.
// O `openAuthSessionAsync` do app detecta o goxl:// e fecha o navegador sozinho.
function page(opts: { title: string; subtitle: string; ok: boolean; appLink: string }) {
  const accent = '#C9A84C';
  const navy = '#0A0D1C';
  const ring = opts.ok ? '#22C55E' : '#9CA3AF';
  const mark = opts.ok ? '&#10003;' : '&#8635;';
  const appLinkJs = JSON.stringify(opts.appLink);
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="0;url=${opts.appLink}" />
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
      overflow: hidden; background: ${navy};
      box-shadow: 0 10px 30px rgba(201,168,76,0.25);
    }
    .logo img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .brand { color: ${accent}; font-size: 15px; font-weight: 800; letter-spacing: 5px; margin-bottom: 28px; }
    .badge {
      width: 64px; height: 64px; border-radius: 50%; margin: 0 auto 22px;
      background: ${ring}; color: #fff; font-size: 34px; font-weight: 900;
      display: flex; align-items: center; justify-content: center;
    }
    h1 { color: ${navy}; font-size: 24px; margin: 0 0 10px; }
    p { color: #6B7280; font-size: 15px; line-height: 1.5; margin: 0 0 24px; }
    .btn {
      display: inline-block; background: ${navy}; color: ${accent};
      font-size: 15px; font-weight: 800; letter-spacing: 1px;
      text-decoration: none; padding: 14px 26px; border-radius: 12px;
    }
  </style>
  <script>
    // Rebota para o app assim que a página carrega. Client-side (não 302), então
    // o Chrome Custom Tabs do Android trata como Intent e abre o app; o iOS trata
    // o esquema. O openAuthSessionAsync detecta goxl:// e fecha o navegador.
    (function () {
      try { window.location.href = ${appLinkJs}; } catch (e) {}
    })();
  </script>
</head>
<body>
  <div class="wrap">
    <div class="logo"><img src="data:image/png;base64,${LOGO_B64}" alt="Go XL" /></div>
    <div class="brand">GO XL</div>
    <div class="badge">${mark}</div>
    <h1>${opts.title}</h1>
    <p>${opts.subtitle}</p>
    <a class="btn" href="${opts.appLink}">Voltar ao app Go XL</a>
  </div>
</body>
</html>`;
  return new Response(html, { headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const url = new URL(req.url);

  // ── Páginas de retorno do Account Link (alvo HTTPS do Stripe → rebota ao app) ──
  if (req.method === 'GET') {
    const status = url.searchParams.get('status') === 'return' ? 'return' : 'refresh';
    const appLink = `${APP_RETURN_SCHEME}?status=${status}`;
    if (status === 'return') {
      return page({
        title: 'Cadastro recebido!',
        subtitle: 'Voltando ao app Go XL para conferir o status do seu repasse…',
        ok: true,
        appLink,
      });
    }
    // status === 'refresh' → link expirou/incompleto; o app gera outro
    return page({
      title: 'Link expirado',
      subtitle: 'Volte ao app Go XL e toque novamente em "Configurar repasse" para continuar.',
      appLink,
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
    // refresh_url/return_url apontam para a página HTTPS DESTA função (GET acima),
    // NÃO para o deep link do app. O Stripe exige URLs http(s) e finaliza com um
    // redirect 302 do navegador — que o Chrome Custom Tabs do Android só segue se
    // for http(s) (um goxl:// direto quebra com "Invalid URL"). A página HTTPS
    // então rebota para goxl://payout-return via JS, e o openAuthSessionAsync
    // fecha o navegador sozinho ao detectar o esquema.
    const link = await stripe.accountLinks.create({
      account: accountId,
      refresh_url: `${FN_RETURN_BASE}?status=refresh`,
      return_url:  `${FN_RETURN_BASE}?status=return`,
      type: 'account_onboarding',
    });

    return json({ url: link.url, account_id: accountId });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
