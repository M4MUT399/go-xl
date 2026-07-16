// Supabase Edge Function — ROTA ÚNICA no servidor (Bloco 3, paridade Uber).
//
// É a ÚNICA fonte da rota: proxia o OSRM (mesma engine usada hoje no cliente),
// calcula a geometria do ponto de partida (posição atual do motorista) até o
// alvo da FASE (embarque na fase pickup, destino na fase dropoff) e grava na
// corrida a polyline codificada + ETA + distância, INCREMENTANDO route_version.
// Motorista e passageiro leem essas colunas → veem exatamente a mesma rota/ETA.
//
// O OSRM devolve a geometria já como ENCODED POLYLINE (precisão 5) via
// `geometries=polyline`; guardamos a string como veio e o cliente decodifica
// com o mesmo codec (src/lib/nav/sharedRoute.ts → decodePolyline).
//
//   POST { rideId: string } + JWT(motorista) no header Authorization
//   → { version, etaMin, distanceKm }
//
// Deploy:  npx supabase functions deploy compute-route

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')         ?? '';
// Mesma engine do cliente; configurável por env para autohospedar depois.
const OSRM_BASE = Deno.env.get('OSRM_BASE_URL') ?? 'https://router.project-osrm.org';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Fases em que existe uma rota ativa e quem é o alvo dela.
const ACTIVE_STATUSES = ['accepted', 'driver_en_route', 'in_progress'];

interface RideRow {
  driver_id: string | null;
  status: string;
  driver_lat: number | null;
  driver_lng: number | null;
  origin_lat: number;
  origin_lng: number;
  destination_lat: number;
  destination_lng: number;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS });
  }

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });

  try {
    const { rideId } = await req.json().catch(() => ({}));
    if (!rideId) return json({ error: 'rideId obrigatório' }, 400);

    // Auth: o chamador precisa ser o MOTORISTA da corrida.
    const authHeader = req.headers.get('Authorization') ?? '';
    const { data: { user }, error: authErr } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    }).auth.getUser();
    if (authErr || !user) return json({ error: 'Não autorizado' }, 401);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: ride, error: rideErr } = await admin
      .from('rides')
      .select('driver_id, status, driver_lat, driver_lng, origin_lat, origin_lng, destination_lat, destination_lng')
      .eq('id', rideId)
      .maybeSingle();
    if (rideErr || !ride) return json({ error: 'Corrida não encontrada' }, 404);

    const r = ride as RideRow;
    if (r.driver_id !== user.id) return json({ error: 'Apenas o motorista da corrida.' }, 403);
    if (!ACTIVE_STATUSES.includes(r.status)) {
      return json({ error: `Sem rota ativa no status ${r.status}` }, 409);
    }

    // Partida = posição atual do motorista (fallback: embarque). Alvo = embarque
    // na fase de pickup; destino na fase de dropoff (in_progress).
    const start = r.driver_lat != null && r.driver_lng != null
      ? { lat: r.driver_lat, lng: r.driver_lng }
      : { lat: r.origin_lat, lng: r.origin_lng };
    const target = r.status === 'in_progress'
      ? { lat: r.destination_lat, lng: r.destination_lng }
      : { lat: r.origin_lat, lng: r.origin_lng };

    // OSRM: geometria como encoded polyline (precisão 5) — mesma que o cliente decodifica.
    const url =
      `${OSRM_BASE}/route/v1/driving/` +
      `${start.lng},${start.lat};${target.lng},${target.lat}` +
      `?overview=full&geometries=polyline`;
    const osrmRes = await fetch(url);
    if (!osrmRes.ok) return json({ error: 'Falha no roteador' }, 502);
    const osrm = await osrmRes.json();
    const route = osrm?.routes?.[0];
    if (!route?.geometry) return json({ error: 'Rota não encontrada' }, 502);

    const polyline: string = route.geometry;
    const etaMin = Math.max(1, Math.ceil((route.duration ?? 0) / 60));
    const distanceKm = Math.round(((route.distance ?? 0) / 1000) * 100) / 100;

    // Grava atômico + incrementa route_version; o realtime de `rides` propaga
    // para as duas telas (nenhum canal novo).
    const { data: newVersion, error: rpcErr } = await admin.rpc('commit_ride_route', {
      p_ride_id: rideId,
      p_polyline: polyline,
      p_eta_min: etaMin,
      p_distance_km: distanceKm,
    });
    if (rpcErr) return json({ error: 'Falha ao gravar rota' }, 500);

    return json({ version: newVersion, etaMin, distanceKm });
  } catch (_error) {
    return json({ error: 'Erro interno' }, 500);
  }
});
