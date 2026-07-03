// Supabase Edge Function — consulta o status da conta Stripe Connect do motorista.
//
// Por que isso existe:
//   Depois do onboarding (connect-onboard-driver) o app precisa saber se a
//   conta conectada já pode receber repasses. Esta função consulta o Stripe
//   (fonte da verdade), espelha os flags no perfil e devolve o status para a
//   UI decidir se habilita o botão "Solicitar repasse".
//
// Retorno:
//   { hasAccount, onboardingComplete, payoutsEnabled, chargesEnabled,
//     needsAttention, disabledReason }
//
// Deploy:  npx supabase functions deploy connect-account-status
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

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: profile } = await admin
      .from('profiles')
      .select('stripe_account_id')
      .eq('id', user.id)
      .single();

    const accountId = (profile as { stripe_account_id?: string } | null)?.stripe_account_id ?? '';

    // Sem conta ainda — motorista nunca iniciou o onboarding.
    if (!accountId) {
      return json({
        hasAccount: false,
        onboardingComplete: false,
        payoutsEnabled: false,
        chargesEnabled: false,
        needsAttention: false,
        disabledReason: null,
      });
    }

    const account = await stripe.accounts.retrieve(accountId);

    const onboardingComplete = !!account.details_submitted;
    const payoutsEnabled = !!account.payouts_enabled;
    const chargesEnabled = !!account.charges_enabled;
    const disabledReason = account.requirements?.disabled_reason ?? null;
    // Pendências que ainda travam a conta (documentos, dados bancários, etc.).
    const dueNow = account.requirements?.currently_due ?? [];
    const needsAttention = onboardingComplete && (!payoutsEnabled || dueNow.length > 0);

    // Espelha no perfil para consultas rápidas sem bater no Stripe toda vez.
    await admin.from('profiles').update({
      stripe_onboarding_complete: onboardingComplete,
      stripe_payouts_enabled: payoutsEnabled,
    }).eq('id', user.id);

    return json({
      hasAccount: true,
      onboardingComplete,
      payoutsEnabled,
      chargesEnabled,
      needsAttention,
      disabledReason,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
