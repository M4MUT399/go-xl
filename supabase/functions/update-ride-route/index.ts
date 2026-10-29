// Supabase Edge Function — o PASSAGEIRO muda a rota com a corrida em andamento
// (0091): troca o destino e/ou inclui paradas.
//
// A tarifa foi cobrada no aceite, sobre a rota cotada. Aqui o servidor:
//   1. calcula a rota nova inteira (embarque → paradas → destino), Google com
//      trânsito ou OSRM;
//   2. aplica à tarifa a DIFERENÇA da fórmula entre a rota nova e a cotada, com
//      o pico do pedido (src/lib/fare.ts → fareAfterRouteChange);
//   3. cobra a diferença no cartão salvo (off-session, como a gorjeta) ou
//      devolve a diferença no pagamento original (estorno parcial). Diferença
//      de até US$ 0,50 para qualquer lado é ignorada — não vale a cobrança;
//   4. grava destino, paradas, distância, tempo, preço e o split recalculado.
//
// O dinheiro vai ANTES da gravação: se a cobrança é recusada, nada muda e o
// passageiro recebe o erro. Se a gravação falhar depois de cobrar, é logado
// (mesmo tratamento da gorjeta) — não se cobra de novo porque a chave de
// idempotência leva o número da mudança.
//
//   POST { rideId, destination: {lat,lng,address}, stops: [{lat,lng,address}] }
//   `stops` = paradas AINDA NÃO FEITAS, na ordem; as já concluídas ficam.
//   `dryRun: true` só calcula e devolve { price, delta } — não cobra nem grava.
//
// Deploy:  npx supabase functions deploy update-ride-route --no-verify-jwt

import Stripe from 'npm:stripe@17';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { fareAfterRouteChange, orlandoHour, surgeForHour } from '../_shared/fare.ts';
import { descreverFalhaDeGorjeta } from '../_shared/tipCharge.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', { apiVersion: '2025-01-27.acacia' });

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')         ?? '';
const GOOGLE_KEY           = Deno.env.get('GOOGLE_DIRECTIONS_API_KEY') ?? '';
const OSRM_BASE            = Deno.env.get('OSRM_BASE_URL') ?? 'https://router.project-osrm.org';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const MAX_STOPS = 3;
const MIN_ADJUSTMENT = 0.5;
const ACTIVE = ['accepted', 'driver_en_route', 'in_progress'];

type Pt = { lat: number; lng: number; address?: string };
type Stop = Pt & { done_at?: string | null };

const round2 = (n: number) => Math.round(n * 100) / 100;

function validPt(p: unknown): p is Pt {
  const q = p as Pt;
  return !!q && Number.isFinite(q.lat) && Number.isFinite(q.lng)
    && Math.abs(q.lat) <= 90 && Math.abs(q.lng) <= 180 && !(q.lat === 0 && q.lng === 0);
}

