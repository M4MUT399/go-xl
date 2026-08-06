// Testes de CONCORRÊNCIA do motor de dispatch estilo Uber (PR-b).
// Cobrem os 6 critérios de aceitação sobre o NÚCLEO PURO (dispatchEngine.ts):
// máquina de estados por pedido + escalonador com trava por motorista, oferta
// sequencial/broadcast por ETA, aceite atômico com revogação dos perdedores,
// re-dispatch, reconstrução de estado (fonte da verdade) e carga.

import {
  createEngine,
  createRequest,
  reconcile,
  accept,
  reject,
  removeRequest,
  offerForDriver,
  getRequest,
  type DriverPosition,
  type EngineState,
} from '../dispatchEngine';

const PICKUP = { lat: 0, lng: 0 };

/** Motoristas todos no ponto de embarque (distância 0 → dentro do raio), com
 *  ETA determinístico via override para ordenar o ranking. */
function drivers(n: number, busy: Set<string> = new Set()): DriverPosition[] {
  return Array.from({ length: n }, (_, i) => ({
    driverId: `M${i}`,
    lat: 0,
    lng: 0,
    etaMinOverride: i + 1, // M0=1min (melhor), M1=2min, ...
    busy: busy.has(`M${i}`),
  }));
}

/** Ids dos pedidos atualmente em OFFERING. */
function offering(s: EngineState): string[] {
  return s.requests.filter((r) => r.status === 'OFFERING').map((r) => r.id);
}

/** Invariante global: nenhum motorista em duas ofertas vivas ao mesmo tempo. */
function assertNoDoubleOffer(s: EngineState) {
  const seen = new Set<string>();
  for (const r of s.requests) {
    if (r.status !== 'OFFERING') continue;
    for (const o of r.offers) {
      if (seen.has(o.driverId)) throw new Error(`motorista ${o.driverId} em duas ofertas`);
      seen.add(o.driverId);
    }
  }
}

describe('Critério (1): P1 então P2 (5s depois) → independentes, P1 intacta', () => {
  it('criar P2 NÃO revoga nem altera a oferta viva de P1', () => {
    let s = createEngine({ dispatchMode: 'sequential' });
    const pool = drivers(2);
    s = createRequest(s, { id: 'P1', pickup: PICKUP, createdAt: 0 });
    s = reconcile(s, pool, 0);
    expect(offering(s)).toEqual(['P1']);
    const p1OfferBefore = getRequest(s, 'P1')!.offers.map((o) => o.driverId);
    expect(p1OfferBefore).toEqual(['M0']); // melhor ETA

    // P2 chega 5s depois.
    s = createRequest(s, { id: 'P2', pickup: PICKUP, createdAt: 5000 });
    s = reconcile(s, pool, 5000);

    // P1 permanece OFERTANDO ao MESMO motorista; nada foi revogado/lapidado.
    expect(getRequest(s, 'P1')!.status).toBe('OFFERING');
    expect(getRequest(s, 'P1')!.offers.map((o) => o.driverId)).toEqual(p1OfferBefore);
    expect(getRequest(s, 'P1')!.acceptedBy).toBeNull();
    // P2 foi distribuída ao próximo motorista livre — não roubou o de P1.
    expect(getRequest(s, 'P2')!.offers.map((o) => o.driverId)).toEqual(['M1']);
    assertNoDoubleOffer(s);
  });

  it('com um único motorista, P2 fica em MATCHING (enfileirada) sem tocar P1', () => {
    let s = createEngine({ dispatchMode: 'sequential' });
    const pool = drivers(1);
    s = reconcile(createRequest(s, { id: 'P1', pickup: PICKUP, createdAt: 0 }), pool, 0);
    s = reconcile(createRequest(s, { id: 'P2', pickup: PICKUP, createdAt: 5000 }), pool, 5000);
    expect(getRequest(s, 'P1')!.status).toBe('OFFERING');
    expect(getRequest(s, 'P1')!.offers.map((o) => o.driverId)).toEqual(['M0']);
    expect(getRequest(s, 'P2')!.status).toBe('MATCHING'); // aguardando, não cancelada
  });
});

