// Acumulador de SESSÃO de telemetria (uma corrida, do aceite ao encerramento).
//
// Estado puro e serializável (sobrevive a kill/reboot via AsyncStorage, como o
// dutyMovement). Consome fixes de GPS, aplica o detector puro (scorer.ts), o
// COOLDOWN por tipo (para não contar o mesmo evento repetidas vezes) e mantém a
// nota da viagem, as contagens, a distância e a duração. Sem React/RN/Supabase.

import {
  analyzeStep,
  emptyCounts,
  tripScoreFromPenalty,
  EVENT_PENALTY,
  DEFAULT_TELEMATICS_CONFIG,
  type DetectedEvent,
  type EventCounts,
  type TelematicsConfig,
  type TelematicsEventType,
  type TelematicsSample,
} from './scorer';

/** Quanto tempo (ms) suprimir novos eventos do MESMO tipo após um disparo. */
const EVENT_COOLDOWN_MS = 4000;
/** Teto de eventos guardados para gravar no banco (a contagem segue exata). */
const MAX_STORED_EVENTS = 300;

export interface SessionSnapshot {
  driverId: string;
  rideId: string | null;
  startedAtMs: number;
  /** Epoch do último fix processado (usado como fim ao encerrar). */
  lastAtMs: number;
  distanceKm: number;
  durationMin: number;
  sampleCount: number;
  score: number;
  counts: EventCounts;
  events: DetectedEvent[];
}

interface PersistState extends SessionSnapshot {
  penalty: number;
  lastEventAtMs: Record<TelematicsEventType, number>;
  lastSample: TelematicsSample | null;
}

/**
 * Sessão viva de telemetria. Crie no ACEITE (`new TripTelematics(driverId,
 * rideId, nowMs)`), alimente com `ingest(sample)` a cada fix e leia `snapshot()`
 * ao ENCERRAR para gravar. `serialize()`/`deserialize()` persistem entre kills.
 */
export class TripTelematics {
  private cfg: TelematicsConfig;
  private driverId: string;
  private rideId: string | null;
  private startedAtMs: number;
  private lastAtMs: number;
  private distanceKm = 0;
  private durationMs = 0;
  private sampleCount = 0;
  private penalty = 0;
  private counts: EventCounts = emptyCounts();
  private lastEventAtMs: Record<TelematicsEventType, number> = {
    speeding: -Infinity, hard_brake: -Infinity, hard_accel: -Infinity, hard_corner: -Infinity,
  };
  private lastSample: TelematicsSample | null = null;
  private events: DetectedEvent[] = [];

  constructor(driverId: string, rideId: string | null, startedAtMs: number, cfg: TelematicsConfig = DEFAULT_TELEMATICS_CONFIG) {
    this.driverId = driverId;
    this.rideId = rideId;
    this.startedAtMs = startedAtMs;
    this.lastAtMs = startedAtMs;
    this.cfg = cfg;
  }

  /** Processa um fix; devolve os eventos CONFIRMADOS (após cooldown) neste passo. */
  ingest(sample: TelematicsSample): DetectedEvent[] {
    this.sampleCount += 1;
    this.lastAtMs = sample.atMs;
    this.durationMs = Math.max(0, sample.atMs - this.startedAtMs);

    const prev = this.lastSample;
    this.lastSample = sample;
    if (!prev) return [];

    const { events, distanceKm, discarded } = analyzeStep(prev, sample, this.cfg);
    if (discarded) {
      // Fix ruim: não deixa ele virar o "anterior" (evita derivar dinâmica falsa
      // no próximo passo a partir de uma posição não confiável).
      this.lastSample = prev;
      this.sampleCount -= 1;
      return [];
    }
    this.distanceKm += distanceKm;

    const confirmed: DetectedEvent[] = [];
    for (const ev of events) {
      if (ev.atMs - this.lastEventAtMs[ev.type] < EVENT_COOLDOWN_MS) continue; // cooldown
      this.lastEventAtMs[ev.type] = ev.atMs;
      this.counts[ev.type] += 1;
      this.penalty += EVENT_PENALTY[ev.type][ev.severity];
      if (this.events.length < MAX_STORED_EVENTS) this.events.push(ev);
      confirmed.push(ev);
    }
    return confirmed;
  }

  snapshot(): SessionSnapshot {
    return {
      driverId: this.driverId,
      rideId: this.rideId,
      startedAtMs: this.startedAtMs,
      lastAtMs: this.lastAtMs,
      distanceKm: Math.round(this.distanceKm * 1000) / 1000,
      durationMin: Math.round((this.durationMs / 60000) * 100) / 100,
      sampleCount: this.sampleCount,
      score: tripScoreFromPenalty(this.penalty),
      counts: { ...this.counts },
      events: [...this.events],
    };
  }

  get id(): string | null {
    return this.rideId;
  }

  serialize(): string {
    const state: PersistState = {
      ...this.snapshot(),
      penalty: this.penalty,
      lastEventAtMs: { ...this.lastEventAtMs },
      lastSample: this.lastSample,
    };
    return JSON.stringify(state);
  }

  static deserialize(raw: string | null | undefined, cfg: TelematicsConfig = DEFAULT_TELEMATICS_CONFIG): TripTelematics | null {
    if (!raw) return null;
    try {
      const s = JSON.parse(raw) as Partial<PersistState>;
      if (typeof s?.driverId !== 'string' || typeof s?.startedAtMs !== 'number') return null;
      const t = new TripTelematics(s.driverId, s.rideId ?? null, s.startedAtMs, cfg);
      t.lastAtMs = s.lastAtMs ?? s.startedAtMs;
      t.distanceKm = s.distanceKm ?? 0;
      t.durationMs = Math.max(0, (t.lastAtMs - s.startedAtMs));
      t.sampleCount = s.sampleCount ?? 0;
      t.penalty = s.penalty ?? 0;
      t.counts = { ...emptyCounts(), ...(s.counts ?? {}) };
      t.lastEventAtMs = {
        speeding: s.lastEventAtMs?.speeding ?? -Infinity,
        hard_brake: s.lastEventAtMs?.hard_brake ?? -Infinity,
        hard_accel: s.lastEventAtMs?.hard_accel ?? -Infinity,
        hard_corner: s.lastEventAtMs?.hard_corner ?? -Infinity,
      };
      t.lastSample = s.lastSample ?? null;
      t.events = Array.isArray(s.events) ? s.events.slice(0, MAX_STORED_EVENTS) : [];
      return t;
    } catch {
      return null;
    }
  }
}
