// driverPeriodMachine — máquina de estados PURA dos períodos legais de
// condução P0–P3 exigidos pela lei de TNC da Flórida (F.S. 627.748) e pelos
// underwriters do seguro comercial. Ver docs/telematics-spec.md (gerado após
// a implementação) para a especificação completa entregue ao broker.
//
//   P0_OFFLINE   — fora da rede (logout/app fechado) — sem cobertura TNC.
//   P1_AVAILABLE — online, sem corrida aceita — cobertura 50/100/25.
//   P2_ENROUTE   — corrida aceita, a caminho do embarque — cobertura US$1M.
//   P3_ONTRIP    — passageiro a bordo, até o último desembarque — US$1M.
//
// "Prearranged ride" (a lei) = P2 ∪ P3. A fronteira P1↔P2 é o evento de
// aceite ATÔMICO persistido pelo dispatcher (rides.accepted_at no fluxo
// legado hoje em produção; dispatch_events 'ACCEPTED' quando dispatch_engine_v2
// estiver ativo — ver src/hooks/useRide.ts `acceptRide`/`dispatchEngineCreate`).
//
// A fronteira P2↔P3 usa o evento "Passei buscar o passageiro" — a PRIMEIRA
// ação manual e explícita do motorista após o aceite (confirmada em
// DriverNavigateScreen.tsx, `handleNextPhasePress`→`handleNextPhase`, que
// chama `updateRideStatus(ride.id, 'in_progress')`). Decisão de produto
// registrada em 2026-07: reaproveitar esse evento existente (sem nova UI)
// em vez de criar uma confirmação de embarque dedicada ou geofence
// automático — ver changelog do Bloco 1 em docs/dispatch... (compliance).
//
// Eventos SEMPRE vêm do servidor (timestamp UTC do backend), nunca calculados
// só no cliente — replay determinístico por timestamp epoch, sobrevive a
// kill/reboot/troca de fuso (mesmo princípio de src/lib/dutyMovement.ts).
//
// Corrida encadeada: se TRIP_ACCEPTED(B) chega enquanto o motorista já está
// em P2/P3 de outra corrida (A), B fica ENFILEIRADA — o período não muda
// agora (o motorista ainda está fisicamente ocupado com A). Quando A termina
// (TRIP_COMPLETED/TRIP_CANCELLED), se havia fila, entra DIRETO em P2(B) —
// sem passar por P1 — porque o motorista já tinha aceite ativo.
//
// Isolado de React/RN de propósito: exercitável em teste unitário (base do
// seguro — precisão não negociável).

export type DriverPeriod = 'P0_OFFLINE' | 'P1_AVAILABLE' | 'P2_ENROUTE' | 'P3_ONTRIP';

export type DriverPeriodEventType =
  | 'WENT_ONLINE'
  | 'WENT_OFFLINE'
  | 'TRIP_ACCEPTED'
  | 'TRIP_BOARDED'
  | 'TRIP_COMPLETED'
  | 'TRIP_CANCELLED';

export interface DriverPeriodEvent {
  type: DriverPeriodEventType;
  /** Epoch ms UTC — horário do SERVIDOR, nunca do relógio do dispositivo. */
  atMs: number;
  /** Obrigatório para eventos TRIP_*. */
  tripId?: string;
  lat?: number | null;
  lng?: number | null;
}

export interface DriverPeriodState {
  period: DriverPeriod;
  /** Epoch ms de quando entrou no período atual (para acumular duração/milhagem). */
  since: number;
  /** Corrida "ocupando" P2/P3 agora, ou null em P0/P1. */
  currentTripId: string | null;
  /** Próxima corrida já aceita enquanto currentTripId ainda está ativo (encadeada). */
  queuedNextTripId: string | null;
}

export interface DriverPeriodTransition {
  from: DriverPeriod;
  to: DriverPeriod;
  atMs: number;
  tripId: string | null;
  /** 'went_online' | 'went_offline' | 'accepted' | 'boarded' | 'completed' | 'cancelled' | 'chained' */
  reason: string;
  lat: number | null;
  lng: number | null;
}

export function initialDriverPeriodState(nowMs: number): DriverPeriodState {
  return { period: 'P0_OFFLINE', since: nowMs, currentTripId: null, queuedNextTripId: null };
}

export interface DriverPeriodStepResult {
  state: DriverPeriodState;
  /** Transição de PERÍODO ocorrida neste passo (para gravar em driver_period_transitions), ou null. */
  transition: DriverPeriodTransition | null;
}

