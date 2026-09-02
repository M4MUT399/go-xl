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
// Ações (POST { action, ... }). As quatro primeiras exigem JWT DE USUÁRIO; a
// quinta exige a CHAVE DE SERVIÇO e mais nada:
//   create  { rideId }                      → cria o pedido e faz o 1º match.
//   accept  { tripRequestId }               → aceite atômico (RPC) + redispatch.
//   reject  { tripRequestId }               → recusa e promove o próximo.
//   cancel  { tripRequestId }               → passageiro cancela.
//   tick    { }                             → expira/expande/timeout + reconcile.
//
// ─── AUTENTICAÇÃO DO `tick`, e por que ela mudou (0071) ─────────────────────
// O `tick` passava pela MESMA porta das outras quatro: `auth.getUser()`. Isso
// tinha dois efeitos, ambos ruins e em direções opostas.
//
// 1) O cron NÃO CONSEGUIA CHAMAR. `auth.getUser()` valida um token de USUÁRIO;
//    a `service_role_key` que o pg_cron manda (lida do Vault, como em 0035 e
//    0068) não é um token de usuário e é recusada com 401. O comentário desta
//    ação dizia "chamado por cron" e o cron não existia — quando ele fosse
//    escrito, teria batido em 401 até alguém descobrir por quê.
//
// 2) QUALQUER CONTA LOGADA CONSEGUIA. E contas são grátis e não verificadas
//    (Cadastro Expresso). O `tick` é uma operação GLOBAL: expira ofertas,
//    expande raio e marca NO_DRIVERS de TODOS os pedidos ativos da operação,
//    não só dos do chamador. Não era escalada de privilégio grave — o motor é
//    idempotente e só faz o que o relógio já mandava fazer — mas era uma
//    alavanca global na mão de qualquer um, sem motivo nenhum.
//
// Agora o `tick` é autorizado por `isServiceRoleCaller` (_shared/serviceAuth.ts):
// compara o bearer com a `SUPABASE_SERVICE_ROLE_KEY` em tempo constante, em vez
// de DECODIFICAR o JWT com `atob` e acreditar no campo `role` — que é o furo que
// aquele módulo existe para fechar, e que é real justamente porque esta função é
// publicada com `--no-verify-jwt` (linha do Deploy abaixo), ou seja, sem o
// gateway validar assinatura nenhuma.
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
import { isServiceRoleCaller } from '../_shared/serviceAuth.ts';
import { cortePorFrescorIso } from '../_shared/driverFreshness.ts';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')         ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const BUSY_STATUSES = ['accepted', 'driver_en_route', 'in_progress'];
// ATENÇÃO: o portão do cron da 0071 repete esta lista em SQL, e a asserção Z.4
// daquela migration falha se as duas divergirem. Mudar aqui exige mudar lá.
const ACTIVE_DISPATCH = ['REQUESTED', 'MATCHING', 'OFFERING'];

/**
 * Prazo da trava do tick, em segundos (0071 seção A).
 *
 * É rede de segurança para esta função MORRER no meio (deploy, OOM, timeout do
 * Deno) sem devolver a trava — no caminho normal o `finally` devolve em
 * milissegundos. Vale mais que o período do cron (10 s) de propósito: se um
 * tick demorar mais que o período, o certo é o seguinte DESISTIR, não empilhar.
 */
const TICK_LEASE_SECONDS = 25;

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

// A janela de frescor do fix mora em _shared/driverFreshness.ts — junto com o
// motivo de ela ser 10 min e não 2, e com a lista de quem mais precisa
// concordar com ela. Estava declarada aqui e o `send-ride-push` não tinha
// filtro nenhum; era divergência esperando para acontecer.