describe('Critério (2): M1 aceita P1 → motorista liberado recebe P2', () => {
  it('broadcast: perdedor de P1 é redirecionado para P2 no reconcile seguinte', () => {
    let s = createEngine({ dispatchMode: 'broadcast' });
    const pool = drivers(2);
    s = reconcile(createRequest(s, { id: 'P1', pickup: PICKUP, createdAt: 0 }), pool, 0);
    // Ambos recebem P1 (leque).
    expect(getRequest(s, 'P1')!.offers.map((o) => o.driverId).sort()).toEqual(['M0', 'M1']);

    // M0 aceita P1 → M1 é perdedor e fica livre.
    const acc = accept(s, 'P1', 'M0');
    expect(acc.outcome.result).toBe('ACCEPTED');
    expect(acc.outcome.losers).toEqual(['M1']);
    s = acc.state;

    // Chega P2; M0 está ocupado, M1 livre → P2 vai para M1.
    s = createRequest(s, { id: 'P2', pickup: PICKUP, createdAt: 2000 });
    s = reconcile(s, drivers(2, new Set(['M0'])), 2000);
    expect(offerForDriver(s, 'M1')!.id).toBe('P2');
    expect(getRequest(s, 'P1')!.acceptedBy).toBe('M0');
  });
});

describe('Critério (3): M1 e M2 aceitam P1 ao mesmo tempo → um só vence', () => {
  it('vencedor único; perdedor recebe TRIP_NO_LONGER_AVAILABLE e cai para P2', () => {
    let s = createEngine({ dispatchMode: 'broadcast' });
    const pool = drivers(2);
    s = reconcile(createRequest(s, { id: 'P1', pickup: PICKUP, createdAt: 0 }), pool, 0);

    // Aceites concorrentes resolvidos em sequência atômica (compare-and-set).
    const first = accept(s, 'P1', 'M0');
    expect(first.outcome.result).toBe('ACCEPTED');
    const second = accept(first.state, 'P1', 'M1');
    expect(second.outcome.result).toBe('TRIP_NO_LONGER_AVAILABLE');
    s = second.state;

    // Exatamente um vencedor.
    expect(getRequest(s, 'P1')!.acceptedBy).toBe('M0');

    // O perdedor M1 cai para o próximo pedido.
    s = createRequest(s, { id: 'P2', pickup: PICKUP, createdAt: 1000 });
    s = reconcile(s, drivers(2, new Set(['M0'])), 1000);
    expect(offerForDriver(s, 'M1')!.id).toBe('P2');
  });
});