function enter(
  prev: DriverPeriodState,
  period: DriverPeriod,
  ev: DriverPeriodEvent,
  reason: string,
  tripId: string | null,
  patch: Partial<DriverPeriodState> = {},
): DriverPeriodStepResult {
  const state: DriverPeriodState = {
    ...prev,
    period,
    since: ev.atMs,
    currentTripId: tripId,
    ...patch,
  };
  return {
    state,
    transition: {
      from: prev.period,
      to: period,
      atMs: ev.atMs,
      tripId,
      reason,
      lat: ev.lat ?? null,
      lng: ev.lng ?? null,
    },
  };
}

const noop = (state: DriverPeriodState): DriverPeriodStepResult => ({ state, transition: null });

/**
 * Avança a máquina com um evento de servidor. Determinístico e idempotente a
 * replays fora de ordem/duplicados (eventos que não fazem sentido no estado
 * atual são ignorados silenciosamente — o chamador deve logar o evento bruto
 * de qualquer forma para auditoria, mesmo quando não gera transição de período).
 */
export function stepDriverPeriod(prev: DriverPeriodState, ev: DriverPeriodEvent): DriverPeriodStepResult {
  switch (ev.type) {
    case 'WENT_ONLINE': {
      if (prev.period !== 'P0_OFFLINE') return noop(prev); // já ativo — no-op
      return enter(prev, 'P1_AVAILABLE', ev, 'went_online', null);
    }

    case 'WENT_OFFLINE': {
      if (prev.period === 'P0_OFFLINE') return noop(prev);
      // Anomalia se havia corrida ativa (P2/P3) — grava mesmo assim; a
      // investigação de por que ficou offline em corrida cabe ao consumidor
      // do log (ex.: kill do app), não a esta máquina.
      return enter(prev, 'P0_OFFLINE', ev, 'went_offline', null, { queuedNextTripId: null });
    }

    case 'TRIP_ACCEPTED': {
      const tripId = ev.tripId ?? null;
      if (!tripId || tripId === prev.currentTripId || tripId === prev.queuedNextTripId) {
        return noop(prev); // sem trip / duplicado / replay
      }
      if (prev.currentTripId === null) {
        // P0 ou P1 sem ocupação: aceite entra direto em P2. (Aceite estando
        // em P0 é uma anomalia de dados — dispatcher só oferece a quem está
        // online — mas tratamos igual: o evento de aceite manda.)
        return enter(prev, 'P2_ENROUTE', ev, 'accepted', tripId);
      }
      // Já ocupado com outra corrida (P2/P3): enfileira, período não muda.
      return { state: { ...prev, queuedNextTripId: tripId }, transition: null };
    }

    case 'TRIP_BOARDED': {
      const tripId = ev.tripId ?? null;
      if (!tripId || tripId !== prev.currentTripId || prev.period !== 'P2_ENROUTE') {
        return noop(prev); // fora de ordem/duplicado/corrida errada — ignora
      }
      return enter(prev, 'P3_ONTRIP', ev, 'boarded', tripId);
    }

    case 'TRIP_COMPLETED':
    case 'TRIP_CANCELLED': {
      const tripId = ev.tripId ?? null;
      if (!tripId || tripId !== prev.currentTripId) return noop(prev); // não é a corrida atual
      const reason = ev.type === 'TRIP_COMPLETED' ? 'completed' : 'cancelled';
      if (prev.queuedNextTripId) {
        // Encadeada: pula P1, entra direto em P2 da próxima corrida.
        return enter(prev, 'P2_ENROUTE', ev, 'chained', prev.queuedNextTripId, { queuedNextTripId: null });
      }
      return enter(prev, 'P1_AVAILABLE', ev, reason, null);
    }

    default:
      return noop(prev);
  }
}

// ─── Serialização (persistência local, espelha o padrão de dutyMovement.ts) ──

export function serializeDriverPeriod(s: DriverPeriodState): string {
  return JSON.stringify(s);
}

export function deserializeDriverPeriod(raw: string | null | undefined): DriverPeriodState | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<DriverPeriodState>;
    if (typeof o?.period !== 'string' || typeof o?.since !== 'number') return null;
    return {
      period: o.period as DriverPeriod,
      since: o.since,
      currentTripId: o.currentTripId ?? null,
      queuedNextTripId: o.queuedNextTripId ?? null,
    };
  } catch {
    return null;
  }
}

// ─── Milhagem por período (acumulador separado, ver driverPeriodMileage.ts) ──
// Mantido em módulo próprio para não acoplar o cálculo de distância GPS
// (impuro por natureza — depende de filtros anti-drift/roteamento) a esta
// máquina de estados discreta. Ver src/lib/driverPeriodMileage.ts.
