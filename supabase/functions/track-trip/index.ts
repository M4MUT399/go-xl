// Supabase Edge Function — página PÚBLICA de rastreio de viagem ao vivo.
//
// Como funciona (Tarefa 1):
//   • O passageiro gera um link com um TOKEN opaco (trip_shares.token) e o envia
//     pelo share sheet nativo a um contato de confiança.
//   • O contato abre a URL no navegador — SEM login. Esta função (verify_jwt=false)
//     valida o token + expiração usando service_role e devolve APENAS os campos
//     whitelistados. Nunca telefone, e-mail ou preço.
//
//   GET ?token=UUID            → página HTML (Leaflet + OpenStreetMap, sem chave)
//   GET ?token=UUID&format=json → payload JSON consumido pelo polling da página
//
// Deploy:  npx supabase functions deploy track-trip
// Requer no config.toml:  [functions.track-trip] verify_jwt = false

import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  shapeTripPayload,
  ENDED_STATUSES,
  type PublicTripPayload,
  type RawRide,
  type RawDriverProfile,
  type RawVehicle,
  type RawDriverLocation,
} from '../_shared/tripShare.ts';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

async function buildPayload(token: string): Promise<PublicTripPayload> {
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const now = Date.now();

  // 1) Localiza o compartilhamento pelo token opaco.
  const { data: share } = await admin
    .from('trip_shares')
    .select('ride_id, expires_at, revoked_at')
    .eq('token', token)
    .maybeSingle();

  if (!share) return shapeTripPayload({ share: null, ride: null, driverProfile: null, vehicle: null, driverLocation: null, now });

  const s = share as { ride_id: string; expires_at: string; revoked_at: string | null };

  // Curto-circuito: link revogado/expirado NÃO precisa buscar a corrida.
  if (s.revoked_at || new Date(s.expires_at).getTime() < now) {
    return shapeTripPayload({ share: s, ride: null, driverProfile: null, vehicle: null, driverLocation: null, now });
  }

  // 2) Busca a corrida (somente colunas whitelistadas — NUNCA price/phone/email).
  const { data: ride } = await admin
    .from('rides')
    .select(
      'status, driver_id, origin_lat, origin_lng, origin_address, ' +
      'destination_lat, destination_lng, destination_address, ' +
      'driver_lat, driver_lng, driver_heading, driver_eta_min'
    )
    .eq('id', s.ride_id)
    .maybeSingle();

  const r = (ride as RawRide | null) ?? null;

  // Curto-circuito: corrida ausente/encerrada NÃO precisa buscar motorista.
  if (!r || ENDED_STATUSES.includes(r.status)) {
    return shapeTripPayload({ share: s, ride: r, driverProfile: null, vehicle: null, driverLocation: null, now });
  }

  // 3) Identidade do motorista + veículo + posição de fallback (só se há motorista).
  let driverProfile: RawDriverProfile | null = null;
  let vehicle: RawVehicle | null = null;
  let driverLocation: RawDriverLocation | null = null;

  if (r.driver_id) {
    const [{ data: prof }, { data: veh }] = await Promise.all([
      admin.from('profiles').select('full_name, avatar_url').eq('id', r.driver_id).maybeSingle(),
      admin.from('vehicles').select('model, color, plate').eq('driver_id', r.driver_id).maybeSingle(),
    ]);
    driverProfile = (prof as RawDriverProfile | null) ?? null;
    vehicle = (veh as RawVehicle | null) ?? null;

    // Fallback de posição só quando a corrida não tem telemetria gravada.
    if (r.driver_lat == null || r.driver_lng == null) {
      const { data: loc } = await admin
        .from('driver_locations')
        .select('lat, lng, heading')
        .eq('driver_id', r.driver_id)
        .maybeSingle();
      driverLocation = (loc as RawDriverLocation | null) ?? null;
    }
  }

  return shapeTripPayload({ share: s, ride: r, driverProfile, vehicle, driverLocation, now });
}

