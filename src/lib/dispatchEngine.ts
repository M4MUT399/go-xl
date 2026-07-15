// dispatchEngine — NÚCLEO PURO do motor de distribuição de corridas estilo Uber
// (PR-b). Modela N pedidos INDEPENDENTES, cada um com sua própria máquina de
// estados, e um ESCALONADOR que respeita a trava "um motorista = no máximo uma
// oferta pendente". Zero dependência de React/Supabase/Deno: pura e testável.
//
// Máquina de estados por pedido (trip_request):
//   REQUESTED → MATCHING → OFFERING → ACCEPTED → ONGOING
//                    └────────────→ NO_DRIVERS   (raio esgotado / timeout global)
//   (qualquer estado não-terminal) → CANCELLED   (passageiro cancelou)
//
// Invariante central (a mesma do bug do PR-a, agora garantida no servidor):
//   criar/receber um novo pedido JAMAIS altera, cancela ou silencia outro
//   pedido válido. Cada máquina evolui isolada; o escalonador só ATRIBUI
//   motoristas livres, nunca rouba um motorista já comprometido com outra oferta.
//
// Aceite atômico (compare-and-set): apenas UM motorista vence um pedido em
// OFFERING; os demais que tinham oferta desse pedido recebem
// TRIP_NO_LONGER_AVAILABLE e voltam ao pool livre para o próximo pedido (FIFO).
//
// Este módulo é a fonte da lógica; a Edge Function (orquestrador) e as tabelas
// (fonte da verdade/persistência) apenas aplicam estas transições.

// Geometria própria (haversine) — mantém o módulo PURO, sem importar nada que
// puxe Supabase/React na cadeia. Mesma fórmula de airportFees.haversineKm.
export type LatLng = { lat: number; lng: number };

const EARTH_KM = 6371;
const toRad = (deg: number) => (deg * Math.PI) / 180;

export function haversineKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type TripStatus =
  | 'REQUESTED'
  | 'MATCHING'
  | 'OFFERING'
  | 'ACCEPTED'
  | 'ONGOING'
  | 'CANCELLED'
  | 'NO_DRIVERS';

export type DispatchMode = 'sequential' | 'broadcast';

/** Posição/estado de um motorista no pool no instante do reconcile. */
export interface DriverPosition {
  driverId: string;
  lat: number;
  lng: number;
  /** Já ocupado em OUTRA corrida (accepted/en_route/in_progress). */
  busy?: boolean;
  /** ETA (min) pré-computado até o pickup; se ausente, deriva da distância. */
  etaMinOverride?: number | null;
}

/** Candidato ranqueado para um pedido específico. */
export interface Candidate {
  driverId: string;
  etaMin: number;
  distanceKm: number;
}

/** Uma oferta viva (motorista + validade). */
export interface LiveOffer {
  driverId: string;
  /** epoch ms em que a oferta expira (timer configurável). */
  expiresAt: number;
}

/** Uma máquina de estados de UM pedido de corrida. */
export interface TripRequest {
  id: string;
  status: TripStatus;
  pickup: LatLng;
  /** epoch ms de criação — chave primária do FIFO. */
  createdAt: number;
  /** raio de busca atual (km) — cresce por expansão. */
  radiusKm: number;
  /** motoristas que já receberam (e recusaram/expiraram) oferta deste pedido. */
  offeredTo: string[];
  /** ofertas vivas agora (1 em sequential; N em broadcast). */
  offers: LiveOffer[];
  /** vencedor do aceite atômico (null enquanto não aceito). */
  acceptedBy: string | null;
}

export interface DispatchConfig {
  /** Timer de cada oferta antes de expirar (ms). Default 15s. */
  offerTtlMs: number;
  /** sequential (padrão) = uma oferta por vez; broadcast = todos os candidatos. */
  dispatchMode: DispatchMode;
  /** Raio inicial de busca (km). */
  radiusInitialKm: number;
  /** Incremento de raio a cada expansão (km). */
  radiusStepKm: number;
  /** Raio máximo (km) antes de desistir → NO_DRIVERS. */
  radiusMaxKm: number;
  /** Tempo global (ms) do pedido antes de desistir → NO_DRIVERS. Default 5min. */
  globalTimeoutMs: number;
  /** Velocidade média (km/min) p/ derivar ETA da distância. Default 0.5 (=30km/h). */
  avgSpeedKmPerMin: number;
}

export const DISPATCH_DEFAULTS: DispatchConfig = {
  offerTtlMs: 15_000,
  dispatchMode: 'sequential',
  radiusInitialKm: 3,
  radiusStepKm: 2,
  radiusMaxKm: 15,
  globalTimeoutMs: 5 * 60_000,
  avgSpeedKmPerMin: 0.5,
};

