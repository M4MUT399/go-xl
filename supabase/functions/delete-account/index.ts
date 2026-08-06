// Supabase Edge Function — exclusão de conta (Apple Guideline 5.1.1(v)).
//
// Por que anonimizar em vez de DELETE direto na linha de profiles:
//   rides.passenger_id, messages.sender_id, ratings.from_user/to_user e
//   payouts.driver_id são NOT NULL com regra de exclusão NO ACTION — ou seja,
//   apagar a linha de profiles falharia (violação de FK) para qualquer usuário
//   que já tenha feito ao menos uma corrida, e mesmo que não falhasse,
//   cascatear o DELETE até essas tabelas destruiria o histórico da OUTRA
//   parte (o passageiro/motorista do outro lado da corrida).
//
//   Por isso a exclusão de conta aqui segue o padrão usado por apps como
//   Uber/Lyft: os dados pessoais são apagados/anonimizados de forma
//   permanente e o login é destruído (supabase.auth.admin.deleteUser) — a
//   conta deixa de existir e de ser acessível, mas o histórico de corridas
//   da contraparte permanece íntegro, sem nenhuma informação identificável
//   do usuário excluído.
//
// Deploy:  npx supabase functions deploy delete-account

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

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    // ── Autentica o usuário a partir do próprio token — só pode excluir a si mesmo ──
    const authHeader = req.headers.get('Authorization') ?? '';
    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await anonClient.auth.getUser();
    if (authErr || !user) return json({ error: 'Não autorizado' }, 401);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const userId = user.id;

    // ── Remove arquivos pessoais do storage (fotos de perfil e documentos) ──────
    for (const bucket of ['avatars', 'driver-verification'] as const) {
      const { data: files } = await admin.storage.from(bucket).list(userId);
      if (files?.length) {
        await admin.storage.from(bucket).remove(files.map((f) => `${userId}/${f.name}`));
      }
    }

    // ── Remove dados exclusivamente do usuário (sem impacto em outras pessoas) ──
    await admin.from('vehicles').delete().eq('driver_id', userId);
    await admin.from('driver_locations').delete().eq('driver_id', userId);

    // ── Anonimiza o perfil — preserva o histórico de corridas da contraparte,
    //    mas remove toda informação que identifique este usuário ──────────────
    await admin.from('profiles').update({
      full_name:                  'Usuário excluído',
      phone:                      '',
      email:                      `deleted-${userId}@goxl.deleted`,
      avatar_url:                 null,
      push_token:                 null,
      driver_code:                null,
      emergency_contact_name:     null,
      emergency_contact_phone:    null,
      stripe_customer_id:         null,
      stripe_payment_method_id:  null,
      card_last4:                 null,
      card_brand:                 null,
      verification_selfie_url:    null,
      verification_document_url:  null,
    }).eq('id', userId);

    // ── Destrói o login — a conta deixa de existir e de ser acessível ───────────
    const { error: delErr } = await admin.auth.admin.deleteUser(userId);
    if (delErr) return json({ error: delErr.message }, 500);

    return json({ ok: true });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
