import {
  initialDriverPeriodState,
  stepDriverPeriod,
  serializeDriverPeriod,
  deserializeDriverPeriod,
  type DriverPeriodState,
  type DriverPeriodEvent,
} from '../driverPeriodMachine';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Aplica uma sequência de eventos e devolve o estado final + transições emitidas. */
function run(events: DriverPeriodEvent[], startAtMs = events[0]?.atMs ?? 0) {
  let s = initialDriverPeriodState(startAtMs);
  const transitions: string[] = [];
  for (const ev of events) {
    const { state, transition } = stepDriverPeriod(s, ev);
    s = state;
    if (transition) transitions.push(`${transition.from}->${transition.to}(${transition.reason})`);
  }
  return { state: s, transitions };
}

describe('driverPeriodMachine — dia completo (P0→P1→P2→P3→P1→P0)', () => {
  it('login → aceite → embarque → conclusão → logout: transições exatas', () => {
    const { state, transitions } = run([
      { type: 'WENT_ONLINE', atMs: 0 },
      { type: 'TRIP_ACCEPTED', atMs: 5 * MIN, tripId: 'A' },
      { type: 'TRIP_BOARDED', atMs: 12 * MIN, tripId: 'A' },
      { type: 'TRIP_COMPLETED', atMs: 30 * MIN, tripId: 'A' },
      { type: 'WENT_OFFLINE', atMs: 40 * MIN },
    ]);
    expect(transitions).toEqual([
      'P0_OFFLINE->P1_AVAILABLE(went_online)',
      'P1_AVAILABLE->P2_ENROUTE(accepted)',
      'P2_ENROUTE->P3_ONTRIP(boarded)',
      'P3_ONTRIP->P1_AVAILABLE(completed)',
      'P1_AVAILABLE->P0_OFFLINE(went_offline)',
    ]);
    expect(state.period).toBe('P0_OFFLINE');
    expect(state.currentTripId).toBeNull();
  });

  it('3 corridas sequenciais (sem encadeamento): sempre volta a P1 entre corridas', () => {
    const { transitions } = run([
      { type: 'WENT_ONLINE', atMs: 0 },
      { type: 'TRIP_ACCEPTED', atMs: 1 * MIN, tripId: 'A' },
      { type: 'TRIP_BOARDED', atMs: 2 * MIN, tripId: 'A' },
      { type: 'TRIP_COMPLETED', atMs: 3 * MIN, tripId: 'A' },
      { type: 'TRIP_ACCEPTED', atMs: 4 * MIN, tripId: 'B' },
      { type: 'TRIP_BOARDED', atMs: 5 * MIN, tripId: 'B' },
      { type: 'TRIP_COMPLETED', atMs: 6 * MIN, tripId: 'B' },
      { type: 'TRIP_ACCEPTED', atMs: 7 * MIN, tripId: 'C' },
      { type: 'TRIP_BOARDED', atMs: 8 * MIN, tripId: 'C' },
      { type: 'TRIP_COMPLETED', atMs: 9 * MIN, tripId: 'C' },
    ]);
    const p1Entries = transitions.filter((t) => t.endsWith('->P1_AVAILABLE(completed)') || t.includes('went_online'));
    expect(p1Entries).toHaveLength(4); // login + 3 conclusões
  });
});

describe('driverPeriodMachine — corrida encadeada', () => {
  it('aceita B ainda em P3 de A → ao completar A, pula P1 e entra direto em P2(B)', () => {
    const { state, transitions } = run([
      { type: 'WENT_ONLINE', atMs: 0 },
      { type: 'TRIP_ACCEPTED', atMs: 1 * MIN, tripId: 'A' },
      { type: 'TRIP_BOARDED', atMs: 2 * MIN, tripId: 'A' },
      { type: 'TRIP_ACCEPTED', atMs: 10 * MIN, tripId: 'B' }, // aceite de B enquanto ainda em P3(A)
      { type: 'TRIP_COMPLETED', atMs: 20 * MIN, tripId: 'A' },
    ]);
    expect(transitions).toEqual([
      'P0_OFFLINE->P1_AVAILABLE(went_online)',
      'P1_AVAILABLE->P2_ENROUTE(accepted)',
      'P2_ENROUTE->P3_ONTRIP(boarded)',
      // aceite de B não gera transição — fica enfileirado
      'P3_ONTRIP->P2_ENROUTE(chained)',
    ]);
    expect(state.period).toBe('P2_ENROUTE');
    expect(state.currentTripId).toBe('B');
    expect(state.queuedNextTripId).toBeNull();
  });

  it('aceita B ainda em P2 (a caminho) de A → encadeia igual ao completar/cancelar A', () => {
    const { state, transitions } = run([
      { type: 'WENT_ONLINE', atMs: 0 },
      { type: 'TRIP_ACCEPTED', atMs: 1 * MIN, tripId: 'A' },
      { type: 'TRIP_ACCEPTED', atMs: 2 * MIN, tripId: 'B' }, // enfileira enquanto A ainda em P2
      { type: 'TRIP_CANCELLED', atMs: 3 * MIN, tripId: 'A' }, // passageiro cancela antes do embarque
    ]);
    expect(transitions[transitions.length - 1]).toBe('P2_ENROUTE->P2_ENROUTE(chained)');
    // from===to mas ainda assim é uma transição de CORRIDA (novo tripId) — verifica via estado:
    expect(state.currentTripId).toBe('B');
  });
});

