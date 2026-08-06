// Telemetria de direção — DETECÇÃO DE EVENTOS + PONTUAÇÃO (núcleo PURO).
//
// Espelha o modelo da Uber (Cambridge Mobile Telematics): a partir de um fluxo
// de fixes de GPS (posição, velocidade e rumo), detecta os quatro eventos de
// risco que a Uber pontua e converte a viagem numa nota de 0–100:
//
//   • Excesso de velocidade (speeding)
//   • Freada brusca         (hard_brake)     — desaceleração longitudinal
//   • Aceleração brusca     (hard_accel)     — aceleração longitudinal
//   • Curva brusca          (hard_corner)    — aceleração LATERAL (v · taxa de guinada)
//
// Isolado de React/RN/Supabase de propósito: 100% determinístico e exercitável
// em teste unitário (ver __tests__/telematics.test.ts). O acumulador de sessão
// (cooldown, tally, distância) vive em session.ts; aqui ficam a física e a nota.

export type TelematicsEventType = 'speeding' | 'hard_brake' | 'hard_accel' | 'hard_corner';
export type TelematicsSeverity = 'normal' | 'severe';

/** Um fix de GPS já validado, pronto para alimentar o detector. */
export interface TelematicsSample {
  /** Epoch (ms) do fix. */
  atMs: number;
  lat: number;
  lng: number;
  /** Velocidade instantânea (m/s, ≥ 0). */
  speedMps: number;
  /** Rumo (graus, 0 = norte); ruidoso em baixa velocidade — só usado > cornerMinSpeed. */
  headingDeg: number;
  /** Precisão horizontal (m); fixes acima de maxAccuracyM são descartados. */
  accuracyM?: number;
  /** Limite da via (km/h), se conhecido; ausente → usa o teto absoluto. */
  speedLimitKmh?: number | null;
}

export interface DetectedEvent {
  type: TelematicsEventType;
  severity: TelematicsSeverity;
  atMs: number;
  lat: number;
  lng: number;
  speedKmh: number;
}

export interface TelematicsConfig {
  /** Desaceleração (m/s²) que caracteriza freada brusca. */
  hardBrakeMps2: number;
  severeBrakeMps2: number;
  /** Aceleração (m/s²) que caracteriza arrancada brusca. */
  hardAccelMps2: number;
  severeAccelMps2: number;
  /** Aceleração LATERAL (m/s²) que caracteriza curva brusca. */
  hardCornerMps2: number;
  severeCornerMps2: number;
  /** Velocidade mínima (m/s) para avaliar curva (rumo do GPS é ruído abaixo disso). */
  cornerMinSpeedMps: number;
  /** Tolerância (km/h) somada ao limite da via antes de marcar excesso. */
  speedMarginKmh: number;
  /** Teto absoluto (km/h) quando não há limite por via — evita falso positivo. */
  hardSpeedCapKmh: number;
  /** Aceleração longitudinal acima disto (m/s²) é ruído de GPS → ignorada. */
  noiseAccelMps2: number;
  /** Precisão pior que isto (m) → fix descartado. */
  maxAccuracyM: number;
  /** Intervalo entre fixes maior que isto (ms) → não deriva dinâmica (só distância). */
  maxDtMs: number;
}

export const DEFAULT_TELEMATICS_CONFIG: TelematicsConfig = {
  hardBrakeMps2: 3.0,   // ≈ 0.31 g
  severeBrakeMps2: 4.5, // ≈ 0.46 g
  hardAccelMps2: 3.0,
  severeAccelMps2: 4.5,
  hardCornerMps2: 3.5,
  severeCornerMps2: 5.5,
  cornerMinSpeedMps: 5, // ≈ 18 km/h
  speedMarginKmh: 8,
  hardSpeedCapKmh: 120, // ≈ 75 mph
  noiseAccelMps2: 11,   // ≈ 1.1 g — acima disto é salto de GPS
  maxAccuracyM: 30,
  maxDtMs: 6000,
};

/** Penalidade (pontos) subtraída da nota da viagem por evento, por severidade. */
export const EVENT_PENALTY: Record<TelematicsEventType, Record<TelematicsSeverity, number>> = {
  speeding:    { normal: 5, severe: 9 },
  hard_brake:  { normal: 4, severe: 7 },
  hard_accel:  { normal: 3, severe: 5 },
  hard_corner: { normal: 3, severe: 5 },
};

const KMH_PER_MPS = 3.6;
const EARTH_RADIUS_M = 6_371_000;

/** Menor diferença angular assinada (graus) de a→b, no intervalo [-180, 180]. */
function angleDiffDeg(a: number, b: number): number {
  return ((b - a + 540) % 360) - 180;
}

/** Distância em km entre dois pontos (haversine). */
export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const lat1 = (aLat * Math.PI) / 180;
  const lat2 = (bLat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return (2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))) / 1000;
}

export interface StepAnalysis {
  /** Eventos CANDIDATOS deste passo (antes do cooldown, aplicado no acumulador). */
  events: DetectedEvent[];
  /** Distância (km) percorrida entre os dois fixes. */
  distanceKm: number;
  /** Intervalo (ms) entre os fixes. */
  dtMs: number;
  /** true se um fix foi descartado por precisão/tempo (dinâmica não avaliada). */
  discarded: boolean;
}

/**
 * Analisa o passo entre dois fixes consecutivos: deriva aceleração longitudinal,
 * aceleração lateral (curva) e checa excesso de velocidade. Devolve os eventos
 * candidatos e a distância. NÃO aplica cooldown nem acumula — isso é do
 * acumulador de sessão (session.ts), que tem o estado temporal.
 */
