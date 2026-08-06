// drivingLimits — cálculo puro do limite de direção do motorista (P3).
//
// Regra (configurável por jurisdição): após acumular `limitHours` de direção,
// o motorista precisa de `restHours` de descanso CONTÍNUO antes de voltar. Um
// intervalo off-duty >= restHours zera o acúmulo (novo "turno"). Intervalos
// curtos não zeram — a direção continua somando através deles.
//
// Contagem POR MOVIMENTO (item 1): o tempo de direção só deve contar com o
// veículo em movimento. Uma parada curta (semáforo, embarque rápido) NÃO pausa
// a contagem; só quando o veículo fica parado por MAIS de `idlePauseMinutes`
// (padrão 10) é que o excedente deixa de contar — e volta a contar assim que o
// veículo se move de novo. Modelamos isso com "segmentos ociosos" (períodos
// parado) que subtraem do acúmulo apenas o tempo ALÉM da tolerância de cada
// parada: excedente = Σ max(0, duração_da_parada − idlePauseMinutes).
//
// Isolado de React/RN de propósito: toda a matemática vive aqui, testável sem
// montar componente. Convenção de segurança: sobrecontar (ex.: sessão aberta
// com app morto online, ou ociosidade perdida por reinício do app) só antecipa
// o descanso — o lado seguro para compliance.

export type DutySession = { started_at: string; ended_at: string | null };

/** Período em que o veículo ficou PARADO (fim null = ainda parado "agora"). */
export type IdleSegment = { start: string; end: string | null };

export type DutyLimitConfig = {
  limitHours: number;
  restHours: number;
  /**
   * Tolerância (min) de parada antes de a contagem pausar. Paradas <= a este
   * valor contam integralmente; o que passar disso, em cada parada, é excluído.
   * Ausente/0 → comportamento antigo (nada é excluído).
   */
  idlePauseMinutes?: number;
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
  now: Date = new Date(),
  idleSegments: IdleSegment[] = [],
  /**
   * Bloco 2 (rollout `duty_movement_v2_enabled`): quando fornecido (número), os
   * minutos de direção acumulados vêm da máquina de estados por MOVIMENTO
   * (persistida por timestamps, sobrevive a kill/reboot) em vez do cálculo v1
   * "sessão − ociosidade excedente". É a fonte autoritativa da contagem; o resto
   * do status (online, âncora do descanso via lastDutyEnd) segue vindo das
   * sessões. `null`/ausente → mantém o comportamento v1 (padrão).
   */
  movementMinutes: number | null = null
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

  // Item 1 — desconta a ociosidade EXCEDENTE (tempo parado além da tolerância
  // de cada parada). Só faz sentido enquanto há acúmulo (accMin > 0): se o turno
  // já foi zerado por descanso qualificado, não há o que descontar. Cada parada
  // contribui max(0, duração − idlePauseMinutes); paradas curtas contam inteiras.
  const graceMin = cfg.idlePauseMinutes ?? 0;
  if (accMin > 0 && idleSegments.length > 0) {
    let excludedMin = 0;
    for (const seg of idleSegments) {
      const start = new Date(seg.start).getTime();
      const end = seg.end ? new Date(seg.end).getTime() : nowMs;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const durMin = (end - start) / 60_000;
      excludedMin += Math.max(0, durMin - graceMin);
    }
    accMin = Math.max(0, accMin - excludedMin);
  }

  // Bloco 2: se a contagem por MOVIMENTO está ativa, ela é autoritativa e
  // substitui o acúmulo v1 (sessão − ociosidade). Mantemos lastDutyEnd/online
  // das sessões para ancorar o restUntil e o rótulo online.
  if (movementMinutes != null && Number.isFinite(movementMinutes)) {
    accMin = Math.max(0, movementMinutes);
    // Segurança (evita "amanhecer bloqueado"): um descanso offline já
    // qualificado — offline há >= restMin desde a última atividade — ZERA o
    // acúmulo imediatamente, mesmo que a máquina por movimento ainda não tenha
    // reciclado (ex.: no cold-start, antes do 1º sample rodar). O lado seguro é
    // liberar quem já descansou o suficiente.
    if (!online && lastDutyEnd != null && (nowMs - lastDutyEnd) / 60_000 >= restMin) {
      accMin = 0;
    }
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
