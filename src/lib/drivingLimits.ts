// drivingLimits — cálculo puro do limite de direção do motorista (P3).
//
// Regra (configurável por jurisdição): após acumular `limitHours` de direção,
// o motorista precisa de `restHours` de descanso CONTÍNUO antes de voltar. Um
// intervalo off-duty >= restHours zera o acúmulo (novo "turno"). Intervalos
// curtos não zeram — a direção continua somando através deles.
//
// Isolado de React/RN de propósito: toda a matemática vive aqui, testável sem
// montar componente. Convenção de segurança: sobrecontar (ex.: sessão aberta
// com app morto online) só antecipa o descanso — o lado seguro para compliance.

export type DutySession = { started_at: string; ended_at: string | null };

export type DutyLimitConfig = {
  limitHours: number;
  restHours: number;
};

export type DutyStatus = {
  /** Há uma sessão aberta (motorista online)? */
  online: boolean;
  /** Minutos de direção acumulados desde o último descanso qualificado. */
  accumulatedMinutes: number;
  /** Minutos restantes até o limite (0 se já estourou). */
  remainingMinutes: number;
  /** Atingiu o limite e ainda não descansou o suficiente? */
  mustRest: boolean;
  /** Quando poderá voltar a dirigir (se mustRest), senão null. */
  restUntil: Date | null;
  /** Fim da última atividade (ou "agora" se online), senão null. */
  lastDutyEnd: Date | null;
};

export function computeDutyStatus(
  sessions: DutySession[],
  cfg: DutyLimitConfig,
  now: Date = new Date()
): DutyStatus {
  const limitMin = cfg.limitHours * 60;
  const restMin = cfg.restHours * 60;
  const nowMs = now.getTime();

  // Normaliza em segmentos [start, end]; sessão aberta termina "agora".
  const segments = sessions
    .map((s) => ({
      start: new Date(s.started_at).getTime(),
      end: s.ended_at ? new Date(s.ended_at).getTime() : nowMs,
    }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end >= s.start)
    .sort((a, b) => a.start - b.start);

  const online = sessions.some((s) => !s.ended_at);

  let accMin = 0;
  let prevEnd: number | null = null;
  let lastDutyEnd: number | null = null;

  for (const seg of segments) {
    if (prevEnd != null) {
      const gapMin = (seg.start - prevEnd) / 60_000;
      if (gapMin >= restMin) accMin = 0; // descanso qualificado zera o acúmulo
    }
    accMin += (seg.end - seg.start) / 60_000;
    prevEnd = seg.end;
    lastDutyEnd = seg.end;
  }

  // Descanso em curso (offline) que já satisfez o mínimo também zera.
  if (!online && lastDutyEnd != null) {
    const offDutyMin = (nowMs - lastDutyEnd) / 60_000;
    if (offDutyMin >= restMin) accMin = 0;
  }

  const mustRest = accMin >= limitMin;
  const remainingMinutes = Math.max(0, limitMin - accMin);
  const restUntil = mustRest && lastDutyEnd != null ? new Date(lastDutyEnd + restMin * 60_000) : null;

  return {
    online,
    accumulatedMinutes: accMin,
    remainingMinutes,
    mustRest,
    restUntil,
    lastDutyEnd: lastDutyEnd != null ? new Date(lastDutyEnd) : null,
  };
}

/** Formata minutos como "2h 05min" / "45min" / "0min". */
export function formatHm(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '0min';
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m.toString().padStart(2, '0')}min`;
}
