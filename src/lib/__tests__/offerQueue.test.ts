import { arriveOffer, resolveOffer, headOffer, queueHasOffer, type QueuedOffer } from '../offerQueue';

type Ride = QueuedOffer & { passenger?: string };

const P1: Ride = { id: 'p1', passenger: 'Ana' };
const P2: Ride = { id: 'p2', passenger: 'Bruno' };
const P3: Ride = { id: 'p3', passenger: 'Caio' };

describe('offerQueue — modo legado (multiOffer=false, slot único)', () => {
  it('nova oferta SUBSTITUI a anterior (comportamento antigo de slot único)', () => {
    let q: Ride[] = [];
    q = arriveOffer(q, P1, false);
    expect(headOffer(q)?.id).toBe('p1');
    q = arriveOffer(q, P2, false);
    expect(q).toHaveLength(1);
    expect(headOffer(q)?.id).toBe('p2'); // P1 foi substituída (bug legado preservado sob flag off)
  });

  it('mesmo id não recria o array (idempotente → sem re-render)', () => {
    const q1 = arriveOffer([], P1, false);
    const q2 = arriveOffer(q1, { ...P1 }, false);
    expect(q2).toBe(q1); // mesma referência
  });
});

describe('offerQueue — modo multi-oferta (FIFO)', () => {
  it('ACEITAÇÃO: P1 então P2 → ambas sobrevivem, ordem FIFO, P1 na frente', () => {
    let q: Ride[] = [];
    q = arriveOffer(q, P1, true);
    q = arriveOffer(q, P2, true);
    expect(q.map((o) => o.id)).toEqual(['p1', 'p2']); // P2 NÃO cancela P1
    expect(headOffer(q)?.id).toBe('p1');
  });

  it('resolver a cabeça (aceita/recusa) PROMOVE a próxima', () => {
    let q = arriveOffer(arriveOffer([], P1, true), P2, true);
    q = resolveOffer(q, 'p1'); // motorista aceitou/recusou P1
    expect(headOffer(q)?.id).toBe('p2'); // P2 assume automaticamente
    expect(q).toHaveLength(1);
  });

  it('resolver uma oferta da CAUDA (tomada por outro motorista) não afeta a cabeça', () => {
    let q = arriveOffer(arriveOffer(arriveOffer([], P1, true), P2, true), P3, true);
    q = resolveOffer(q, 'p2'); // P2 foi tomada por outro → sai do meio da fila
    expect(q.map((o) => o.id)).toEqual(['p1', 'p3']);
    expect(headOffer(q)?.id).toBe('p1'); // cabeça intacta
  });

  it('dedupe: reenfileirar o mesmo id (push/poll duplicado) é no-op', () => {
    let q = arriveOffer([], P1, true);
    const ref = q;
    q = arriveOffer(q, { ...P1 }, true);
    expect(q).toBe(ref); // não reordena nem duplica
    expect(q).toHaveLength(1);
  });

  it('10 pedidos, aceites sucessivos redistribuem em ordem FIFO sem perder ninguém', () => {
    let q: Ride[] = [];
    for (let i = 0; i < 10; i++) q = arriveOffer(q, { id: `r${i}` }, true);
    expect(q).toHaveLength(10);
    const seen: string[] = [];
    while (headOffer(q)) {
      const h = headOffer(q)!;
      seen.push(h.id);
      q = resolveOffer(q, h.id);
    }
    expect(seen).toEqual(['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']);
  });

  it('resolveOffer de id ausente devolve a mesma referência (idempotente)', () => {
    const q = arriveOffer([], P1, true);
    expect(resolveOffer(q, 'inexistente')).toBe(q);
  });

  it('queueHasOffer enxerga cabeça e cauda', () => {
    const q = arriveOffer(arriveOffer([], P1, true), P2, true);
    expect(queueHasOffer(q, 'p1')).toBe(true);
    expect(queueHasOffer(q, 'p2')).toBe(true);
    expect(queueHasOffer(q, 'p9')).toBe(false);
  });
});