export interface EngineState {
  requests: TripRequest[];
  config: DispatchConfig;
}

/** Estados terminais — máquina não evolui mais. */
const TERMINAL: ReadonlySet<TripStatus> = new Set<TripStatus>([
  'ACCEPTED',
  'ONGOING',
  'CANCELLED',
  'NO_DRIVERS',
]);

/** Resultado do aceite atômico. */
export type AcceptOutcome =
  | { result: 'ACCEPTED'; losers: string[] }
  | { result: 'TRIP_NO_LONGER_AVAILABLE'; losers: [] };

// ─── Construção ──────────────────────────────────────────────────────────────

export function createEngine(config: Partial<DispatchConfig> = {}): EngineState {
  return { requests: [], config: { ...DISPATCH_DEFAULTS, ...config } };
}

/**
 * Adiciona um novo pedido (REQUESTED). NÃO toca em nenhum pedido existente —
 * prova da invariante de independência. O reconcile subsequente é quem atribui.
 */
export function createRequest(
  state: EngineState,
  input: { id: string; pickup: LatLng; createdAt: number; radiusKm?: number }
): EngineState {
  if (state.requests.some((r) => r.id === input.id)) return state; // idempotente
  const req: TripRequest = {
    id: input.id,
    status: 'REQUESTED',
    pickup: input.pickup,
    createdAt: input.createdAt,
    radiusKm: input.radiusKm ?? state.config.radiusInitialKm,
    offeredTo: [],
    offers: [],
    acceptedBy: null,
  };
  return { ...state, requests: [...state.requests, req] };
}

// ─── Ranking ─────────────────────────────────────────────────────────────────

function etaFor(config: DispatchConfig, d: DriverPosition, distanceKm: number): number {
  if (typeof d.etaMinOverride === 'number') return d.etaMinOverride;
  return distanceKm / config.avgSpeedKmPerMin;
}

/**
 * Candidatos de um pedido: motoristas dentro do raio, ordenados por ETA (asc),
 * desempate por distância (asc) e por driverId (determinístico). NÃO filtra
 * ocupados/travados aqui — isso é responsabilidade do escalonador (reconcile),
 * que enxerga o pool global.
 */
export function rankCandidates(
  pickup: LatLng,
  drivers: DriverPosition[],
  radiusKm: number,
  config: DispatchConfig
): Candidate[] {
  const out: Candidate[] = [];
  for (const d of drivers) {
    const distanceKm = haversineKm(pickup, { lat: d.lat, lng: d.lng });
    if (distanceKm > radiusKm) continue;
    out.push({ driverId: d.driverId, etaMin: etaFor(config, d, distanceKm), distanceKm });
  }
  out.sort(
    (a, b) =>
      a.etaMin - b.etaMin || a.distanceKm - b.distanceKm || (a.driverId < b.driverId ? -1 : 1)
  );
  return out;
}

// ─── Derivados de trava ──────────────────────────────────────────────────────

/** Motoristas com oferta VIVA agora (travados: 1 oferta por motorista). */
function lockedDrivers(state: EngineState): Set<string> {
  const s = new Set<string>();
  for (const r of state.requests) {
    if (r.status === 'OFFERING') for (const o of r.offers) s.add(o.driverId);
  }
  return s;
}

/** Motoristas que já venceram um pedido (ocupados internamente). */
function acceptedDrivers(state: EngineState): Set<string> {
  const s = new Set<string>();
  for (const r of state.requests) {
    if ((r.status === 'ACCEPTED' || r.status === 'ONGOING') && r.acceptedBy) s.add(r.acceptedBy);
  }
  return s;
}

/** Um pedido precisa de (mais) oferta agora? */
function needsOffer(r: TripRequest): boolean {
  if (TERMINAL.has(r.status)) return false;
  return r.offers.length === 0 || r.status === 'MATCHING' || r.status === 'REQUESTED';
}

// ─── Escalonador (coração) ───────────────────────────────────────────────────

/**
 * Atribui motoristas livres aos pedidos pendentes, em ordem FIFO (createdAt),
 * com desempate pela MENOR ETA disponível. Respeita a trava global "um motorista
 * = no máximo uma oferta pendente" e nunca oferece a um motorista ocupado ou já
 * recusante daquele pedido. Idempotente: se nada muda, devolve o mesmo estado.
 *
 * sequential: cada pedido pendente recebe UM candidato (o melhor livre).
 * broadcast : cada pedido pendente recebe TODOS os candidatos livres de uma vez.
 *
 * Sem candidato livre dentro do raio e raio já no máximo (ou timeout) → o tick
 * decide NO_DRIVERS; aqui apenas deixamos em MATCHING aguardando.
 */
