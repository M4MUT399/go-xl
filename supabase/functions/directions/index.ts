// Supabase Edge Function — PROXY da Google Directions API (Fase 1, navegação).
//
// Por que existe: as chaves do Google em app.config.js são chaves de Maps SDK
// EMBUTIDAS no cliente. Usá-las para chamadas HTTP da Directions API exporia a
// chave a scraping/cobrança. Esta função guarda uma chave SECRETA no servidor
// (GOOGLE_DIRECTIONS_API_KEY), chama a Directions API com departure_time=now
// (ETA COM TRÂNSITO) e devolve o JSON cru da Google — o cliente normaliza num
// módulo puro e testável (src/lib/nav/directions.ts → normalizeGoogleDirections).
//
//   POST { origin: {lat,lng}, dest: {lat,lng} } + JWT no header Authorization
//   → JSON da Google Directions ({ status, routes: [...] })
//
// Setup (uma vez):
//   1) Google Cloud Console → habilitar "Directions API" no projeto do Go XL
//      (atenção: NÃO é o `goxl-2026`, que só tem a service account da Play e
//      nem faturamento ativo — confira em qual projeto o Maps está habilitado)
//   2) Criar/reutilizar uma chave de servidor (SEM restrição de app; de
//      preferência restrita por IP/API à Directions API)
//   3) supabase secrets set GOOGLE_DIRECTIONS_API_KEY=xxxx
//   4) npx supabase functions deploy directions
//
// Só então ligar a flag `directions_v2`. Enquanto a flag estiver OFF (ou a
// função não existir/deployar), o app segue no OSRM (fallback no useRoute).

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')       ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')  ?? '';
const GOOGLE_KEY        = Deno.env.get('GOOGLE_DIRECTIONS_API_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface LatLng { lat: number; lng: number }

function isLatLng(v: unknown): v is LatLng {
  return !!v && typeof (v as LatLng).lat === 'number' && typeof (v as LatLng).lng === 'number';
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
    if (!GOOGLE_KEY) return json({ error: 'Directions não configurado' }, 501);

    // Auth: qualquer usuário autenticado (motorista ou passageiro) pode pedir
    // uma rota — é a mesma informação que ambos já veem na tela.
    const authHeader = req.headers.get('Authorization') ?? '';
    const { data: { user }, error: authErr } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    }).auth.getUser();
    if (authErr || !user) return json({ error: 'Não autorizado' }, 401);

    const body = await req.json().catch(() => ({}));
    const { origin, dest } = body ?? {};
    if (!isLatLng(origin) || !isLatLng(dest)) {
      return json({ error: 'origin/dest inválidos' }, 400);
    }

    const url =
      'https://maps.googleapis.com/maps/api/directions/json' +
      `?origin=${origin.lat},${origin.lng}` +
      `&destination=${dest.lat},${dest.lng}` +
      '&mode=driving' +
      '&departure_time=now' +      // habilita duration_in_traffic (ETA com trânsito)
      '&traffic_model=best_guess' +
      '&language=en' +
      '&units=metric' +
      `&key=${GOOGLE_KEY}`;

    const res = await fetch(url);
    if (!res.ok) return json({ error: 'Falha no roteador' }, 502);
    const data = await res.json();

    // Repassa só o essencial (status + routes). O cliente decodifica/normaliza.
    return json({ status: data.status, routes: data.routes ?? [] });
  } catch (_error) {
    return json({ error: 'Erro interno' }, 500);
  }
});
