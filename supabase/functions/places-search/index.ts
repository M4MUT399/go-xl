// Supabase Edge Function — PROXY da Google Places (Text Search) + Geocoding
// (item #81, mesma lógica da fix aplicada à Directions API em
// supabase/functions/directions/index.ts).
//
// Por que existe: src/lib/geocoding.ts fazia fetch() DIRETO da Google Places/
// Geocoding a partir do cliente, com a chave como query param. Diferente da
// chave de Maps SDK (embutida no app.config.js, mas restringível por
// pacote Android + assinatura, ou por bundle ID iOS), uma chamada REST crua
// feita pelo app não tem como ser restringida por app no Google Cloud — o
// Google não vê referrer nem certificado nessas chamadas. Ou seja, essa
// chave era necessariamente "Restrição de aplicativo: Nenhuma" e ficava
// 100% extraível do bundle publicado. Esta função guarda a chave SECRETA no
// servidor (GOOGLE_PLACES_API_KEY) e o cliente nunca mais recebe/embute
// nenhuma chave para esse uso.
//
//   POST { action: 'search', query: string, near?: {lat,lng} }
//     → { results: [{ name, formatted_address, geometry, types }] } (Places Text Search)
//   POST { action: 'reverse', lat: number, lng: number }
//     → { formatted_address: string | null } (Geocoding reverso)
//
// Setup (uma vez):
//   1) Google Cloud Console (projeto goxl-2026) → confirmar "Places API" e
//      "Geocoding API" habilitadas
//   2) Criar uma chave de SERVIDOR nova e dedicada (Restrição de aplicativo:
//      Nenhuma — ela nunca sai do servidor; Restrição de API: Places API +
//      Geocoding API, para limitar o raio de dano caso vaze de outra forma)
//   3) supabase secrets set GOOGLE_PLACES_API_KEY=xxxx
//   4) npx supabase functions deploy places-search
//
// Enquanto a env não estiver configurada, retorna 501 e o cliente cai no
// fallback Nominatim que já existia (ver src/lib/geocoding.ts).

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')      ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const GOOGLE_KEY         = Deno.env.get('GOOGLE_PLACES_API_KEY') ?? '';

const GOOGLE_PLACES_TEXTSEARCH = 'https://maps.googleapis.com/maps/api/place/textsearch/json';
const GOOGLE_GEOCODE_REVERSE   = 'https://maps.googleapis.com/maps/api/geocode/json';

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
    if (!GOOGLE_KEY) return json({ error: 'Places/Geocoding não configurado' }, 501);

    // Auth: qualquer usuário autenticado (motorista ou passageiro) pode
    // buscar endereços — é a mesma informação que ambos já veem na tela.
    const authHeader = req.headers.get('Authorization') ?? '';
    const { data: { user }, error: authErr } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    }).auth.getUser();
    if (authErr || !user) return json({ error: 'Não autorizado' }, 401);

    const body = await req.json().catch(() => ({}));
    const { action } = body ?? {};

    if (action === 'search') {
      const query = typeof body.query === 'string' ? body.query.trim() : '';
      if (query.length < 3) return json({ results: [] });

      const params = new URLSearchParams({
        query,
        key: GOOGLE_KEY,
        language: 'en',
        region: 'us',
      });
      if (isLatLng(body.near)) {
        params.set('location', `${body.near.lat},${body.near.lng}`);
        params.set('radius', '50000');
      }

      const res = await fetch(`${GOOGLE_PLACES_TEXTSEARCH}?${params.toString()}`);
      if (!res.ok) return json({ error: 'Falha na busca' }, 502);
      const data = await res.json();
      if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
        return json({ error: `places status ${data.status}` }, 502);
      }
      return json({ results: (data.results ?? []).slice(0, 12) });
    }

    if (action === 'reverse') {
      if (!isLatLng(body)) return json({ error: 'lat/lng inválidos' }, 400);

      const params = new URLSearchParams({
        latlng: `${body.lat},${body.lng}`,
        key: GOOGLE_KEY,
        language: 'en',
      });
      const res = await fetch(`${GOOGLE_GEOCODE_REVERSE}?${params.toString()}`);
      if (!res.ok) return json({ error: 'Falha no reverse geocode' }, 502);
      const data = await res.json();
      const formatted = data.status === 'OK' ? data.results?.[0]?.formatted_address ?? null : null;
      return json({ formatted_address: formatted });
    }

    return json({ error: 'action inválida' }, 400);
  } catch (_error) {
    return json({ error: 'Erro interno' }, 500);
  }
});
