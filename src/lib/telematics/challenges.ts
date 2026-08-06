// Desafios de direção segura (gamificação estilo "Safe driving challenges" da
// Uber). PURO: derivado apenas do histórico de sessões — sem estado extra no
// banco. Cada desafio é uma janela ROLANTE das últimas N viagens; a viagem
// "passa" no desafio quando não teve o evento correspondente.

import type { TelematicsEventType } from './scorer';

/** Nota mínima para uma viagem contar como "viagem segura" no mês. */
export const SAFE_TRIP_SCORE = 90;
/** Tamanho da janela (viagens) de cada desafio rolante. */
export const CHALLENGE_TARGET = 10;

export type ChallengeKey = 'speed_limit' | 'smooth_brake' | 'smooth_accel' | 'smooth_corner';

/** Sessão mínima consumida pelos desafios (subconjunto da linha do banco). */
export interface ChallengeSession {
  score: number;
  speeding_count: number;
  hard_brake_count: number;
  hard_accel_count: number;
  hard_corner_count: number;
  /** ISO 8601; usado para o contador mensal. */
  ended_at: string | null;
}

export type SlotState = 'ok' | 'fail' | 'pending';

export interface ChallengeProgress {
  key: ChallengeKey;
  /** Tipo de evento que "quebra" a viagem neste desafio. */
  eventType: TelematicsEventType;
  target: number;
  /** Viagens já dirigidas dentro da janela (≤ target). */
  done: number;
  /** Viagens que ainda faltam dirigir para fechar a janela. */
  remaining: number;
  /** Quantas das viagens da janela tiveram o evento (falharam). */
  fails: number;
  /** true quando a janela está cheia e sem nenhuma falha (streak limpa). */
  completed: boolean;
  /** Marcadores da esquerda (mais antiga) p/ direita (mais nova), padded com 'pending'. */
  slots: SlotState[];
}

const COUNT_KEY: Record<ChallengeKey, keyof ChallengeSession> = {
  speed_limit: 'speeding_count',
  smooth_brake: 'hard_brake_count',
  smooth_accel: 'hard_accel_count',
  smooth_corner: 'hard_corner_count',
};

const EVENT_OF: Record<ChallengeKey, TelematicsEventType> = {
  speed_limit: 'speeding',
  smooth_brake: 'hard_brake',
  smooth_accel: 'hard_accel',
  smooth_corner: 'hard_corner',
};

const ALL_KEYS: ChallengeKey[] = ['speed_limit', 'smooth_brake', 'smooth_accel', 'smooth_corner'];

function progressFor(key: ChallengeKey, sessionsNewestFirst: ChallengeSession[], target: number): ChallengeProgress {
  const countKey = COUNT_KEY[key];
  const window = sessionsNewestFirst.slice(0, target);
  const done = window.length;
  const remaining = Math.max(0, target - done);

  // Da mais antiga p/ a mais nova (visual de esteira, como no app da Uber).
  const driven: SlotState[] = window
    .slice()
    .reverse()
    .map((s) => ((s[countKey] as number) > 0 ? 'fail' : 'ok'));
  const fails = driven.filter((s) => s === 'fail').length;
  const slots: SlotState[] = [...driven, ...Array<SlotState>(remaining).fill('pending')];

  return {
    key,
    eventType: EVENT_OF[key],
    target,
    done,
    remaining,
    fails,
    completed: done >= target && fails === 0,
    slots,
  };
}

function sameMonth(iso: string | null, now: Date): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
}

export interface ChallengesResult {
  /** Viagens seguras (score ≥ SAFE_TRIP_SCORE) concluídas no mês corrente. */
  safeTripsThisMonth: number;
  challenges: ChallengeProgress[];
}

/**
 * Calcula os desafios a partir do histórico. `sessions` deve vir da mais RECENTE
 * para a mais antiga (ordem natural da consulta). `now` injeta a data (testável).
 */
export function computeChallenges(
  sessions: ChallengeSession[],
  now: Date = new Date(),
  target: number = CHALLENGE_TARGET,
): ChallengesResult {
  const safeTripsThisMonth = sessions.filter(
    (s) => sameMonth(s.ended_at, now) && s.score >= SAFE_TRIP_SCORE,
  ).length;
  return {
    safeTripsThisMonth,
    challenges: ALL_KEYS.map((k) => progressFor(k, sessions, target)),
  };
}
