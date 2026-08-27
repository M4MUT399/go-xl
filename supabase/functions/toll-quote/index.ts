// Supabase Edge Function — PROXY da Google Routes API para PEDÁGIO.
//
// Por que existe: até agora a GoXL não cobrava pedágio nenhum. O
// `GoogleTollProvider` em src/lib/tolls.ts era um stub que lançava, e o único
// provider implementado (`mock`) devolve `flat + perKm × distância` — um número
// inventado, igual em toda corrida, inclusive nas que não passam por praça
// alguma. Quem estava pagando a conta era o MOTORISTA: o pedágio é repasse
// integral a ele (ver src/lib/split.ts), e repasse de zero é zero.
//
// Em Orlando isso não é detalhe. A Beachline (SR-528) até o MCO é pedagiada, e
// um extrato semanal real de motorista mostrou US$ 103,02 em pedágios.
//
// A chave fica AQUI, no servidor, pelo mesmo motivo da `places-search`: uma
// chamada REST feita pelo app não tem como ser restringida por aplicativo no
// Google Cloud, então a chave seria necessariamente irrestrita e extraível do
// binário publicado.
//
//   POST { origin: {lat,lng}, dest: {lat,lng}, tollPasses?: string[],
//          emissionType?: string }
//     → { amount: number, currency: 'USD', source: 'google' }
//     → { amount: 0, currency: 'USD', source: 'google', semPedagio: true }
//
// ── SETUP (uma vez) ────────────────────────────────────────────────────────
//
//   1) Google Cloud (projeto goxl-2026) → habilitar "Routes API".
//   2) Criar chave de SERVIDOR dedicada (Restrição de aplicativo: Nenhuma —
//      ela nunca sai daqui; Restrição de API: Routes API).
//   3) supabase secrets set GOOGLE_ROUTES_API_KEY=xxxx
//   4) supabase functions deploy toll-quote
//
// ── CUSTO ──────────────────────────────────────────────────────────────────
//
// Pedir `tollInfo` no FieldMask cobra na faixa "Routes Preferred", US$ 15 por
// mil chamadas (US$ 0,015 cada). O cliente faz cache (ver src/lib/tolls.ts)
// justamente porque a tela de pedido reestima a cada mudança de destino.
//
// ── O QUE ESTA FUNÇÃO NÃO FAZ ──────────────────────────────────────────────
//
// Não decide se o pedágio será cobrado. Isso é da flag `tolls_enabled` em
// system_config, lida no cliente. Aqui só se responde "quanto custa a rota".

import { createClient } from 'jsr:@supabase/supabase-js@2';
// A leitura do `Money` da Google mora em _shared porque é pura e é onde um
// erro silencioso custa dinheiro — ver _shared/__tests__/tollMoney.test.ts.
import { pedagioEmUSD } from '../_shared/tollMoney.ts';

const SUPABASE_URL      = Deno.env.get('SUPABASE_URL')      ?? '';
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const GOOGLE_KEY        = Deno.env.get('GOOGLE_ROUTES_API_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface LatLng { lat: number; lng: number }

function isLatLng(v: unknown): v is LatLng {
  const p = v as LatLng;
  return !!p && typeof p.lat === 'number' && typeof p.lng === 'number'
    && Number.isFinite(p.lat) && Number.isFinite(p.lng)
    && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
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
    // 501 e não 500: "não configurado" é estado de setup, não falha. O cliente
    // trata qualquer erro como pedágio 0 e a corrida segue.
    if (!GOOGLE_KEY) return json({ error: 'Routes API não configurada' }, 501);

    // Só autenticado. É consulta paga: sem isto, qualquer um com a anon key do
    // binário poderia torrar a cota.
    const authHeader = req.headers.get('Authorization') ?? '';
    const { data: { user }, error: authErr } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    }).auth.getUser();
    if (authErr || !user) return json({ error: 'Não autorizado' }, 401);

    const body = await req.json().catch(() => ({}));
    const { origin, dest, tollPasses, emissionType } = body ?? {};
    if (!isLatLng(origin) || !isLatLng(dest)) {
      return json({ error: 'origin/dest inválidos' }, 400);
    }

    const pedido = {
      origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
      destination: { location: { latLng: { latitude: dest.lat, longitude: dest.lng } } },
      travelMode: 'DRIVE',
      extraComputations: ['TOLLS'],
      routeModifiers: {
        vehicleInfo: { emissionType: typeof emissionType === 'string' ? emissionType : 'GASOLINE' },
        // Sem passe, a Google devolve o preço em DINHEIRO. Ver a nota sobre
        // `toll_passes` em src/lib/tolls.ts: incluir US_FL_SUNPASS aproxima do
        // que o motorista com SunPass realmente paga.
        ...(Array.isArray(tollPasses) && tollPasses.length ? { tollPasses } : {}),
      },
    };

    const res = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_KEY,
        // Sem `travelAdvisory.tollInfo` no FieldMask a Google NÃO devolve
        // pedágio — e também não cobra por ele. Pedir o campo é o que liga a
        // funcionalidade e a tarifação.
        'X-Goog-FieldMask': 'routes.distanceMeters,routes.travelAdvisory.tollInfo',
      },
      body: JSON.stringify(pedido),
    });

    if (!res.ok) {
      const detalhe = await res.text().catch(() => '');
      console.error('[toll-quote] Routes API', res.status, detalhe.slice(0, 300));
      return json({ error: 'Falha ao consultar pedágio' }, 502);
    }

    const data = await res.json();
    const rota = data?.routes?.[0];

    // Rota sem `tollInfo` é rota SEM PEDÁGIO — resposta legítima, não falha.
    // A Google só cobre pedágio em cidades selecionadas; onde não cobre, a
    // ausência é indistinguível de "não há praça". O campo `semPedagio` deixa
    // essa ambiguidade explícita para quem for depurar.
    const valor = pedagioEmUSD(rota?.travelAdvisory?.tollInfo?.estimatedPrice);
    if (valor === null) {
      return json({ amount: 0, currency: 'USD', source: 'google', semPedagio: true });
    }

    return json({
      amount: Math.max(0, valor),
      currency: 'USD',
      source: 'google',
      distanceMeters: typeof rota?.distanceMeters === 'number' ? rota.distanceMeters : null,
    });
  } catch (erro) {
    console.error('[toll-quote] erro', erro);
    return json({ error: 'Erro interno' }, 500);
  }
});
