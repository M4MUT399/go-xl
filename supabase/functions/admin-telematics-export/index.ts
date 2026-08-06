// Supabase Edge Function — export mensal de milhagem por período (P1/P2/P3)
// para a seguradora/underwriter (Bloco 2, compliance F.S. 627.748).
//
// Fonte dos dados: driver_period_daily_mileage (rollup diário mutável, NÃO a
// trilha de transições imutável) — decisão já documentada tanto na migration
// 0056 quanto no header de supabase/functions/_shared/telematicsExport.ts.
// A resolução do mês-alvo e a montagem do CSV usam a MESMA função pura
// testada em telematicsExport.ts (resolveExportMonth / buildDailyMileageCsv).
//
// Dois chamadores possíveis, com autenticação diferente:
//
//   1) Admin sob demanda (reexportar um mês específico p/ auditoria): JWT de
//      usuário autenticado com profiles.is_admin=true, header Authorization
//      normal, body opcional { month: 'YYYY-MM' }. Rate-limited e registrado
//      em admin_audit_log (mesmo padrão de admin-waybills).
//
//   2) Cron mensal (migration 0058): chamada de servidor com a service_role
//      key no header Authorization (sem usuário — mesmo padrão de
//      run-weekly-payouts/isServiceRole). Sem `month` no body → usa o mês
//      ANTERIOR completo via resolveExportMonth. Não passa por rate limit
//      (não há admin_id) nem por admin_audit_log (não há ator humano) — cada
//      corrida fica registrada em telematics_export_runs
//      (triggered_by='cron', admin_id=null), a mesma tabela usada pela
//      trilha 'admin'.
//
// Gate: as duas vias exigem a flag period_audit_v1_enabled ligada (mesma
// flag de admin-telematics-claims — ver migration 0057). Para a via cron,
// flag OFF não é erro: apenas pula a execução silenciosamente (a
// pré-criação de partição/purge do Bloco 2 continua rodando de qualquer
// jeito, só o EXPORT em si respeita a flag).
//
// Deploy:  npx supabase functions deploy admin-telematics-export

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { checkAdminRateLimit } from '../_shared/adminRateLimit.ts';
import { isConfigFlagEnabled } from '../_shared/adminConfigFlag.ts';
import { resolveExportMonth, buildDailyMileageCsv, type DailyMileageRow } from '../_shared/telematicsExport.ts';

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

/**
 * Confirma que o token do header Authorization é a service-role key olhando
 * o claim `role` do JWT (mesma técnica de run-weekly-payouts/index.ts) — a
 * assinatura já foi validada pelo gateway do Supabase antes de chegar aqui.
 */
function isServiceRole(token: string): boolean {
  try {
    const payload = token.split('.')[1];
    if (!payload) return false;
    const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')));
    return decoded?.role === 'service_role';
  } catch {
    return false;
  }
}

interface Body {
  month?: string;
  jurisdiction?: string;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const authHeader = req.headers.get('Authorization') ?? '';
    const token = authHeader.replace(/^Bearer\s+/i, '');
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const body = (req.headers.get('content-type')?.includes('application/json')
      ? await req.json().catch(() => ({}))
      : {}) as Body;
    const jurisdiction = body.jurisdiction ?? 'global';

    let triggeredBy: 'cron' | 'admin';
    let adminId: string | null = null;

    // ── Tenta resolver como admin autenticado primeiro ───────────────────────
    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await anonClient.auth.getUser();

    if (user) {
      const { data: callerProfile } = await admin
        .from('profiles')
        .select('is_admin')
        .eq('id', user.id)
        .single();

      if (!(callerProfile as { is_admin?: boolean } | null)?.is_admin) {
        return json({ error: 'Acesso restrito à equipe de administração' }, 403);
      }

      const rateLimit = await checkAdminRateLimit(admin, user.id, 'admin-telematics-export');
      if (!rateLimit.allowed) return json({ error: rateLimit.message }, 429);

      triggeredBy = 'admin';
      adminId = user.id;
    } else if (isServiceRole(token)) {
      triggeredBy = 'cron';
    } else {
      return json({ error: 'Não autorizado' }, 401);
    }

    const flagOn = await isConfigFlagEnabled(admin, 'period_audit_v1_enabled', jurisdiction);
    if (!flagOn) {
      if (triggeredBy === 'cron') {
        // Manutenção de partição/purge (migration 0057) roda independente
        // desta flag; só o EXPORT em si respeita o rollout — pular em
        // silêncio (200, não erro) é o comportamento correto do cron.
        return json({ ok: true, skipped: true, reason: 'period_audit_v1_enabled está desligada' });
      }
      return json({ error: 'Export ainda não habilitado para esta jurisdição (period_audit_v1_enabled)' }, 403);
    }

    const range = resolveExportMonth(new Date(), body.month ?? null);

    const { data: rows, error } = await admin
      .from('driver_period_daily_mileage')
      .select('driver_id, day, p1_miles, p2_miles, p3_miles, estimated_miles')
      .gte('day', range.start)
      .lt('day', range.end)
      .order('driver_id', { ascending: true })
      .order('day', { ascending: true });

    if (error) return json({ error: error.message }, 500);

    const csv = buildDailyMileageCsv((rows ?? []) as DailyMileageRow[]);
    const storagePath = `${range.label}/daily_mileage_${range.label}.csv`;

    const { error: uploadError } = await admin.storage
      .from('telematics-exports')
      .upload(storagePath, new Blob([csv], { type: 'text/csv' }), {
        upsert: true,
        contentType: 'text/csv',
      });

    if (uploadError) return json({ error: uploadError.message }, 500);

    await admin.from('telematics_export_runs').insert({
      month: range.start,
      triggered_by: triggeredBy,
      admin_id: adminId,
      row_count: rows?.length ?? 0,
      storage_path: storagePath,
    });

    if (triggeredBy === 'admin' && adminId) {
      await admin.from('admin_audit_log').insert({
        admin_id: adminId,
        action: 'telematics_export_generated',
        resource: 'driver_period_daily_mileage',
        resource_id: range.label,
        metadata: { month: range.label, rowCount: rows?.length ?? 0, storagePath },
      });
    }

    return json({ ok: true, month: range.label, rowCount: rows?.length ?? 0, storagePath });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