export function reconcile(
  state: EngineState,
  drivers: DriverPosition[],
  now: number
): EngineState {
  const busyExternal = new Set(drivers.filter((d) => d.busy).map((d) => d.driverId));
  const unavailable = new Set<string>([
    ...busyExternal,
    ...acceptedDrivers(state),
    ...lockedDrivers(state),
  ]);

  // Fila de pedidos pendentes, FIFO com desempate por melhor ETA disponível.
  const pending = state.requests.filter(needsOffer);
  const bestEta = new Map<string, number>();
  for (const r of pending) {
    const c = rankCandidates(r.pickup, drivers, r.radiusKm, state.config)[0];
    bestEta.set(r.id, c ? c.etaMin : Number.POSITIVE_INFINITY);
  }
  pending.sort(
    (a, b) => a.createdAt - b.createdAt || (bestEta.get(a.id)! - bestEta.get(b.id)!)
  );

  let changed = false;
  const byId = new Map(state.requests.map((r) => [r.id, { ...r, offers: [...r.offers], offeredTo: [...r.offeredTo] }]));

  for (const p of pending) {
    const r = byId.get(p.id)!;
    const ranked = rankCandidates(r.pickup, drivers, r.radiusKm, state.config).filter(
      (c) => !unavailable.has(c.driverId) && !r.offeredTo.includes(c.driverId)
    );
    if (ranked.length === 0) {
      if (r.status === 'REQUESTED') {
        r.status = 'MATCHING';
        changed = true;
      }
      continue;
    }
    const picks =
      state.config.dispatchMode === 'broadcast' ? ranked : ranked.slice(0, 1);
    for (const c of picks) {
      r.offers.push({ driverId: c.driverId, expiresAt: now + state.config.offerTtlMs });
      r.offeredTo.push(c.driverId);
      unavailable.add(c.driverId);
    }
    r.status = 'OFFERING';
    changed = true;
  }

  if (!changed) return state;
  return { ...state, requests: state.requests.map((r) => byId.get(r.id)!) };
}

// ─── Aceite atômico ──────────────────────────────────────────────────────────

/**
 * Aceite atômico (compare-and-set): vence apenas se o pedido está em OFFERING,
 * ainda sem `acceptedBy`, e o motorista tinha uma oferta VIVA dele. Os demais
 * motoristas com oferta desse pedido viram "perdedores" (TRIP_NO_LONGER_AVAILABLE)
 * e são liberados — ficam prontos para o próximo pedido no reconcile seguinte.
 *
 * Idempotência de rede: reenviar o mesmo aceite do MESMO vencedor devolve
 * ACCEPTED (sem perdedores novos). Aceite de qualquer outro → NO_LONGER_AVAILABLE.
 */
export function accept(
  state: EngineState,
  requestId: string,
  driverId: string
): { state: EngineState; outcome: AcceptOutcome } {
  const req = state.requests.find((r) => r.id === requestId);
  if (!req) {
    return { state, outcome: { result: 'TRIP_NO_LONGER_AVAILABLE', losers: [] } };
  }
  // Idempotente: mesmo vencedor reconfirma.
  if ((req.status === 'ACCEPTED' || req.status === 'ONGOING') && req.acceptedBy === driverId) {
    return { state, outcome: { result: 'ACCEPTED', losers: [] } };
  }
  const hadLiveOffer = req.status === 'OFFERING' && req.offers.some((o) => o.driverId === driverId);
  if (!hadLiveOffer || req.acceptedBy) {
    return { state, outcome: { result: 'TRIP_NO_LONGER_AVAILABLE', losers: [] } };
  }
  const losers = req.offers.map((o) => o.driverId).filter((id) => id !== driverId);
  const updated: TripRequest = { ...req, status: 'ACCEPTED', acceptedBy: driverId, offers: [] };
  return {
    state: { ...state, requests: state.requests.map((r) => (r.id === requestId ? updated : r)) },
    outcome: { result: 'ACCEPTED', losers },
  };
}

/**
 * Recusa (ou expiração) de um motorista sobre um pedido: remove a oferta viva
 * dele (fica registrado em offeredTo para não re-ofertar) e, se o pedido ficou
 * sem oferta viva, volta a MATCHING para o reconcile promover o próximo. Nunca
 * afeta outros pedidos.
 */
