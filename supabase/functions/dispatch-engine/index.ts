// Edge Function — ORQUESTRADOR do Dispatch Engine v2 (PR-b).
//
// O servidor é a FONTE DA VERDADE da distribuição estilo Uber. Esta função
// carrega o estado vivo das tabelas (`trip_requests` + `ride_offers`), roda o
// NÚCLEO PURO (`_shared/dispatchEngine.ts`, que re-exporta src/lib) para decidir
// as transições, e persiste o diff — inserindo novas ofertas, expirando as
// vencidas e revogando as stale. Os apps reagem ao realtime de `ride_offers`
// (INSERT PENDING → card; UPDATE REVOKED/EXPIRED/ACCEPTED → some), com um push
// best-effort por cima para o caso de background.
//
// A flag `dispatch_engine_v2` (system_config, global) porteia TUDO: enquanto OFF
// a função responde { skipped: true } sem escrever nada — o fluxo legado (leque
// via send-ride-push) segue intacto. Rollout gradual por jurisdição.
//
// Ações (POST { action, ... } + JWT do usuário):
//   create  { rideId }                      → cria o pedido e faz o 1º match.
//   accept  { tripRequestId }               → aceite atômico (RPC) + redispatch.
//   reject  { tripRequestId }               → recusa e promove o próximo.
//   cancel  { tripRequestId }               → passageiro cancela.
//   tick    { }                             → expira/expande/timeout + reconcile.
//
// Deploy:  npx supabase functions deploy dispatch-engine --no-verify-jwt

import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  createEngine,
  reconcile,
  reject as engineReject,
  tick as engineTick,
  haversineKm,
  DISPATCH_DEFAULTS,
  type DispatchConfig,
  type DispatchMode,
  type DriverPosition,
  type EngineState,
  type TripRequest,
} from '../_shared/dispatchEngine.ts';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')         ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const BUSY_STATUSES = ['accepted', 'driver_en_route', 'in_progress'];
const ACTIVE_DISPATCH = ['REQUESTED', 'MATCHING', 'OFFERING'];

function makeAdmin() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
}
type Admin = ReturnType<typeof makeAdmin>;

// ─── Config dinâmica (system_config → fallback local) ────────────────────────
async function loadConfig(admin: Admin): Promise<{ enabled: boolean; config: DispatchConfig }> {
  const keys = [
    'dispatch_engine_v2',
    'dispatch_offer_ttl_seconds',
    'dispatch_mode',
    'dispatch_radius_initial_km',
    'dispatch_radius_step_km',
    'dispatch_radius_max_km',
    'dispatch_global_timeout_seconds',
  ];
  const { data } = await admin
    .from('system_config')
    .select('key, value')
    .eq('jurisdiction', 'global')
    .in('key', keys);
  const map = new Map<string, unknown>();
  for (const r of (data as { key: string; value: unknown }[] | null) ?? []) map.set(r.key, r.value);
  const num = (k: string, d: number) => (typeof map.get(k) === 'number' ? (map.get(k) as number) : d);

  return {
    enabled: map.get('dispatch_engine_v2') === true,
    config: {
      offerTtlMs: num('dispatch_offer_ttl_seconds', 15) * 1000,
      dispatchMode: (map.get('dispatch_mode') === 'broadcast' ? 'broadcast' : 'sequential') as DispatchMode,
      radiusInitialKm: num('dispatch_radius_initial_km', DISPATCH_DEFAULTS.radiusInitialKm),
      radiusStepKm: num('dispatch_radius_step_km', DISPATCH_DEFAULTS.radiusStepKm),
      radiusMaxKm: num('dispatch_radius_max_km', DISPATCH_DEFAULTS.radiusMaxKm),
      globalTimeoutMs: num('dispatch_global_timeout_seconds', 300) * 1000,
      avgSpeedKmPerMin: DISPATCH_DEFAULTS.avgSpeedKmPerMin,
    },
  };
}

