// Supabase Edge Function — busca administrativa de waybills (P4/#5).
//
// Por que uma Edge Function e não SELECT direto via RLS:
//   A RLS de public.waybills já permite que um admin (profiles.is_admin) leia
//   todas as linhas — mas a busca administrativa (por ride/motorista/
//   passageiro/data) precisa ficar registrada em public.admin_audit_log para
//   compliance ("quem consultou o recibo de qual corrida e quando"), e a
//   escrita nessa tabela de auditoria só é permitida via service_role (para
//   não poder ser forjada/apagada a partir do painel). Por isso o fluxo passa
//   por aqui em vez de ir direto do cliente ao Supabase.
//
// Deploy:  npx supabase functions deploy admin-waybills

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

type Action = 'search' | 'get';

interface Body {
  action: Action;
  id?: string;
  rideId?: string;
  driverQuery?: string;
  passengerQuery?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
  offset?: number;
}

const MAX_LIMIT = 100;

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

    // ── Busca um waybill específico ──────────────────────────────────────────
    if (body.action === 'get') {
      if (!body.id) return json({ error: 'id é obrigatório' }, 400);

      const { data, error } = await admin
        .from('waybills')
        .select('*')
        .eq('id', body.id)
        .single();

      if (error || !data) return json({ error: 'Waybill não encontrado' }, 404);

      await admin.from('admin_audit_log').insert({
        admin_id: user.id,
        action: 'waybill_get',
        resource: 'waybills',
        resource_id: body.id,
      });

      return json({ waybill: data });
    }

    // ── Busca administrativa (filtros combináveis) ───────────────────────────
    if (body.action === 'search') {
      const limit = Math.min(body.limit ?? 50, MAX_LIMIT);
      const offset = Math.max(body.offset ?? 0, 0);

      let query = admin
        .from('waybills')
        .select('*', { count: 'exact' })
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (body.rideId) query = query.eq('ride_id', body.rideId);
      if (body.driverQuery) query = query.ilike('driver_name', `%${body.driverQuery}%`);
      if (body.passengerQuery) query = query.ilike('passenger_name', `%${body.passengerQuery}%`);
      if (body.dateFrom) query = query.gte('created_at', body.dateFrom);
      if (body.dateTo) query = query.lte('created_at', body.dateTo);

      const { data, error, count } = await query;
      if (error) return json({ error: error.message }, 500);

      await admin.from('admin_audit_log').insert({
        admin_id: user.id,
        action: 'waybill_search',
        resource: 'waybills',
        metadata: {
          rideId: body.rideId ?? null,
          driverQuery: body.driverQuery ?? null,
          passengerQuery: body.passengerQuery ?? null,
          dateFrom: body.dateFrom ?? null,
          dateTo: body.dateTo ?? null,
          resultCount: data?.length ?? 0,
        },
      });

      return json({ waybills: data, total: count ?? data?.length ?? 0 });
    }

    return json({ error: 'Ação inválida' }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