export function reject(state: EngineState, requestId: string, driverId: string): EngineState {
  const req = state.requests.find((r) => r.id === requestId);
  if (!req || req.status !== 'OFFERING') return state;
  if (!req.offers.some((o) => o.driverId === driverId)) return state;
  const offers = req.offers.filter((o) => o.driverId !== driverId);
  const offeredTo = req.offeredTo.includes(driverId) ? req.offeredTo : [...req.offeredTo, driverId];
  const updated: TripRequest = {
    ...req,
    offers,
    offeredTo,
    status: offers.length === 0 ? 'MATCHING' : 'OFFERING',
  };
  return { ...state, requests: state.requests.map((r) => (r.id === requestId ? updated : r)) };
}

/** Passageiro cancelou — pedido a estado terminal, liberando seus motoristas. */
export function cancel(state: EngineState, requestId: string): EngineState {
  const req = state.requests.find((r) => r.id === requestId);
  if (!req || TERMINAL.has(req.status)) return state;
  const updated: TripRequest = { ...req, status: 'CANCELLED', offers: [] };
  return { ...state, requests: state.requests.map((r) => (r.id === requestId ? updated : r)) };
}

/** Vencedor iniciou o deslocamento — ACCEPTED → ONGOING. */
export function startTrip(state: EngineState, requestId: string): EngineState {
  const req = state.requests.find((r) => r.id === requestId);
  if (!req || req.status !== 'ACCEPTED') return state;
  const updated: TripRequest = { ...req, status: 'ONGOING' };
  return { ...state, requests: state.requests.map((r) => (r.id === requestId ? updated : r)) };
}

/**
 * Remove um pedido do quadro ativo de dispatch (ex.: corrida concluída/cancelada
 * já persistida). Libera o motorista que estava nele para novos pedidos. O
 * histórico fica nas tabelas; o motor só carrega os pedidos vivos.
 */
export function removeRequest(state: EngineState, requestId: string): EngineState {
  if (!state.requests.some((r) => r.id === requestId)) return state;
  return { ...state, requests: state.requests.filter((r) => r.id !== requestId) };
}

// ─── Tick: expiração, expansão de raio, timeout global ───────────────────────

/**
 * Avança o relógio: (1) expira ofertas vencidas (equivale a recusa por timeout);
 * (2) se um pedido esgotou os candidatos do raio atual, EXPANDE o raio (até o
 * máximo); (3) se estourou o tempo global sem aceite, marca NO_DRIVERS; e por
 * fim (4) roda o reconcile para redistribuir. Puro e determinístico.
 */
export function tick(state: EngineState, drivers: DriverPosition[], now: number): EngineState {
  let s = state;
  let mutated = false;
  const reqs = s.requests.map((r) => {
    if (TERMINAL.has(r.status)) return r;

    // (3) timeout global.
    if (now - r.createdAt >= s.config.globalTimeoutMs && r.status !== 'ACCEPTED' && r.status !== 'ONGOING') {
      mutated = true;
      return { ...r, status: 'NO_DRIVERS' as TripStatus, offers: [] };
    }

    // (1) expira ofertas vencidas.
    const live = r.offers.filter((o) => o.expiresAt > now);
    const expired = r.offers.filter((o) => o.expiresAt <= now);
    let nr = r;
    if (expired.length > 0) {
      mutated = true;
      const offeredTo = [...r.offeredTo];
      for (const o of expired) if (!offeredTo.includes(o.driverId)) offeredTo.push(o.driverId);
      nr = {
        ...r,
        offers: live,
        offeredTo,
        status: live.length === 0 ? 'MATCHING' : r.status,
      };
    }

    // (2) expansão de raio: sem oferta viva e todos os candidatos do raio já
    // foram ofertados → cresce o raio (se ainda houver espaço).
    if (nr.offers.length === 0 && (nr.status === 'MATCHING' || nr.status === 'REQUESTED')) {
      const ranked = rankCandidates(nr.pickup, drivers, nr.radiusKm, s.config);
      const freshInRadius = ranked.some((c) => !nr.offeredTo.includes(c.driverId));
      if (!freshInRadius && nr.radiusKm < s.config.radiusMaxKm) {
        mutated = true;
        nr = { ...nr, radiusKm: Math.min(nr.radiusKm + s.config.radiusStepKm, s.config.radiusMaxKm) };
      }
    }
    return nr;
  });

  if (mutated) s = { ...s, requests: reqs };
  return reconcile(s, drivers, now);
}

// ─── Consultas ───────────────────────────────────────────────────────────────

/** A oferta que um motorista está vendo agora (para reconstrução no app). */
export function offerForDriver(state: EngineState, driverId: string): TripRequest | null {
  for (const r of state.requests) {
    if (r.status === 'OFFERING' && r.offers.some((o) => o.driverId === driverId)) return r;
  }
  return null;
}

export function getRequest(state: EngineState, requestId: string): TripRequest | undefined {
  return state.requests.find((r) => r.id === requestId);
}