describe('driverPeriodMachine — eventos fora de ordem / duplicados (idempotência)', () => {
  it('TRIP_BOARDED de corrida que não é a atual é ignorado', () => {
    const { state, transitions } = run([
      { type: 'WENT_ONLINE', atMs: 0 },
      { type: 'TRIP_ACCEPTED', atMs: 1 * MIN, tripId: 'A' },
      { type: 'TRIP_BOARDED', atMs: 2 * MIN, tripId: 'ZZZ' }, // trip errada — ignora
    ]);
    expect(state.period).toBe('P2_ENROUTE');
    expect(transitions).toEqual(['P0_OFFLINE->P1_AVAILABLE(went_online)', 'P1_AVAILABLE->P2_ENROUTE(accepted)']);
  });

  it('TRIP_ACCEPTED duplicado (replay) não gera transição nem re-enfileira', () => {
    const { state, transitions } = run([
      { type: 'WENT_ONLINE', atMs: 0 },
      { type: 'TRIP_ACCEPTED', atMs: 1 * MIN, tripId: 'A' },
      { type: 'TRIP_ACCEPTED', atMs: 1 * MIN + 1, tripId: 'A' }, // replay do mesmo evento
    ]);
    expect(transitions).toEqual(['P0_OFFLINE->P1_AVAILABLE(went_online)', 'P1_AVAILABLE->P2_ENROUTE(accepted)']);
    expect(state.currentTripId).toBe('A');
  });

  it('WENT_ONLINE quando já P1 é no-op', () => {
    const { transitions } = run([
      { type: 'WENT_ONLINE', atMs: 0 },
      { type: 'WENT_ONLINE', atMs: 1 * MIN },
    ]);
    expect(transitions).toEqual(['P0_OFFLINE->P1_AVAILABLE(went_online)']);
  });

  it('TRIP_COMPLETED de corrida que não é a atual é ignorado', () => {
    const { state } = run([
      { type: 'WENT_ONLINE', atMs: 0 },
      { type: 'TRIP_ACCEPTED', atMs: 1 * MIN, tripId: 'A' },
      { type: 'TRIP_COMPLETED', atMs: 2 * MIN, tripId: 'ZZZ' },
    ]);
    expect(state.period).toBe('P2_ENROUTE');
    expect(state.currentTripId).toBe('A');
  });
});

describe('driverPeriodMachine — kill do app / reconstrução via servidor', () => {
  it('serializa e reconstrói o estado idêntico (sobrevive a kill)', () => {
    const { state } = run([
      { type: 'WENT_ONLINE', atMs: 0 },
      { type: 'TRIP_ACCEPTED', atMs: 1 * MIN, tripId: 'A' },
    ]);
    const raw = serializeDriverPeriod(state);
    const restored = deserializeDriverPeriod(raw);
    expect(restored).toEqual(state);
  });

  it('deserializeDriverPeriod devolve null para lixo/ausente', () => {
    expect(deserializeDriverPeriod(null)).toBeNull();
    expect(deserializeDriverPeriod(undefined)).toBeNull();
    expect(deserializeDriverPeriod('{"garbage":true}')).toBeNull();
    expect(deserializeDriverPeriod('not json')).toBeNull();
  });

  it('depois de reconstruído, novos eventos continuam a máquina normalmente', () => {
    const { state: killedAt } = run([
      { type: 'WENT_ONLINE', atMs: 0 },
      { type: 'TRIP_ACCEPTED', atMs: 1 * MIN, tripId: 'A' },
      { type: 'TRIP_BOARDED', atMs: 2 * MIN, tripId: 'A' },
    ]);
    const restored = deserializeDriverPeriod(serializeDriverPeriod(killedAt)) as DriverPeriodState;
    const { state: finalState, transition } = stepDriverPeriod(restored, {
      type: 'TRIP_COMPLETED',
      atMs: 30 * MIN,
      tripId: 'A',
    });
    expect(transition?.reason).toBe('completed');
    expect(finalState.period).toBe('P1_AVAILABLE');
  });
});

describe('driverPeriodMachine — anomalias', () => {
  it('WENT_OFFLINE durante P3 (app killado em corrida) transiciona pra P0 mesmo assim, e limpa fila', () => {
    const { state, transitions } = run([
      { type: 'WENT_ONLINE', atMs: 0 },
      { type: 'TRIP_ACCEPTED', atMs: 1 * MIN, tripId: 'A' },
      { type: 'TRIP_BOARDED', atMs: 2 * MIN, tripId: 'A' },
      { type: 'TRIP_ACCEPTED', atMs: 3 * MIN, tripId: 'B' }, // enfileirada
      { type: 'WENT_OFFLINE', atMs: 4 * MIN }, // app cai / servidor detecta desconexão
    ]);
    expect(transitions[transitions.length - 1]).toBe('P3_ONTRIP->P0_OFFLINE(went_offline)');
    expect(state.queuedNextTripId).toBeNull();
  });

  it('coordenadas GPS (lat/lng) do evento são propagadas na transição', () => {
    const { transitions: _t, state } = run([
      { type: 'WENT_ONLINE', atMs: 0, lat: 28.5, lng: -81.3 },
    ]);
    // reexecuta manualmente pra inspecionar a transição em si (run() só guarda string)
    const s0 = initialDriverPeriodState(0);
    const { transition } = stepDriverPeriod(s0, { type: 'WENT_ONLINE', atMs: 0, lat: 28.5, lng: -81.3 });
    expect(transition?.lat).toBe(28.5);
    expect(transition?.lng).toBe(-81.3);
    expect(state.period).toBe('P1_AVAILABLE');
  });
});
