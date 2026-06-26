// Supabase Edge Function — ações de administração sobre a verificação de
// motoristas (selfie + documento). Usada pelo go-xl-admin.
//
// Por que uma Edge Function e não acesso direto via RLS:
//   Os documentos do motorista (selfie + CNH/ID) ficam num bucket PRIVADO.
//   Em vez de deixar qualquer usuário autenticado do projeto gerar signed
//   URLs ou listar motoristas, tudo passa por aqui: o caller precisa ter
//   profiles.is_admin = true (checado com a service_role, que ignora RLS).
//   Isso evita que um passageiro/motorista comum acesse documentos de outros.
//
// Deploy:  npx supabase functions deploy admin-driver-verification

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

type Action = 'list' | 'get_signed_urls' | 'approve' | 'reject' | 'revoke';

interface Body {
  action: Action;
  driverId?: string;
  reason?: string;
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

    const body = await req.json() as Body;

    // ── Lista todos os motoristas com status de verificação ──────────────────
    if (body.action === 'list') {
      const { data, error } = await admin
        .from('profiles')
        .select(
          'id, full_name, email, phone, driver_code, verification_status, ' +
          'verification_notes, verification_submitted_at, verification_reviewed_at'
        )
        .eq('type', 'driver')
        .order('verification_submitted_at', { ascending: false, nullsFirst: false });

      if (error) return json({ error: error.message }, 500);
      return json({ drivers: data });
    }

    // Demais ações exigem driverId
    if (!body.driverId) return json({ error: 'driverId é obrigatório' }, 400);

    // ── Gera signed URLs de curta duração para ver selfie + documento ────────
    if (body.action === 'get_signed_urls') {
      const { data: driver } = await admin
        .from('profiles')
        .select('verification_selfie_url, verification_document_url')
        .eq('id', body.driverId)
        .single();

      const d = driver as { verification_selfie_url?: string; verification_document_url?: string } | null;
      if (!d) return json({ error: 'Motorista não encontrado' }, 404);

      const urls: { selfie?: string; document?: string } = {};
      if (d.verification_selfie_url) {
        const { data: signed } = await admin.storage
          .from('driver-verification')
          .createSignedUrl(d.verification_selfie_url, 600);
        urls.selfie = signed?.signedUrl;
      }
      if (d.verification_document_url) {
        const { data: signed } = await admin.storage
          .from('driver-verification')
          .createSignedUrl(d.verification_document_url, 600);
        urls.document = signed?.signedUrl;
      }
      return json({ urls });
    }

    // ── Aprova ────────────────────────────────────────────────────────────────
    if (body.action === 'approve') {
      const { error } = await admin.from('profiles').update({
        verification_status: 'approved',
        verification_reviewed_at: new Date().toISOString(),
        verification_reviewed_by: user.id,
        verification_notes: null,
      }).eq('id', body.driverId);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // ── Rejeita (com motivo) ─────────────────────────────────────────────────
    if (body.action === 'reject') {
      const { error } = await admin.from('profiles').update({
        verification_status: 'rejected',
        verification_reviewed_at: new Date().toISOString(),
        verification_reviewed_by: user.id,
        verification_notes: body.reason ?? null,
      }).eq('id', body.driverId);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // ── Revoga aprovação já dada ──────────────────────────────────────────────
    if (body.action === 'revoke') {
      const { error } = await admin.from('profiles').update({
        verification_status: 'revoked',
        verification_reviewed_at: new Date().toISOString(),
        verification_reviewed_by: user.id,
        verification_notes: body.reason ?? null,
      }).eq('id', body.driverId);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: 'Ação inválida' }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