export function analyzeStep(
  prev: TelematicsSample,
  cur: TelematicsSample,
  cfg: TelematicsConfig = DEFAULT_TELEMATICS_CONFIG,
): StepAnalysis {
  const dtMs = cur.atMs - prev.atMs;
  const events: DetectedEvent[] = [];

  // Fix ruim (precisão) → descarta o passo inteiro (posição e dinâmica não confiáveis).
  const badFix =
    (cur.accuracyM != null && cur.accuracyM > cfg.maxAccuracyM) ||
    (prev.accuracyM != null && prev.accuracyM > cfg.maxAccuracyM);
  if (badFix || dtMs <= 0) {
    return { events, distanceKm: 0, dtMs, discarded: true };
  }

  const distanceKm = haversineKm(prev.lat, prev.lng, cur.lat, cur.lng);

  // Gap grande (app em background, GPS perdido): conta distância mas NÃO deriva
  // aceleração/curva (a variação num salto de vários segundos não é um evento).
  const dynamicsOk = dtMs <= cfg.maxDtMs;
  const speedKmh = cur.speedMps * KMH_PER_MPS;

  // ── Excesso de velocidade (não depende de dt) ──────────────────────────────
  const limit = cur.speedLimitKmh != null && cur.speedLimitKmh > 0 ? cur.speedLimitKmh : null;
  const speedThreshold = limit != null ? limit + cfg.speedMarginKmh : cfg.hardSpeedCapKmh;
  if (speedKmh > speedThreshold) {
    const over = speedKmh - speedThreshold;
    events.push({
      type: 'speeding',
      severity: over > 20 ? 'severe' : 'normal',
      atMs: cur.atMs,
      lat: cur.lat,
      lng: cur.lng,
      speedKmh,
    });
  }

  if (dynamicsOk) {
    const dt = dtMs / 1000;

    // ── Aceleração / freada longitudinal ────────────────────────────────────
    const accel = (cur.speedMps - prev.speedMps) / dt; // + acelera, − freia
    if (Math.abs(accel) <= cfg.noiseAccelMps2) {
      if (accel <= -cfg.hardBrakeMps2) {
        events.push({
          type: 'hard_brake',
          severity: accel <= -cfg.severeBrakeMps2 ? 'severe' : 'normal',
          atMs: cur.atMs, lat: cur.lat, lng: cur.lng, speedKmh,
        });
      } else if (accel >= cfg.hardAccelMps2) {
        events.push({
          type: 'hard_accel',
          severity: accel >= cfg.severeAccelMps2 ? 'severe' : 'normal',
          atMs: cur.atMs, lat: cur.lat, lng: cur.lng, speedKmh,
        });
      }
    }

    // ── Curva brusca (aceleração lateral = v · taxa de guinada) ──────────────
    if (cur.speedMps > cfg.cornerMinSpeedMps && prev.speedMps > cfg.cornerMinSpeedMps) {
      const yawRateRad = Math.abs((angleDiffDeg(prev.headingDeg, cur.headingDeg) * Math.PI) / 180) / dt;
      const lateral = cur.speedMps * yawRateRad;
      if (lateral >= cfg.hardCornerMps2 && lateral <= cfg.noiseAccelMps2 * 2) {
        events.push({
          type: 'hard_corner',
          severity: lateral >= cfg.severeCornerMps2 ? 'severe' : 'normal',
          atMs: cur.atMs, lat: cur.lat, lng: cur.lng, speedKmh,
        });
      }
    }
  }

  return { events, distanceKm, dtMs, discarded: false };
}

/** Contagem de eventos por tipo numa sessão. */
export type EventCounts = Record<TelematicsEventType, number>;

export function emptyCounts(): EventCounts {
  return { speeding: 0, hard_brake: 0, hard_accel: 0, hard_corner: 0 };
}

/** Nota da viagem (0–100) a partir da penalidade total acumulada. */
export function tripScoreFromPenalty(penalty: number): number {
  return Math.max(0, Math.min(100, Math.round(100 - penalty)));
}

/** Nota da viagem (0–100) a partir das contagens (todas tratadas como 'normal'). */
export function tripScoreFromCounts(counts: EventCounts): number {
  let penalty = 0;
  (Object.keys(counts) as TelematicsEventType[]).forEach((type) => {
    penalty += counts[type] * EVENT_PENALTY[type].normal;
  });
  return tripScoreFromPenalty(penalty);
}

export type ScoreCategory = 'great' | 'good' | 'fair' | 'poor';

/** Faixa qualitativa da nota — marcas de 75 e 85 como no painel da Uber. */
export function scoreCategory(score: number): ScoreCategory {
  if (score >= 85) return 'great';
  if (score >= 75) return 'good';
  if (score >= 60) return 'fair';
  return 'poor';
}

/** Sessão mínima para o cálculo da nota geral (subconjunto da linha do banco). */
export interface ScoredSession {
  score: number;
  distance_km: number;
}

/**
 * Nota GERAL do motorista — média das últimas `window` viagens ponderada pela
 * distância (viagens mais longas pesam mais, como o "últimas 50 viagens" da
 * Uber). Devolve null quando não há viagens. As sessões devem vir da mais
 * recente para a mais antiga (a janela pega as `window` primeiras).
 */
export function overallScore(sessions: ScoredSession[], window = 50): number | null {
  const slice = sessions.slice(0, window);
  if (slice.length === 0) return null;
  let weighted = 0;
  let totalWeight = 0;
  for (const s of slice) {
    const w = Math.max(s.distance_km, 0.1); // piso p/ não zerar viagens curtíssimas
    weighted += s.score * w;
    totalWeight += w;
  }
  if (totalWeight === 0) return Math.round(slice.reduce((a, s) => a + s.score, 0) / slice.length);
  return Math.round(weighted / totalWeight);
}
