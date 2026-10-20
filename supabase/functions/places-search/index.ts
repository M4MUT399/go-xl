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
//   POST { action: 'autocomplete', query, near?: {lat,lng}, sessionToken }
//     → { suggestions: [...] } (Places API New — places:autocomplete)
//   POST { action: 'details', placeId, sessionToken }
//     → { location: { latitude, longitude } | null } (Places API New)
//   POST { action: 'textsearch', query, near?: {lat,lng} }
//     → { places: [...] } (Places API New — places:searchText, até 20, com coordenada)
//   POST { action: 'search', query: string, near?: {lat,lng} }
//     → { results: [{ name, formatted_address, geometry, types }] } (Places Text Search)
//   POST { action: 'reverse', lat: number, lng: number }
//     → { formatted_address: string | null } (Geocoding reverso)
//
// Por que autocomplete+details e não mais text search para a digitação: Text
// Search cobra por requisição e é desenhado para uma consulta inteira, não
// para uma lista que se refaz a cada tecla. O par autocomplete→details com o
// MESMO `sessionToken` é cobrado como UMA sessão, o que é o que permite baixar
// o debounce sem multiplicar a conta. A regra que sustenta isso: o token vale
// de quando o passageiro começa a digitar até o details que resolve a escolha;
// depois disso ele morre e o cliente precisa gerar outro. Reusar um token já
// fechado faz a Google cobrar tudo por requisição de novo.
//
// Por que existe também `textsearch`: o autocomplete devolve no MÁXIMO 5
// predições e é feito para completar ENDEREÇO — hotel, clínica, consultório,
// restaurante pelo nome muitas vezes fica de fora ou chega só como rua. O
// Text Search (New) é a busca do próprio Google Maps: entende "hilton near
// disney", "dermatologist lake nona", devolve até 20 lugares e já traz a
// coordenada (dispensa o details). Custa mais por chamada, por isso o cliente
// só a dispara com um debounce maior, quando a digitação assenta, e mescla com
// a lista rápida do autocomplete — ver `searchPlacesWide` em src/lib/geocoding.ts.
//
// `action: 'search'` continua aqui porque há app instalado em campo (os QR já
// impressos) que ainda chama essa rota. Pode sair quando não houver mais build
// antigo em uso — hoje nada no repositório chama.
//
// Setup (uma vez):
//   1) Google Cloud Console (projeto goxl-2026) → confirmar "Places API (New)"
//      (autocomplete/details), "Places API" (text search legado) e
//      "Geocoding API" habilitadas. Sem a (New), o autocomplete falha e o
//      cliente cai no Nominatim — degrada, não quebra.
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
const GOOGLE_PLACES_AUTOCOMPLETE = 'https://places.googleapis.com/v1/places:autocomplete';
const GOOGLE_PLACES_DETAILS      = 'https://places.googleapis.com/v1/places';
const GOOGLE_PLACES_SEARCHTEXT   = 'https://places.googleapis.com/v1/places:searchText';

// O placeId e o token entram numa URL montada aqui. Sem esta trava, um cliente
// autenticado escolhe o caminho e a query string da chamada que sai DO NOSSO
// servidor COM A NOSSA CHAVE — o encode sozinho não impede um `..` no caminho.
const PLACE_ID_OK = /^[A-Za-z0-9_-]{1,512}$/;
const SESSION_TOKEN_OK = /^[A-Za-z0-9-]{1,64}$/;

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

    if (action === 'autocomplete') {
      const query = typeof body.query === 'string' ? body.query.trim() : '';
      if (query.length < 3) return json({ suggestions: [] });

      const sessionToken = typeof body.sessionToken === 'string' ? body.sessionToken : '';
      if (!SESSION_TOKEN_OK.test(sessionToken)) return json({ error: 'sessionToken inválido' }, 400);

      const payload: Record<string, unknown> = {
        input: query,
        languageCode: 'en',
        includedRegionCodes: ['us'],
        sessionToken,
      };
      if (isLatLng(body.near)) {
        payload.locationBias = {
          circle: {
            center: { latitude: body.near.lat, longitude: body.near.lng },
            radius: 50000,
          },
        };
      }

      const res = await fetch(GOOGLE_PLACES_AUTOCOMPLETE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GOOGLE_KEY },
        body: JSON.stringify(payload),
      });
      if (!res.ok) return json({ error: 'Falha na busca' }, 502);
      const data = await res.json();
      return json({ suggestions: data.suggestions ?? [] });
    }

    if (action === 'textsearch') {
      const query = typeof body.query === 'string' ? body.query.trim() : '';
      if (query.length < 3) return json({ places: [] });

      const payload: Record<string, unknown> = {
        textQuery: query,
        languageCode: 'en',
        regionCode: 'us',
        pageSize: 20,
      };
      if (isLatLng(body.near)) {
        // Viés, não restrição: o passageiro em Orlando que digita "Miami
        // International Airport" tem de achar o aeroporto de Miami.
        payload.locationBias = {
          circle: {
            center: { latitude: body.near.lat, longitude: body.near.lng },
            radius: 50000,
          },
        };
      }

      const res = await fetch(GOOGLE_PLACES_SEARCHTEXT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': GOOGLE_KEY,
          'X-Goog-FieldMask':
            'places.id,places.displayName,places.formattedAddress,places.location,places.types',
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) return json({ error: 'Falha na busca' }, 502);
      const data = await res.json();
      return json({ places: data.places ?? [] });
    }

    if (action === 'details') {
      const placeId = typeof body.placeId === 'string' ? body.placeId : '';
      if (!PLACE_ID_OK.test(placeId)) return json({ error: 'placeId inválido' }, 400);

      const sessionToken = typeof body.sessionToken === 'string' ? body.sessionToken : '';
      if (!SESSION_TOKEN_OK.test(sessionToken)) return json({ error: 'sessionToken inválido' }, 400);

      // A máscara é só `location`, e é de propósito: `location` é Essentials,
      // mas `displayName` é Pro e subiria a sessão inteira de faixa. Nome e
      // endereço já vieram na predição do autocomplete — pedir de novo aqui
      // seria pagar mais caro pelo que o cliente já tem na mão.
      const url = `${GOOGLE_PLACES_DETAILS}/${encodeURIComponent(placeId)}` +
        `?sessionToken=${encodeURIComponent(sessionToken)}`;
      const res = await fetch(url, {
        headers: { 'X-Goog-Api-Key': GOOGLE_KEY, 'X-Goog-FieldMask': 'location' },
      });
      if (!res.ok) return json({ error: 'Falha ao resolver o endereço' }, 502);
      const data = await res.json();
      return json({ location: data.location ?? null });
    }

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
