// Supabase Edge Function — auditoria das faixas de comissão dos motoristas.
// Usada pelo go-xl-admin.
//
// Regra de negócio auditada:
//   Os 100 primeiros motoristas a concluir o onboarding (charges_enabled=true)
//   ficam em 85% (driver_share_percent = 0.850); do 101º em diante, 80% (0.800).
//   A faixa é fixada no onboarding e nunca recalculada (ver migração 0037 e a
//   função assign_driver_tier).
//
// Ações:
//   summary → contagem por faixa + a partir de qual motorista/seq/data começou
//             a faixa de 20% (primeiro motorista com seq >= 101).
//   list    → lista dos motoristas já enquadrados, ordenada por seq.
//
// Acesso restrito a profiles.is_admin = true (checado com service_role).
//
// Deploy:  npx supabase functions deploy admin-commission-tiers

import { createClient } from 'jsr:@supabase/supabase-js@2';

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

/** Limite de motoristas na faixa premium (85%). */
const PREMIUM_TIER_LIMIT = 100;

interface Body {
  action?: 'summary' | 'list';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    // ── Autentica o chamador e confirma que é admin ──────────────────────────
    const authHeader = req.headers.get('Authorization') ?? '';
    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await anonClient.auth.getUser();
    if (authErr || !user) return json({ error: 'Não autorizado' }, 401);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: callerProfile } = await admin
      .from('profiles')
      .select('is_admin')
      .eq('id', user.id)
      .single();

    if (!(callerProfile as { is_admin?: boolean } | null)?.is_admin) {
      return json({ error: 'Acesso restrito à equipe de administração' }, 403);
    }

    const body = (await req.json().catch(() => ({}))) as Body;
    const action = body.action ?? 'summary';

    // ── list: motoristas já enquadrados, por ordem de conclusão ──────────────
    if (action === 'list') {
      const { data, error } = await admin
        .from('profiles')
        .select('id, full_name, email, driver_code, driver_onboarded_seq, driver_share_percent')
        .not('driver_share_percent', 'is', null)
        .order('driver_onboarded_seq', { ascending: true });
      if (error) return json({ error: error.message }, 500);
      return json({ drivers: data });
    }

    // ── summary: contagem por faixa + início da faixa de 20% ─────────────────
    const { count: premiumCount } = await admin
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('driver_share_percent', 0.850);

    const { count: standardCount } = await admin
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('driver_share_percent', 0.800);

    // Primeiro motorista na faixa de 20% (seq >= 101) — marca desde quando/quem
    // a plataforma passou a reter 20%.
    const { data: firstStandard } = await admin
      .from('profiles')
      .select('id, full_name, driver_code, driver_onboarded_seq, created_at')
      .eq('driver_share_percent', 0.800)
      .order('driver_onboarded_seq', { ascending: true })
      .limit(1)
      .maybeSingle();

    return json({
      premiumTier: { sharePercent: 0.85, platformFeePercent: 0.15, limit: PREMIUM_TIER_LIMIT, count: premiumCount ?? 0 },
      standardTier: { sharePercent: 0.80, platformFeePercent: 0.20, count: standardCount ?? 0 },
      standardTierStartedAt: firstStandard ?? null,
      totalOnboarded: (premiumCount ?? 0) + (standardCount ?? 0),
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