function haversineKm(a: Pt, b: Pt): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(toRad(b.lat - a.lat) / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(toRad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Distância/tempo da rota passando por todos os pontos, em ordem. */
async function routeThrough(points: Pt[]): Promise<{ distanceKm: number; durationMin: number } | null> {
  if (GOOGLE_KEY) {
    try {
      const o = points[0], d = points[points.length - 1];
      const mids = points.slice(1, -1).map((p) => `${p.lat},${p.lng}`).join('|');
      const url = 'https://maps.googleapis.com/maps/api/directions/json'
        + `?origin=${o.lat},${o.lng}&destination=${d.lat},${d.lng}`
        + (mids ? `&waypoints=${encodeURIComponent(mids)}` : '')
        + `&mode=driving&units=metric&key=${GOOGLE_KEY}`;
      const res = await fetch(url);
      const data = await res.json();
      const legs = data?.routes?.[0]?.legs as { distance?: { value: number }; duration?: { value: number } }[] | undefined;
      if (data?.status === 'OK' && legs?.length) {
        const m = legs.reduce((s, l) => s + (l.distance?.value ?? 0), 0);
        const sec = legs.reduce((s, l) => s + (l.duration?.value ?? 0), 0);
        return { distanceKm: round2(m / 1000), durationMin: Math.max(1, Math.ceil(sec / 60)) };
      }
    } catch { /* cai no OSRM */ }
  }
  try {
    const coords = points.map((p) => `${p.lng},${p.lat}`).join(';');
    const res = await fetch(`${OSRM_BASE}/route/v1/driving/${coords}?overview=false`);
    const r = (await res.json())?.routes?.[0];
    if (r) return { distanceKm: round2((r.distance ?? 0) / 1000), durationMin: Math.max(1, Math.ceil((r.duration ?? 0) / 60)) };
  } catch { /* sem rota */ }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: CORS });
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

  try {
    const body = await req.json().catch(() => ({}));
    const rideId: string | undefined = body?.rideId;
    const destination: unknown = body?.destination;
    const newStops: unknown[] = Array.isArray(body?.stops) ? body.stops : [];
    if (!rideId) return json({ error: 'rideId obrigatório' }, 400);
    if (!validPt(destination)) return json({ error: 'invalid_destination' }, 400);
    if (!newStops.every(validPt)) return json({ error: 'invalid_stop' }, 400);

    const authHeader = req.headers.get('Authorization') ?? '';
    const { data: { user }, error: authErr } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    }).auth.getUser();
    if (authErr || !user) return json({ error: 'Não autorizado' }, 401);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: rideRow, error: rideErr } = await admin
      .from('rides')
      .select('id, passenger_id, driver_id, status, created_at, scheduled_for, origin_lat, origin_lng, destination_lat, destination_lng, stops, distance_km, duration_min, price, toll_amount, airport_port_fee, wait_fee_amount, stripe_payment_intent_id, route_change_count, fare_adjustment_amount, payout_id')
      .eq('id', rideId)
      .single();
    if (rideErr || !rideRow) return json({ error: 'Corrida não encontrada' }, 404);
    const r = rideRow as {
      id: string; passenger_id: string; driver_id: string | null; status: string; created_at: string;
      scheduled_for: string | null; origin_lat: number; origin_lng: number; destination_lat: number;
      destination_lng: number; stops: Stop[] | null; distance_km: number | null; duration_min: number | null;
      price: number | null; toll_amount: number | null; airport_port_fee: number | null; wait_fee_amount: number | null;
      stripe_payment_intent_id: string | null; route_change_count: number; fare_adjustment_amount: number | null;
      payout_id: string | null;
    };

    if (user.id !== r.passenger_id) return json({ error: 'Não autorizado' }, 403);
    if (!ACTIVE.includes(r.status)) return json({ error: 'ride_not_active' }, 409);
    if (r.price == null || !r.stripe_payment_intent_id) return json({ error: 'ride_not_charged' }, 409);

    const done = (r.stops ?? []).filter((s) => !!s.done_at);
    if (done.length + newStops.length > MAX_STOPS) return json({ error: 'too_many_stops' }, 400);
    const dest = destination as Pt;
    const stops: Stop[] = [
      ...done,
      ...(newStops as Pt[]).map((p) => ({ lat: p.lat, lng: p.lng, address: String(p.address ?? '').slice(0, 200), done_at: null })),
    ];

    const origin = { lat: r.origin_lat, lng: r.origin_lng };
    const next = await routeThrough([origin, ...stops, dest]);
    if (!next) return json({ error: 'route_not_found' }, 502);

    const quotedKm = r.distance_km ?? round2(haversineKm(origin, { lat: r.destination_lat, lng: r.destination_lng }) * 1.3);
    const quoted = { distanceKm: quotedKm, durationMin: r.duration_min ?? Math.ceil((quotedKm / 48) * 60) };
    const surge = r.scheduled_for ? 1.0 : surgeForHour(orlandoHour(r.created_at));
    const extras = (r.toll_amount ?? 0) + (r.airport_port_fee ?? 0);
    const currentFare = round2(r.price - extras);
    let newFare = fareAfterRouteChange(currentFare, quoted, next, surge);
    let delta = round2(newFare - currentFare);
    if (Math.abs(delta) <= MIN_ADJUSTMENT) { delta = 0; newFare = currentFare; }
    const newPrice = round2(newFare + extras);
    if (newPrice > 2000) return json({ error: 'price_too_high' }, 400);

    // Simulação: o app mostra o valor novo ANTES de o passageiro confirmar.
    if (body?.dryRun === true) {
      return json({ dryRun: true, price: newPrice, delta, distanceKm: next.distanceKm, durationMin: next.durationMin });
    }

    const changeNo = (r.route_change_count ?? 0) + 1;

    // ── Dinheiro primeiro ──────────────────────────────────────────────────
    if (delta > 0) {
      const { data: pax } = await admin.from('profiles')
        .select('stripe_customer_id, stripe_payment_method_id').eq('id', r.passenger_id).single();
      const p = pax as { stripe_customer_id?: string | null; stripe_payment_method_id?: string | null } | null;
      if (!p?.stripe_customer_id || !p?.stripe_payment_method_id) return json({ error: 'no_card' }, 400);
      const cents = Math.round(delta * 100);
      const pi = await stripe.paymentIntents.create({
        amount: cents,
        currency: 'usd',
        customer: p.stripe_customer_id,
        payment_method: p.stripe_payment_method_id,
        off_session: true,
        confirm: true,
        metadata: { rideId, type: 'route_change', change: String(changeNo) },
        description: `Go XL — Route change #${changeNo}`,
      }, { idempotencyKey: `route_${rideId}_${changeNo}_${cents}` });
      if (pi.status !== 'succeeded') return json({ error: `Status inesperado: ${pi.status}` }, 400);
    } else if (delta < 0) {
      await stripe.refunds.create({
        payment_intent: r.stripe_payment_intent_id,
        amount: Math.round(-delta * 100),
        metadata: { rideId, type: 'route_change', change: String(changeNo) },
      }, { idempotencyKey: `route_refund_${rideId}_${changeNo}` });
    }

    // ── Split recalculado sobre o preço novo (+ fatia da espera, se houver) ─
    let split: { driver_amount?: number; platform_fee?: number } = {};
    if (r.driver_id && r.payout_id == null) {
      const { data: prof } = await admin.from('profiles').select('driver_share_percent').eq('id', r.driver_id).single();
      const raw = (prof as { driver_share_percent?: number | null } | null)?.driver_share_percent;
      const share = typeof raw === 'number' && raw > 0 && raw <= 1 ? raw : 0.8;
      const { data: cs } = await admin.rpc('compute_ride_split', {
        p_price: newPrice, p_toll: r.toll_amount ?? 0, p_venue: r.airport_port_fee ?? 0, p_share: share,
      });
      const row = (Array.isArray(cs) ? cs[0] : cs) as { o_driver_amount: number; o_platform_fee: number } | null;
      if (row) {
        const wait = r.wait_fee_amount ?? 0;
        const waitDriver = round2(wait * share);
        split = {
          driver_amount: round2(Number(row.o_driver_amount) + waitDriver),
          platform_fee: round2(Number(row.o_platform_fee) + (wait - waitDriver)),
        };
      }
    }

    const { error: upErr } = await admin.from('rides').update({
      destination_lat: dest.lat,
      destination_lng: dest.lng,
      destination_address: String(dest.address ?? '').slice(0, 300),
      stops,
      distance_km: next.distanceKm,
      duration_min: next.durationMin,
      price: newPrice,
      fare_adjustment_amount: round2((r.fare_adjustment_amount ?? 0) + delta),
      route_change_count: changeNo,
      ...split,
    }).eq('id', rideId);
    if (upErr) {
      console.error('[update-ride-route] dinheiro movido mas rota NÃO gravada', { rideId, delta, changeNo, upErr });
      return json({ error: 'saved_failed' }, 500);
    }

    return json({ success: true, price: newPrice, delta, distanceKm: next.distanceKm, durationMin: next.durationMin });
  } catch (e: unknown) {
    console.error('[update-ride-route] falha', e);
    const falha = descreverFalhaDeGorjeta(e);
    return json({ error: falha.message }, falha.status);
  }
});