async function loadPool(admin: Admin): Promise<DriverPosition[]> {
  const { data: online } = await admin
    .from('driver_locations')
    .select('driver_id, lat, lng')
    .eq('is_online', true)
    .gt('updated_at', cortePorFrescorIso());
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
    //
    // O `.in('status', ACTIVE_DISPATCH)` NÃO é decoração. `req.status` vem do
    // motor, que decidiu em cima do snapshot lido por `loadState` no começo
    // deste tick. Entre aquela leitura e esta escrita o motorista pode ter
    // aceitado. Sem a guarda, `.eq('id', ...)` sozinho sobrescreve o ACCEPTED
    // real pelo status do snapshot — e se o pedido já passou de
    // `globalTimeoutMs` (dispatchEngine.ts:389, que só protege ACCEPTED/ONGOING
    // *do snapshot*) o valor gravado é NO_DRIVERS. O passageiro receberia
    // "não achamos motorista" com um motorista a caminho. Mesmo padrão de
    // guarda que o update de `ride_offers` logo abaixo já usava.
    //
    // `.select('id')` existe para sabermos se a linha foi mesmo atingida: sem
    // isso não dá para distinguir "gravou" de "perdeu a corrida".
    if (!prev || prev.status !== req.status || prev.radiusKm !== req.radiusKm) {
      const { data: applied } = await admin
        .from('trip_requests')
        .update({ status: req.status, radius_km: req.radiusKm })
        .eq('id', req.id)
        .in('status', ACTIVE_DISPATCH)
        .select('id');

      if ((applied?.length ?? 0) === 0) {
        // Perdemos a corrida: o pedido saiu de ACTIVE_DISPATCH (aceito ou
        // cancelado) enquanto este tick pensava. Todo o resto do que temos
        // sobre ele é lixo — não ofertar, não expirar, não emitir evento.
        // O próximo tick nem carrega este pedido.
        //
        // Pular aqui NÃO deixa oferta PENDING para trás, mas isso depende de um
        // fato externo que precisa estar escrito: as DUAS únicas saídas de
        // ACTIVE_DISPATCH varrem os PENDING sozinhas — `accept_trip_offer`
        // (migration 0054) manda os irmãos para REVOKED, e o `cancel` desta
        // mesma função varre os seus. Se alguém criar uma TERCEIRA saída sem
        // varredura, este `continue` passa a vazar linhas órfãs em silêncio.
        continue;
      }

      if (req.status === 'NO_DRIVERS') {
        await admin.from('dispatch_events').insert({ trip_request_id: req.id, event: 'NO_DRIVERS' });
      }
    }

    const prevPending = new Set((prev?.offers ?? []).map((o) => o.driverId));
    const enginePending = new Set(req.offers.map((o) => o.driverId));
    // Os motoristas para quem ESTE tick criou oferta NESTE pedido. Guarda
    // `driver_id`, não id de oferta. `newlyOffered` não serve: é acumulado entre
    // pedidos e vira alvo de push.
    const newOfferDriverIds: string[] = [];

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
      newOfferDriverIds.push(o.driverId);
    }

    // Ofertas que o motor derrubou (expiraram no tick) → marca EXPIRED.
    for (const id of prevPending) {
      if (enginePending.has(id)) continue;
      await admin.from('ride_offers').update({ status: 'EXPIRED', resolved_at: new Date(now).toISOString() })
        .eq('trip_request_id', req.id).eq('driver_id', id).eq('status', 'PENDING');
      await admin.from('dispatch_events').insert({ trip_request_id: req.id, driver_id: id, event: 'EXPIRED' });
    }

    // ── VARREDURA FINAL: a oferta órfã ─────────────────────────────────────
    // A guarda lá em cima só roda quando o status ou o raio MUDARAM neste tick.
    // O caminho mais comum do modo sequencial não muda nenhum dos dois: a
    // oferta de A vence, o motor tira A (OFFERING → MATCHING) e o `reconcile`
    // promove B (MATCHING → OFFERING) — mesmo status, mesmo raio, guarda não
    // roda. Se A aceitou nesse meio-tempo (e `accept_trip_offer` na 0054 NÃO
    // confere `expires_at`, só `status = 'PENDING'`, então A consegue aceitar
    // até ~um período de cron depois de vencido), a sequência é: o RPC varre os
    // irmãos PENDING → REVOKED e SÓ DEPOIS o `upsert` acima grava B como
    // PENDING. Fica uma linha PENDING permanente num pedido já ACCEPTED: nenhum
    // tick futuro carrega esse pedido (`loadState` filtra por ACTIVE_DISPATCH)
    // e não existe nenhuma outra varredura de `ride_offers` no repositório.
    //
    // Por que uma releitura ANTES do upsert não resolveria: seria TOCTOU — o
    // aceite ainda poderia cair entre a leitura e a escrita. Depois resolve o
    // caminho determinístico: se o aceite já commitou, lemos o status terminal e
    // limpamos aqui.
    //
    // O QUE ISTO NÃO FECHA — dito sem enfeite, porque uma versão anterior deste
    // comentário afirmava cobrir "qualquer intercalação", e não cobre. Em 0054 a
    // ordem DENTRO da transação do aceite é: `update trip_requests` (159) →
    // oferta própria (177) → varredura dos irmãos (182) → COMMIT. Sob READ
    // COMMITTED existe a intercalação
    //     varredura(182) < nosso upsert(268) < nossa releitura(310) < COMMIT
    // em que a varredura dele não vê nossa linha (ainda não existe) e nossa
    // releitura não vê o ACCEPTED dele (ainda não commitou). Ninguém limpa. A
    // janela é do tamanho do commit do RPC, não zero.
    //
    // A CORREÇÃO DEFINITIVA é um zelador idempotente, uma instrução por tick,
    // sem TOCTOU e imune a uma terceira saída futura:
    //     update ride_offers set status = 'REVOKED'
    //      where status = 'PENDING'
    //        and not exists (select 1 from trip_requests t
    //                         where t.id = trip_request_id
    //                           and t.status in ('REQUESTED','MATCHING','OFFERING'))
    // Ela precisa ser RPC (PostgREST não expressa `not exists`) e portanto uma
    // migration nova. NÃO foi feita nesta rodada: nenhuma linha de SQL das
    // migrations 0064-0071 jamais executou nesta máquina, e empilhar mais SQL
    // não verificado sobre SQL não verificado troca um resíduo medido por um
    // risco desconhecido. Fica como pendência explícita, com o texto pronto.
    if (newOfferDriverIds.length > 0) {
      const { data: stillActive, error: recheckErr } = await admin
        .from('trip_requests')
        .select('id')
        .eq('id', req.id)
        .in('status', ACTIVE_DISPATCH)
        .maybeSingle();

      // `recheckErr` NÃO pode ser ignorado. `maybeSingle()` devolve `data: null`
      // tanto para "zero linhas" quanto para falha de rede, e as duas leituras
      // pedem ações OPOSTAS: em "zero linhas" revogar é certo; numa falha de
      // rede revogar mata ofertas VÁLIDAS que acabaram de ir para motoristas
      // reais — o tick derrubaria a própria corrida por causa de um blip. Na
      // dúvida não revogamos: a órfã é um registro sujo, revogar por engano é
      // uma corrida perdida. E a órfã ainda tem a rede de segurança da varredura
      // do `accept_trip_offer`, que roda depois em boa parte das intercalações.
      if (recheckErr) {
        console.error(
          '[ALERT][dispatch-engine] ORPHAN_RECHECK_FAILED',
          JSON.stringify({ tripRequestId: req.id, message: recheckErr.message }),
        );
      } else if (!stillActive) {
        const { data: revoked } = await admin.from('ride_offers')
          .update({ status: 'REVOKED', resolved_at: new Date(now).toISOString() })
          .eq('trip_request_id', req.id)
          .in('driver_id', newOfferDriverIds)
          .eq('status', 'PENDING')
          .select('driver_id');

        // A trilha de 0054 é "cada transição", e REVOKED está no vocabulário
        // (0054:99). Sem isto, um motorista que recebeu o card e o viu sumir não
        // tem nenhum registro do porquê — e é justamente a transição que o
        // suporte vai precisar explicar. Grava só o que a escrita de fato mudou.
        const rows = (revoked as { driver_id: string }[] | null) ?? [];
        if (rows.length > 0) {
          await admin.from('dispatch_events').insert(
            rows.map((r) => ({
              trip_request_id: req.id,
              driver_id: r.driver_id,
              event: 'REVOKED',
              meta: { source: 'orphan_sweep' },
            })),
          );
        }
      }
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

    // ── tick: SÓ o cron. Ver o bloco AUTENTICAÇÃO no cabeçalho ──────────────
    // Fica ANTES da autenticação de usuário de propósito: o chamador é o
    // pg_cron com a chave de serviço, que `auth.getUser()` recusaria com 401.
    if (action === 'tick') {
      if (!isServiceRoleCaller(req.headers.get('Authorization'), SUPABASE_SERVICE_KEY)) {
        return json({ error: 'Não autorizado' }, 401);
      }

      const admin = makeAdmin();
      const { enabled, config } = await loadConfig(admin);
      if (!enabled) return json({ skipped: true, reason: 'dispatch_engine_v2 OFF' });

      // Trava de exclusão entre ticks (0071 A). O cron dispara a cada 10 s e
      // não espera a rodada anterior terminar; sem isto, duas rodadas leriam o
      // mesmo estado e escreveriam o mesmo diff duas vezes.
      const { data: leaseToken, error: leaseErr } = await admin.rpc(
        'try_acquire_dispatch_tick',
        { p_lease_seconds: TICK_LEASE_SECONDS },
      );

      // FALHA FECHADA, e o alerta importa mais que o status. Se a 0071 não tiver
      // sido aplicada, a RPC não existe e todo tick cairia aqui: sem este ramo,
      // `leaseGot` viria `null`, o código leria "outro tick está rodando" e o
      // despacho ficaria parado PARA SEMPRE, em silêncio — que é exatamente o
      // defeito que a 0071 conserta, agora escondido atrás de uma trava. O
      // prefixo estável é o que uma regra de alerta sobre os logs deve casar.
      if (leaseErr) {
        console.error(
          '[ALERT][dispatch-engine] TICK_LEASE_UNAVAILABLE',
          JSON.stringify({ message: leaseErr.message, hint: 'aplique a migration 0071 antes de agendar o cron' }),
        );
        return json({ error: 'Trava do tick indisponível', code: 'TICK_LEASE_UNAVAILABLE' }, 503);
      }
      // A RPC devolve o token de posse quando ganha e `null` quando perde.
      if (typeof leaseToken !== 'string') return json({ skipped: true, reason: 'tick já em andamento' });

      try {
        const tickNow = Date.now();
        const tickPool = await loadPool(admin);
        const before = await loadState(admin, config);
        const after = engineTick(before, tickPool, tickNow);
        const offered = await persistDiff(admin, before, after, tickPool, tickNow);
        return json({ ok: true, offered });
      } finally {
        // Devolver antes do prazo é o caminho normal; o prazo cobre a morte.
        // O `catch` vazio é deliberado: se a devolução falhar, a trava vence
        // sozinha em TICK_LEASE_SECONDS e o pior efeito é perder alguns ticks —
        // deixar a exceção subir daqui MASCARARIA o resultado real do tick.
        //
        // O token é obrigatório: esta rodada pode ter estourado o próprio prazo
        // e outra já ter assumido. Sem provar posse, liberaríamos a trava DELA.
        try { await admin.rpc('release_dispatch_tick', { p_token: leaseToken }); } catch { /* o prazo cobre */ }
      }
    }

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

    // `tick` NÃO está aqui: ele é tratado antes da autenticação de usuário,
    // porque quem o chama é o cron com a chave de serviço. Ver o cabeçalho.
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