// ─── Carregamento do pool de motoristas ──────────────────────────────────────
async function loadPool(admin: Admin): Promise<DriverPosition[]> {
  const { data: online } = await admin
    .from('driver_locations')
    .select('driver_id, lat, lng')
    .eq('is_online', true);
  const rows = (online as { driver_id: string; lat: number; lng: number }[] | null) ?? [];
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.driver_id);
  const { data: busyRows } = await admin
    .from('rides')
    .select('driver_id')
    .in('driver_id', ids)
    .in('status', BUSY_STATUSES);
  const busy = new Set(((busyRows as { driver_id: string }[] | null) ?? []).map((b) => b.driver_id));

  return rows.map((r) => ({
    driverId: r.driver_id,
    lat: r.lat,
    lng: r.lng,
    busy: busy.has(r.driver_id),
  }));
}

// ─── Carregamento do estado vivo (tabelas = fonte da verdade) ────────────────
type ReqRow = {
  id: string; ride_id: string | null; passenger_id: string;
  pickup_lat: number; pickup_lng: number; status: string;
  dispatch_mode: string; radius_km: number; accepted_by: string | null; created_at: string;
};

async function loadState(admin: Admin, config: DispatchConfig): Promise<EngineState> {
  const { data: reqs } = await admin
    .from('trip_requests')
    .select('id, ride_id, passenger_id, pickup_lat, pickup_lng, status, dispatch_mode, radius_km, accepted_by, created_at')
    .in('status', ACTIVE_DISPATCH)
    .order('created_at', { ascending: true });
  const reqRows = (reqs as ReqRow[] | null) ?? [];
  const state = createEngine(config);
  if (reqRows.length === 0) return state;

  const { data: offers } = await admin
    .from('ride_offers')
    .select('trip_request_id, driver_id, status, expires_at')
    .in('trip_request_id', reqRows.map((r) => r.id));
  const offerRows = (offers as { trip_request_id: string; driver_id: string; status: string; expires_at: string }[] | null) ?? [];

  const pendingByReq = new Map<string, { driverId: string; expiresAt: number }[]>();
  const offeredByReq = new Map<string, string[]>();
  for (const o of offerRows) {
    if (!offeredByReq.has(o.trip_request_id)) offeredByReq.set(o.trip_request_id, []);
    offeredByReq.get(o.trip_request_id)!.push(o.driver_id);
    if (o.status === 'PENDING') {
      if (!pendingByReq.has(o.trip_request_id)) pendingByReq.set(o.trip_request_id, []);
      pendingByReq.get(o.trip_request_id)!.push({ driverId: o.driver_id, expiresAt: new Date(o.expires_at).getTime() });
    }
  }

  const requests: TripRequest[] = reqRows.map((r) => ({
    id: r.id,
    status: r.status as TripRequest['status'],
    pickup: { lat: r.pickup_lat, lng: r.pickup_lng },
    createdAt: new Date(r.created_at).getTime(),
    radiusKm: Number(r.radius_km),
    offeredTo: offeredByReq.get(r.id) ?? [],
    offers: pendingByReq.get(r.id) ?? [],
    acceptedBy: r.accepted_by,
  }));
  return { ...state, requests };
}

