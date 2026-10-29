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
      .select('stripe_account_id, driver_share_percent')
      .eq('id', user.id)
      .single();

    const p = profile as {
      stripe_account_id?: string;
      driver_share_percent?: number | null;
    } | null;
    const accountId = p?.stripe_account_id ?? '';

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

    // ─────────────────────────────────────────────────────────────────────────
    // A FAIXA VEM ANTES DE HABILITAR — a ordem é a correção, não um detalhe
    // ─────────────────────────────────────────────────────────────────────────
    // Esta função é a MESMA porta que o `stripe-webhook` (:604-647), e por muito
    // tempo foi a porta desprotegida: ela escrevia `stripe_charges_enabled =
    // true` primeiro e só depois chamava `assign_driver_tier`, DESCARTANDO o
    // erro. O webhook podia recusar corretamente um motorista sem faixa e o
    // próximo `useConnectAccount` (src/hooks/useConnectAccount.ts:43, que roda a
    // cada abertura do app do motorista) o habilitava assim mesmo.
    //
    // O estrago não aparece em tela nenhuma: com `driver_share_percent` NULL, as
    // duas implementações do split coagem para 0.80 (src/lib/split.ts:78-82 e
    // 0065:716-717). Um motorista da faixa 85/15 roda semanas a 80/20 e a
    // diferença some sem deixar rastro.
    //
    // Só exigimos a RPC quando ela AINDA TEM TRABALHO — mesma razão do webhook:
    // com a faixa já atribuída, uma falha transitória não pode travar a
    // atualização, que também carrega DESABILITAÇÕES (e essas precisam passar
    // para tirar o motorista do ar).
    const needsTier = chargesEnabled && (p?.driver_share_percent ?? null) === null;

    let driverSharePercent: number | null = p?.driver_share_percent ?? null;

    if (needsTier) {
      // Idempotente e race-safe por construção (0065:1497-1500): com faixa já
      // atribuída devolve o valor e não recalcula. 85% para os 100 primeiros a
      // concluir o onboarding; 80% do 101º em diante.
      const { data: share, error: tierErr } = await admin.rpc('assign_driver_tier', {
        p_driver: user.id,
      });

      if (tierErr) {
        console.error('connect-account-status: assign_driver_tier FALHOU — motorista NÃO habilitado', {
          driverId: user.id, account: accountId, error: tierErr.message,
        });

        // NÃO grava `stripe_charges_enabled`. Deixar de habilitar atrasa o
        // motorista; habilitar sem faixa o paga errado em toda corrida até
        // alguém perceber. O app repete esta chamada na próxima abertura, e a
        // RPC é idempotente — o caminho normal se conserta sozinho.
        return json({
          hasAccount: true,
          onboardingComplete,
          payoutsEnabled,
          chargesEnabled: false,
          needsAttention: true,
          disabledReason,
          driverSharePercent: null,
          code: 'assign_tier_failed',
        }, 503);
      }

      driverSharePercent = share as number | null;
    }

    // Espelha no perfil para consultas rápidas sem bater no Stripe toda vez.
    await admin.from('profiles').update({
      stripe_onboarding_complete: onboardingComplete,
      stripe_payouts_enabled: payoutsEnabled,
      stripe_charges_enabled: chargesEnabled,
    }).eq('id', user.id);

    return json({
      hasAccount: true,
      onboardingComplete,
      payoutsEnabled,
      chargesEnabled,
      needsAttention,
      disabledReason,
      driverSharePercent,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
