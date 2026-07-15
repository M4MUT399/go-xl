// Supabase Edge Function — claims lookup administrativo (Bloco 2, compliance
// F.S. 627.748): "que período P0-P3 estava vigente para este motorista num
// dado instante (ou ao longo desta corrida)". É a pergunta central que a
// seguradora/underwriter faz ao processar uma reivindicação de sinistro.
//
// Requisito do COMANDO: resposta em <5s. A tabela driver_period_transitions
// (migration 0056/0057) já tem os índices certos para isso:
//   - driver_period_transitions_claims_lookup_idx (driver_id, at_ms)
//   - driver_period_transitions_trip_idx (trip_id)
// então cada lookup é um index scan direto, não uma varredura.
//
// A DECISÃO de "qual transição estava vigente" (limite inclusivo, nunca
// presumir P0 quando não há dado) usa a MESMA função pura testada em
// supabase/functions/_shared/telematicsExport.ts — uma fonte de verdade só
// para essa regra, compartilhada com o harness de teste Node.
//
// Duas formas de consulta (ambas reais em fluxos de sinistro de seguradora,
// ver docs/telematics-spec.md):
//   - action 'lookupByTimestamp': driverId + atMs → qual período vigorava.
//   - action 'lookupByTrip': tripId → a sequência completa de transições
//     registradas PARA aquela corrida específica (dispatch → pickup →
//     drop-off), útil quando o sinistro já está associado a uma corrida.
//
// Gate: exige a flag period_audit_v1_enabled (Bloco 2) ligada — enquanto OFF,
// a Edge Function responde 403 mesmo para admin, para não expor o endpoint
// antes do rollout da funcionalidade ser aprovado por jurisdição.
//
// Deploy:  npx supabase functions deploy admin-telematics-claims

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { checkAdminRateLimit } from '../_shared/adminRateLimit.ts';
import { findActivePeriodAtTimestamp, type PeriodTransitionRow } from '../_shared/telematicsExport.ts';
import { isConfigFlagEnabled } from '../_shared/adminConfigFlag.ts';

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

type Action = 'lookupByTimestamp' | 'lookupByTrip';

interface Body {
  action: Action;
  driverId?: string;
  atMs?: number;
  tripId?: string;
  jurisdiction?: string;
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

    const rateLimit = await checkAdminRateLimit(admin, user.id, 'admin-telematics-claims');
    if (!rateLimit.allowed) return json({ error: rateLimit.message }, 429);

    const body = await req.json() as Body;
    const jurisdiction = body.jurisdiction ?? 'global';

    const flagOn = await isConfigFlagEnabled(admin, 'period_audit_v1_enabled', jurisdiction);
    if (!flagOn) {
      return json({ error: 'Claims lookup ainda não habilitado para esta jurisdição (period_audit_v1_enabled)' }, 403);
    }

    // ── lookupByTimestamp: qual período vigorava para driverId em atMs ───────
    if (body.action === 'lookupByTimestamp') {
      if (!body.driverId) return json({ error: 'driverId é obrigatório' }, 400);
      if (typeof body.atMs !== 'number' || !Number.isFinite(body.atMs)) {
        return json({ error: 'atMs (epoch ms) é obrigatório' }, 400);
      }

      // O índice (driver_id, at_ms) já entrega a transição vigente numa única
      // linha via order+limit — buscamos algumas a mais (não só 1) para
      // proteger contra timestamps de dispositivo empatados/fora de ordem e
      // deixar a decisão final para a função pura testada, em vez de confiar
      // cegamente no LIMIT do banco para a regra de negócio.
      const { data, error } = await admin
        .from('driver_period_transitions')
        .select('id, driver_id, trip_id, from_period, to_period, reason, at_ms, lat, lng, cumulative_miles_at_transition, mileage_estimated')
        .eq('driver_id', body.driverId)
        .lte('at_ms', body.atMs)
        .order('at_ms', { ascending: false })
        .limit(10);

      if (error) return json({ error: error.message }, 500);

      const active = findActivePeriodAtTimestamp((data ?? []) as PeriodTransitionRow[], body.atMs);

      await admin.from('admin_audit_log').insert({
        admin_id: user.id,
        action: 'telematics_claims_lookup_by_timestamp',
        resource: 'driver_period_transitions',
        resource_id: body.driverId,
        metadata: { atMs: body.atMs, found: active !== null },
      });

      return json({ activePeriod: active });
    }

    // ── lookupByTrip: sequência completa de transições de UMA corrida ───────
    if (body.action === 'lookupByTrip') {
      if (!body.tripId) return json({ error: 'tripId é obrigatório' }, 400);

      const { data, error } = await admin
        .from('driver_period_transitions')
        .select('id, driver_id, trip_id, from_period, to_period, reason, at_ms, lat, lng, cumulative_miles_at_transition, mileage_estimated')
        .eq('trip_id', body.tripId)
        .order('at_ms', { ascending: true });

      if (error) return json({ error: error.message }, 500);

      await admin.from('admin_audit_log').insert({
        admin_id: user.id,
        action: 'telematics_claims_lookup_by_trip',
        resource: 'driver_period_transitions',
        resource_id: body.tripId,
        metadata: { resultCount: data?.length ?? 0 },
      });

      return json({ transitions: data ?? [] });
    }

    return json({ error: 'Ação inválida' }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