// ─── Persistência do diff + notificação ──────────────────────────────────────
async function persistDiff(
  admin: Admin,
  before: EngineState,
  after: EngineState,
  pool: DriverPosition[],
  now: number
): Promise<string[]> {
  const poolById = new Map(pool.map((d) => [d.driverId, d]));
  const prevById = new Map(before.requests.map((r) => [r.id, r]));
  const newlyOffered: string[] = [];

  for (const req of after.requests) {
    const prev = prevById.get(req.id);
    // Atualiza status/raio do pedido se mudou.
    if (!prev || prev.status !== req.status || prev.radiusKm !== req.radiusKm) {
      await admin.from('trip_requests').update({ status: req.status, radius_km: req.radiusKm }).eq('id', req.id);
      if (req.status === 'NO_DRIVERS') {
        await admin.from('dispatch_events').insert({ trip_request_id: req.id, event: 'NO_DRIVERS' });
      }
    }

    const prevPending = new Set((prev?.offers ?? []).map((o) => o.driverId));
    const enginePending = new Set(req.offers.map((o) => o.driverId));

    // Novas ofertas → insere PENDING + evento + alvo de push.
    for (const o of req.offers) {
      if (prevPending.has(o.driverId)) continue;
      const d = poolById.get(o.driverId);
      const distanceKm = d ? haversineKm(req.pickup, { lat: d.lat, lng: d.lng }) : null;
      await admin.from('ride_offers').upsert({
        trip_request_id: req.id,
        driver_id: o.driverId,
        status: 'PENDING',
        eta_min: d?.etaMinOverride ?? (distanceKm != null ? distanceKm / DISPATCH_DEFAULTS.avgSpeedKmPerMin : null),
        distance_km: distanceKm,
        offered_at: new Date(now).toISOString(),
        expires_at: new Date(o.expiresAt).toISOString(),
        resolved_at: null,
      }, { onConflict: 'trip_request_id,driver_id' });
      await admin.from('dispatch_events').insert({ trip_request_id: req.id, driver_id: o.driverId, event: 'OFFERED' });
      newlyOffered.push(o.driverId);
    }

    // Ofertas que o motor derrubou (expiraram no tick) → marca EXPIRED.
    for (const id of prevPending) {
      if (enginePending.has(id)) continue;
      await admin.from('ride_offers').update({ status: 'EXPIRED', resolved_at: new Date(now).toISOString() })
        .eq('trip_request_id', req.id).eq('driver_id', id).eq('status', 'PENDING');
      await admin.from('dispatch_events').insert({ trip_request_id: req.id, driver_id: id, event: 'EXPIRED' });
    }
  }
  return newlyOffered;
}

async function pushOffered(admin: Admin, rideId: string | null, driverIds: string[]) {
  if (!rideId || driverIds.length === 0) return;
  try {
    await admin.functions.invoke('send-ride-push', { body: { kind: 'new_ride_broadcast', rideId, driverIds } });
  } catch { /* push é best-effort */ }
}