function trackingPage(token: string): Response {
  const accent = '#C9A84C';
  const navy = '#0A0D1C';
  // A página é autossuficiente: Leaflet via CDN + OpenStreetMap (sem chave).
  // O JS faz polling do próprio endpoint (?format=json) a cada 6s.
  const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Go XL — Viagem ao vivo</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <style>
    * { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
    #map { position: absolute; inset: 0 0 132px 0; }
    .brand { position: absolute; top: 12px; left: 12px; z-index: 1000;
      background: ${navy}; color: ${accent}; font-weight: 800; letter-spacing: 3px;
      padding: 6px 12px; border-radius: 10px; font-size: 13px; box-shadow: 0 4px 12px rgba(0,0,0,0.25); }
    .card { position: absolute; left: 0; right: 0; bottom: 0; height: 132px;
      background: #fff; border-top-left-radius: 18px; border-top-right-radius: 18px;
      box-shadow: 0 -4px 16px rgba(0,0,0,0.12); padding: 14px 18px; }
    .row { display: flex; align-items: center; gap: 12px; }
    .avatar { width: 46px; height: 46px; border-radius: 23px; background: #E5E7EB; object-fit: cover; }
    .name { font-size: 17px; font-weight: 700; color: ${navy}; }
    .veh { font-size: 13px; color: #6B7280; margin-top: 2px; }
    .status { margin-top: 12px; font-size: 14px; color: ${navy}; font-weight: 600; }
    .eta { color: ${accent}; }
    .muted { color: #6B7280; font-weight: 500; }
    .ended { position: absolute; inset: 0; z-index: 1200; background: rgba(255,255,255,0.96);
      display: none; align-items: center; justify-content: center; text-align: center; padding: 24px; }
    .ended h1 { color: ${navy}; font-size: 22px; margin: 0 0 8px; }
    .ended p { color: #6B7280; font-size: 15px; margin: 0; }
  </style>
</head>
<body>
  <div class="brand">GO XL</div>
  <div id="map"></div>
  <div class="card">
    <div class="row">
      <img id="avatar" class="avatar" alt="" />
      <div>
        <div id="name" class="name muted">Carregando…</div>
        <div id="veh" class="veh"></div>
      </div>
    </div>
    <div id="status" class="status muted">Localizando a viagem…</div>
  </div>
  <div id="ended" class="ended">
    <div>
      <h1 id="endedTitle">Viagem encerrada</h1>
      <p id="endedMsg">Este link de acompanhamento não está mais ativo.</p>
    </div>
  </div>
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <script>
    var TOKEN = ${JSON.stringify(token)};
    var map = L.map('map', { zoomControl: true }).setView([28.5383, -81.3792], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '&copy; OpenStreetMap'
    }).addTo(map);

    var originMk = null, destMk = null, driverMk = null, routeLn = null;
    var firstFit = true;

    function statusLabel(s) {
      switch (s) {
        case 'accepted': return 'Motorista confirmado, a caminho do embarque';
        case 'driver_en_route': return 'Motorista a caminho do embarque';
        case 'in_progress': return 'Em viagem para o destino';
        default: return 'Acompanhando a viagem';
      }
    }

    function showEnded(reason) {
      var t = document.getElementById('endedTitle');
      var m = document.getElementById('endedMsg');
      if (reason === 'expired') { t.textContent = 'Link expirado'; m.textContent = 'O acompanhamento foi encerrado ou o link expirou.'; }
      else if (reason === 'not_found') { t.textContent = 'Link inválido'; m.textContent = 'Não encontramos esta viagem.'; }
      else { t.textContent = 'Viagem encerrada'; m.textContent = 'A viagem foi concluída ou cancelada.'; }
      document.getElementById('ended').style.display = 'flex';
    }

    function render(d) {
      if (!d.active) { showEnded(d.reason); return; }

      // Motorista
      var name = document.getElementById('name');
      var veh = document.getElementById('veh');
      var av = document.getElementById('avatar');
      if (d.driver) {
        name.textContent = d.driver.first_name;
        name.className = 'name';
        if (d.driver.vehicle) veh.textContent = d.driver.vehicle.color + ' ' + d.driver.vehicle.model + ' · ' + d.driver.vehicle.plate;
        if (d.driver.avatar_url) av.src = d.driver.avatar_url; else av.style.visibility = 'hidden';
      }
      var st = document.getElementById('status');
      var eta = (d.eta_min != null) ? ' · <span class="eta">' + d.eta_min + ' min</span>' : '';
      st.innerHTML = statusLabel(d.status) + eta;
      st.className = 'status';

      // Marcadores de origem e destino
      if (!originMk) originMk = L.marker([d.origin.lat, d.origin.lng]).addTo(map).bindPopup('Embarque');
      if (!destMk) destMk = L.marker([d.destination.lat, d.destination.lng]).addTo(map).bindPopup('Destino');

      // Posição ao vivo do motorista
      if (d.position) {
        var carIcon = L.divIcon({ className: '', html: '<div style="font-size:26px;line-height:26px">🚗</div>', iconSize: [26,26], iconAnchor: [13,13] });
        if (!driverMk) driverMk = L.marker([d.position.lat, d.position.lng], { icon: carIcon, zIndexOffset: 1000 }).addTo(map);
        else driverMk.setLatLng([d.position.lat, d.position.lng]);
      }

      // Trajeto aproximado (origem → posição atual → destino)
      var pts = [[d.origin.lat, d.origin.lng]];
      if (d.position) pts.push([d.position.lat, d.position.lng]);
      pts.push([d.destination.lat, d.destination.lng]);
      if (routeLn) map.removeLayer(routeLn);
      routeLn = L.polyline(pts, { color: '${accent}', weight: 4, opacity: 0.85 }).addTo(map);

      if (firstFit) { map.fitBounds(routeLn.getBounds().pad(0.25)); firstFit = false; }
    }

    function poll() {
      fetch('?token=' + encodeURIComponent(TOKEN) + '&format=json', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(render)
        .catch(function () { /* mantém o último estado em falha de rede */ });
    }
    poll();
    setInterval(poll, 6000);
  </script>
</body>
</html>`;
  return new Response(html, { headers: { ...CORS, 'Content-Type': 'text/html; charset=utf-8' } });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405, headers: CORS });
  }

  const url = new URL(req.url);
  const token = url.searchParams.get('token') ?? '';

  if (url.searchParams.get('format') === 'json') {
    if (!token) {
      return new Response(JSON.stringify({ active: false, reason: 'not_found' }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    try {
      const payload = await buildPayload(token);
      return new Response(JSON.stringify(payload), {
        headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    } catch (_e) {
      return new Response(JSON.stringify({ active: false, reason: 'not_found' }), {
        status: 200, headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
  }

  // Sem token → página genérica de link inválido.
  return trackingPage(token);
});
