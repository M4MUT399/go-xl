// Testes de CONCORRÊNCIA do dispatch (PR-a) — modelam o "device do motorista"
// exatamente como o useDriverRide o implementa: uma fila FIFO de ofertas
// (offerQueue) cuja CABEÇA é a corrida que toca/aparece agora. Provam a
// invariante central do bug: criar/receber uma nova oferta JAMAIS cancela,
// silencia ou lapida outra oferta válida.
//
// (A lógica de rede/Supabase fica de fora de propósito — aqui validamos a
// máquina de decisão pura que o hook aplica.)

import { arriveOffer, resolveOffer, headOffer, type QueuedOffer } from '../offerQueue';

type Ride = QueuedOffer & { passenger?: string };

/** Espelho do device de UM motorista: fila + qual oferta está "tocando" (cabeça). */
class DriverDevice {
  queue: Ride[] = [];
  constructor(private multiOffer: boolean) {}
  /** Recebeu uma nova oferta (INSERT/broadcast). */
  arrive(ride: Ride) {
    this.queue = arriveOffer(this.queue, ride, this.multiOffer);
  }
  /** Oferta resolvida (aceite/recusa/expira/tomada/cancelada) sai por id. */
  resolve(id: string) {
    this.queue = resolveOffer(this.queue, id);
  }
  /** Motorista ficou ocupado (aceitou uma corrida) → esvazia a fila dele. */
  goBusy() {
    this.queue = [];
  }
  /** A oferta que TOCA agora (cabeça), ou null. */
  get ringing(): string | null {
    return headOffer(this.queue)?.id ?? null;
  }
  get queued(): string[] {
    return this.queue.map((o) => o.id);
  }
}

const P1: Ride = { id: 'P1' };
const P2: Ride = { id: 'P2' };

describe('Critério (1): P1 então P2 5s depois → P1 permanece, P2 enfileirada', () => {
  it('multi-oferta ON: P2 NÃO revoga P1; ambas ficam, P1 continua tocando', () => {
    const d = new DriverDevice(true);
    d.arrive(P1);
    expect(d.ringing).toBe('P1');
    d.arrive(P2); // 5s depois
    expect(d.ringing).toBe('P1'); // P1 NÃO foi cancelada nem silenciada
    expect(d.queued).toEqual(['P1', 'P2']); // P2 distribuída/enfileirada
  });

  it('regressão (bug legado, flag OFF): P2 SUBSTITUIA P1 no slot único', () => {
    const d = new DriverDevice(false);
    d.arrive(P1);
    d.arrive(P2);
    expect(d.queued).toEqual(['P2']); // comportamento antigo preservado sob flag off
  });
});

describe('Critério (2): motorista aceita P1 → passa a ver P2 (na verdade: fica livre p/ a próxima)', () => {
  it('ao ACEITAR P1 o device fica ocupado e ESVAZIA a fila (P2 vai p/ os OUTROS)', () => {
    const d = new DriverDevice(true);
    d.arrive(P1);
    d.arrive(P2);
    d.goBusy(); // aceitou P1 → ocupado
    expect(d.ringing).toBeNull();
    expect(d.queued).toEqual([]); // não fica tocando P2 enquanto vai buscar P1
  });

  it('ao RECUSAR P1 (não fica ocupado) a próxima da fila (P2) assume', () => {
    const d = new DriverDevice(true);
    d.arrive(P1);
    d.arrive(P2);
    d.resolve('P1'); // recusou
    expect(d.ringing).toBe('P2'); // promoção automática
    expect(d.queued).toEqual(['P2']);
  });
});

describe('Critério (3): dois motoristas, um aceita P1 → o outro é redirecionado p/ P2', () => {
  it('M1 aceita P1 (esvazia), M2 recebe revogação de P1 e cai para P2', () => {
    const m1 = new DriverDevice(true);
    const m2 = new DriverDevice(true);
    // Ambos recebem P1 e P2 (leque)
    m1.arrive(P1); m1.arrive(P2);
    m2.arrive(P1); m2.arrive(P2);
    expect(m1.ringing).toBe('P1');
    expect(m2.ringing).toBe('P1');

    // M1 aceita P1 → fica ocupado; broadcast 'taken' de P1 chega em M2.
    m1.goBusy();
    m2.resolve('P1'); // revogação por 'taken'

    expect(m1.ringing).toBeNull();       // M1 ocupado com P1
    expect(m2.ringing).toBe('P2');       // M2 exatamente UM vencedor de P2 agora
    expect(m2.queued).toEqual(['P2']);   // P1 saiu sem afetar P2
  });
});

describe('Critério (4): 10 pedidos, 3 motoristas — ninguém é cancelado por engano, FIFO', () => {
  it('cada motorista mantém a fila FIFO; aceites sucessivos redistribuem sem perder pedidos', () => {
    const devices = [new DriverDevice(true), new DriverDevice(true), new DriverDevice(true)];
    const reqs: Ride[] = Array.from({ length: 10 }, (_, i) => ({ id: `R${i}` }));
    // Todos os 10 pedidos chegam a todos os 3 motoristas (dispatch em leque).
    for (const r of reqs) for (const d of devices) d.arrive(r);

    // Todos veem a MESMA cabeça (R0) e mantêm a fila completa, em ordem.
    for (const d of devices) {
      expect(d.ringing).toBe('R0');
      expect(d.queued).toEqual(reqs.map((r) => r.id));
    }

    // M0 aceita R0 → ocupado. Os outros recebem revogação de R0 e caem para R1.
    devices[0].goBusy();
    devices[1].resolve('R0');
    devices[2].resolve('R0');
    expect(devices[0].ringing).toBeNull();
    expect(devices[1].ringing).toBe('R1');
    expect(devices[2].ringing).toBe('R1');
    // Nenhum pedido de R1..R9 foi perdido em M1/M2.
    expect(devices[1].queued).toEqual(['R1','R2','R3','R4','R5','R6','R7','R8','R9']);
  });
});

describe('Invariante: criar uma nova oferta nunca muda as demais', () => {
  it('a chegada de P2/P3 não reordena nem remove P1 (cabeça estável)', () => {
    const d = new DriverDevice(true);
    d.arrive(P1);
    const before = d.queued.slice();
    d.arrive(P2);
    d.arrive({ id: 'P3' });
    expect(d.ringing).toBe('P1');           // cabeça intacta
    expect(before).toEqual(['P1']);
    expect(d.queued).toEqual(['P1','P2','P3']); // só cresce no fim
  });
});