// ─── Handler ─────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: CORS });
  const json = (d: unknown, status = 200) =>
    new Response(JSON.stringify(d), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

  try {
    const body = await req.json();
    const action: string = body?.action;
    if (!action) return json({ error: 'action é obrigatório' }, 400);

    // Autenticação (função com --no-verify-jwt; validamos o usuário aqui).
    const authHeader = req.headers.get('Authorization') ?? '';
    const { data: { user }, error: authErr } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    }).auth.getUser();
    if (authErr || !user) return json({ error: 'Não autorizado' }, 401);

    const admin = makeAdmin();
    const { enabled, config } = await loadConfig(admin);
    if (!enabled) return json({ skipped: true, reason: 'dispatch_engine_v2 OFF' });

    const now = Date.now();
    const pool = await loadPool(admin);

    // ── create: cria o pedido e faz o 1º match ──────────────────────────────
    if (action === 'create') {
      const rideId: string = body?.rideId;
      if (!rideId) return json({ error: 'rideId é obrigatório' }, 400);
      // NOTA: na tabela `rides` o EMBARQUE são as colunas origin_lat/origin_lng
      // (ver requestRide/scheduleRide e a view 0012). Mapeamos origin → pickup ao
      // criar o trip_request, cuja convenção é pickup_lat/pickup_lng.
      const { data: rideRow } = await admin
        .from('rides')
        .select('id, passenger_id, origin_lat, origin_lng, destination_lat, destination_lng, destination_address')
        .eq('id', rideId).single();
      const ride = rideRow as {
        id: string; passenger_id: string; origin_lat: number | null; origin_lng: number | null;
        destination_lat: number | null; destination_lng: number | null; destination_address: string | null;
      } | null;
      if (!ride) return json({ error: 'Corrida não encontrada' }, 404);
      if (ride.passenger_id !== user.id) return json({ error: 'Não autorizado' }, 403);
      if (ride.origin_lat == null || ride.origin_lng == null) return json({ error: 'Sem coordenada de embarque' }, 400);

      // Idempotência: um pedido por ride.
      const { data: existing } = await admin.from('trip_requests').select('id').eq('ride_id', rideId).maybeSingle();
      if (!existing) {
        await admin.from('trip_requests').insert({
          ride_id: rideId, passenger_id: ride.passenger_id,
          pickup_lat: ride.origin_lat, pickup_lng: ride.origin_lng,
          destination_lat: ride.destination_lat, destination_lng: ride.destination_lng,
          destination_address: ride.destination_address,
          status: 'REQUESTED', dispatch_mode: config.dispatchMode, radius_km: config.radiusInitialKm,
        });
        await admin.from('dispatch_events').insert({
          trip_request_id: (await admin.from('trip_requests').select('id').eq('ride_id', rideId).single()).data?.id ?? null,
          event: 'REQUESTED',
        }).select();
      }

      const before = await loadState(admin, config);
      const after = reconcile(before, pool, now);
      const offered = await persistDiff(admin, before, after, pool, now);
      await pushOffered(admin, rideId, offered);
      return json({ ok: true, offered });
    }

    // ── reject: recusa a oferta e promove o próximo ─────────────────────────
    if (action === 'reject') {
      const tripRequestId: string = body?.tripRequestId;
      if (!tripRequestId) return json({ error: 'tripRequestId é obrigatório' }, 400);
      await admin.from('ride_offers').update({ status: 'REJECTED', resolved_at: new Date(now).toISOString() })
        .eq('trip_request_id', tripRequestId).eq('driver_id', user.id).eq('status', 'PENDING');
      await admin.from('dispatch_events').insert({ trip_request_id: tripRequestId, driver_id: user.id, event: 'REJECTED' });

      const before = await loadState(admin, config);
      const mutated = engineReject(before, tripRequestId, user.id); // idempotente: DB já refletiu
      const after = reconcile(mutated, pool, now);
      const offered = await persistDiff(admin, before, after, pool, now);
      const rideId = await rideIdOf(admin, tripRequestId);
      await pushOffered(admin, rideId, offered);
      return json({ ok: true, offered });
    }

    // ── accept: aceite atômico (RPC) + redispatch dos perdedores ────────────
    if (action === 'accept') {
      const tripRequestId: string = body?.tripRequestId;
      if (!tripRequestId) return json({ error: 'tripRequestId é obrigatório' }, 400);
      const { data: outcome, error } = await admin.rpc('accept_trip_offer', {
        p_trip_request_id: tripRequestId, p_driver_id: user.id,
      });
      if (error) return json({ error: error.message }, 400);
      // Redispatch: perdedores liberados assumem o próximo pedido (≤ ciclo).
      const before = await loadState(admin, config);
      const after = reconcile(before, pool, now);
      const offered = await persistDiff(admin, before, after, pool, now);
      // Notifica os perdedores que a corrida saiu (best-effort; realtime já cobre).
      return json({ result: outcome, redispatched: offered });
    }

    // ── cancel: passageiro cancela ──────────────────────────────────────────
    if (action === 'cancel') {
      const tripRequestId: string = body?.tripRequestId;
      if (!tripRequestId) return json({ error: 'tripRequestId é obrigatório' }, 400);
      const { data: tr } = await admin.from('trip_requests').select('passenger_id').eq('id', tripRequestId).single();
      if ((tr as { passenger_id: string } | null)?.passenger_id !== user.id) return json({ error: 'Não autorizado' }, 403);
      await admin.from('trip_requests').update({ status: 'CANCELLED' }).eq('id', tripRequestId);
      await admin.from('ride_offers').update({ status: 'REVOKED', resolved_at: new Date(now).toISOString() })
        .eq('trip_request_id', tripRequestId).eq('status', 'PENDING');
      await admin.from('dispatch_events').insert({ trip_request_id: tripRequestId, event: 'CANCELLED' });
      return json({ ok: true });
    }

    // ── tick: expira/expande/timeout + reconcile (chamado por cron) ─────────
    if (action === 'tick') {
      const before = await loadState(admin, config);
      const after = engineTick(before, pool, now);
      const offered = await persistDiff(admin, before, after, pool, now);
      return json({ ok: true, offered });
    }

    return json({ error: `ação desconhecida: ${action}` }, 400);
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error)?.message ?? e) }), {
      status: 500, headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});

async function rideIdOf(admin: Admin, tripRequestId: string): Promise<string | null> {
  const { data } = await admin.from('trip_requests').select('ride_id').eq('id', tripRequestId).single();
  return (data as { ride_id: string | null } | null)?.ride_id ?? null;
}