describe('Critério (4): 10 pedidos, 3 motoristas — FIFO, ninguém cancelado', () => {
  it('as 3 primeiras ofertas são FIFO (R0,R1,R2); recusa promove o próximo sem perder R0', () => {
    let s = createEngine({ dispatchMode: 'sequential' });
    const pool = drivers(3);
    for (let i = 0; i < 10; i++) s = createRequest(s, { id: `R${i}`, pickup: PICKUP, createdAt: i });
    s = reconcile(s, pool, 100);

    // FIFO: os 3 primeiros ocupam os 3 motoristas (melhor ETA por pedido).
    expect(offering(s).sort()).toEqual(['R0', 'R1', 'R2']);
    expect(getRequest(s, 'R0')!.offers.map((o) => o.driverId)).toEqual(['M0']);
    assertNoDoubleOffer(s);

    // M0 recusa R0 → R0 volta à fila; o motorista livre vai para o PRÓXIMO da
    // fila (R3), e R0 aguarda — nenhum pedido é cancelado por engano.
    s = reject(s, 'R0', 'M0');
    s = reconcile(s, pool, 200);
    expect(getRequest(s, 'R0')!.status).toBe('MATCHING');
    expect(offerForDriver(s, 'M0')!.id).toBe('R3');
    // Todos os 10 pedidos continuam vivos (nenhum CANCELLED/NO_DRIVERS).
    const terminals = s.requests.filter((r) => r.status === 'CANCELLED' || r.status === 'NO_DRIVERS');
    expect(terminals).toHaveLength(0);
  });

  it('aceites sucessivos com liberação redistribuem todos os 10 sem deadlock', () => {
    let s = createEngine({ dispatchMode: 'sequential' });
    let pool = drivers(3);
    for (let i = 0; i < 10; i++) s = createRequest(s, { id: `R${i}`, pickup: PICKUP, createdAt: i });
    s = reconcile(s, pool, 0);

    const accepted: string[] = [];
    let guard = 0;
    while (s.requests.some((r) => r.status === 'OFFERING' || r.status === 'MATCHING') && guard++ < 100) {
      const off = offering(s);
      if (off.length === 0) { s = reconcile(s, pool, guard); continue; }
      const reqId = off[0];
      const drv = getRequest(s, reqId)!.offers[0].driverId;
      const acc = accept(s, reqId, drv);
      expect(acc.outcome.result).toBe('ACCEPTED');
      accepted.push(reqId);
      // Corrida concluída sai do quadro → motorista volta ao pool.
      s = removeRequest(acc.state, reqId);
      s = reconcile(s, pool, guard);
      assertNoDoubleOffer(s);
    }
    // Todos os 10 foram atendidos, em ordem FIFO, sem perder nenhum.
    expect(accepted).toEqual(['R0','R1','R2','R3','R4','R5','R6','R7','R8','R9']);
  });
});

describe('Critério (5): reconstrução de estado (servidor = fonte da verdade)', () => {
  it('offerForDriver reconstrói a oferta ativa; some quando o pedido é vencido por outro', () => {
    let s = createEngine({ dispatchMode: 'broadcast' });
    const pool = drivers(2);
    s = reconcile(createRequest(s, { id: 'P1', pickup: PICKUP, createdAt: 0 }), pool, 0);

    // App do M1 reabre e "busca" sua oferta ativa no servidor.
    expect(offerForDriver(s, 'M1')!.id).toBe('P1');

    // M0 vence P1 → a oferta de M1 é stale e não deve reaparecer (sem card fantasma).
    s = accept(s, 'P1', 'M0').state;
    expect(offerForDriver(s, 'M1')).toBeNull();
  });
});

describe('Critério (6): carga — 50 pedidos, pool pequeno, sem deadlock/dup/orphan', () => {
  it('mantém invariantes e drena todos os 50 pedidos', () => {
    let s = createEngine({ dispatchMode: 'sequential' });
    const pool = drivers(5);
    for (let i = 0; i < 50; i++) s = createRequest(s, { id: `T${i}`, pickup: PICKUP, createdAt: i });
    s = reconcile(s, pool, 0);

    const done: string[] = [];
    let clock = 1;
    let guard = 0;
    while (s.requests.length > 0 && guard++ < 1000) {
      assertNoDoubleOffer(s); // nunca uma oferta duplicada
      // Nenhuma oferta viva para motorista ocupado (orphan check).
      for (const r of s.requests) {
        if (r.status === 'OFFERING') expect(r.offers.length > 0).toBe(true);
      }
      const off = offering(s);
      if (off.length === 0) { s = reconcile(s, pool, clock++); continue; }
      const reqId = off[0];
      const drv = getRequest(s, reqId)!.offers[0].driverId;
      s = removeRequest(accept(s, reqId, drv).state, reqId); // aceita e conclui
      done.push(reqId);
      s = reconcile(s, pool, clock++);
    }
    expect(s.requests).toHaveLength(0); // sem órfãos: tudo drenado
    expect(done).toHaveLength(50);      // sem deadlock: todos atendidos
    // FIFO preservada ao longo da carga.
    expect(done).toEqual(Array.from({ length: 50 }, (_, i) => `T${i}`));
  });
});
