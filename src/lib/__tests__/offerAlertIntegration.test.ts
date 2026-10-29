// Teste de INTEGRAÇÃO do silenciamento em leque (fan-out) — o coração do bug.
//
// Simula 4 aparelhos (1 iOS + 3 Androids, como no relato) recebendo a MESMA
// oferta. Cada aparelho é uma instância própria de OfferAlertManager (cada app
// tem o seu singleton) e um estado de motorista próprio. Um barramento
// compartilhado emula o canal Realtime `ride-offers`: ao aceitar, o vencedor
// emite `ride_offer_revoked` e TODOS recebem — cada um decide, com a MESMA
// função pura `resolveRevocation` usada em useDriverRide.handleRevocation, se
// deve silenciar. O contrato: os 3 não-vencedores param o alarme (stopAll) em
// <2s. Repete com um motorista RECUSANDO antes do aceite.

const mockPlayer = {
  seekTo: jest.fn(),
  play: jest.fn(),
  pause: jest.fn(),
  remove: jest.fn(),
  loop: false,
  playing: true,
};

jest.mock('expo-audio', () => ({
  createAudioPlayer: jest.fn(() => mockPlayer),
}));

jest.mock('expo-haptics', () => ({
  notificationAsync: jest.fn(() => Promise.resolve()),
  NotificationFeedbackType: { Warning: 'warning', Success: 'success' },
}));

jest.mock('../notifications', () => ({
  dismissRideNotifications: jest.fn(() => Promise.resolve()),
}));

import { OfferAlertManager } from '../offerAlertManager';
import { resolveRevocation, decideOfferSilence, type RevocationEvent } from '../rideRevocation';
import { arriveOffer, resolveOffer, queueHasOffer } from '../offerQueue';

const RIDE = 'ride-fanout-1';

/**
 * Um "aparelho": manager próprio + fila de ofertas + card (forceClose).
 *
 * `onBroadcast` REPLICA a ordem de chamadas de `useRide.handleRevocation`
 * (`src/hooks/useRide.ts`, ~:1600) e NÃO decide nada por conta própria. Isso é
 * o ponto do arquivo, e uma versão anterior errava exatamente aqui: ela
 * reimplementava o ternário de motivo à mão, e com isso ficava CEGA para
 * `decideOfferSilence`. Estava provado — com `silenceThisOffer` fixado em
 * `false` (nenhum motorista jamais para de tocar por revogação: o bug inteiro
 * de volta), esta suíte passava 4/4. Ela testava a cópia, não a regra.
 *
 * Qualquer decisão nova que apareça no handler tem de entrar na função pura e
 * ser chamada daqui — não reescrita abaixo.
 */
class Client {
  manager = new OfferAlertManager();
  /** Espelha `offerQueue` do useDriverRide; a CABEÇA é o card visível. */
  offerQueue: { id: string }[] = [];
  cardClosed = false;
  /** Dedupe `${rideId}:${reason}`, como `handledRevocations` no hook. */
  handled = new Set<string>();
  /** Auditorias 'taken_by_other' emitidas — uma por perda de corrida. */
  logged: string[] = [];
  stopAll = jest.spyOn(this.manager, 'stopAll');

  constructor(readonly driverId: string, readonly multiOffer = false) {
    // O forceClose do manager fecha o card e tira a oferta da fila (como no
    // useDriverRide). É assim que o watchdog/stopAll mantêm card e som juntos.
    this.manager.registerForceClose((rideId) => {
      if (queueHasOffer(this.offerQueue, rideId)) {
        this.offerQueue = resolveOffer(this.offerQueue, rideId);
        this.cardClosed = true;
      }
    });
  }

  /** A cabeça da fila é o que o motorista vê/ouve agora. */
  get pendingRideId(): string | null {
    return this.offerQueue.length > 0 ? this.offerQueue[0].id : null;
  }

  /**
   * Espelha `useRideCallAlert` (src/hooks/useRideCallAlert.ts:21-34): o alarme
   * é dirigido pelo CARD, e o card mostra só a CABEÇA da fila. Uma oferta na
   * cauda NÃO toca — o `OfferAlertManager` é de propósito um slot único
   * (`offerAlertManager.ts:135-137`: oferta nova encerra a anterior). Modelar
   * `startAlert` por oferta que chega, e não por cabeça, seria inventar um
   * defeito que o app não tem.
   */
  private alerting: string | null = null;
  private syncAlert() {
    const head = this.pendingRideId;
    if (head === this.alerting) return;
    if (this.alerting) this.manager.stopAll(this.alerting, 'card_unmounted');
    this.alerting = head;
    if (head) this.manager.startAlert(head);
  }

  /** A oferta chega: entra na fila; se virar cabeça, o card aparece e toca. */
  receiveOffer(rideId: string) {
    this.offerQueue = arriveOffer(this.offerQueue, { id: rideId }, this.multiOffer);
    this.cardClosed = false;
    this.syncAlert();
  }

  /** ACEITAR (vencedor): silêncio local imediato ANTES de avisar a rede. */
  accept(rideId: string) {
    this.manager.stopAll(rideId, 'accepted');
    this.syncAlert(); // o card sai da tela na hora, não no broadcast
  }

  /** RECUSAR: silêncio local imediato, sem depender de rede. */
  decline(rideId: string) {
    this.manager.stopAll(rideId, 'declined');
    this.syncAlert();
  }

  /** Recebe um evento do canal `ride-offers` e decide como useDriverRide. */
  onBroadcast(event: RevocationEvent) {
    const actions = resolveRevocation(event, {
      driverId: this.driverId,
      pendingRideId: this.pendingRideId,
      pendingScheduledRideId: null,
      activeRideId: null,
    });

    const key = `${event.rideId}:${event.reason}`;
    const alreadyHandled = this.handled.has(key);
    this.handled.add(key);

    const silence = decideOfferSilence({
      reason: event.reason,
      multiOffer: this.multiOffer,
      offerInQueue: queueHasOffer(this.offerQueue, event.rideId ?? ''),
      clearPendingRide: actions.clearPendingRide,
      alreadyHandled,
    });

    if (silence.silenceThisOffer && event.rideId) {
      this.manager.stopAll(event.rideId, silence.alertReason);
      this.offerQueue = resolveOffer(this.offerQueue, event.rideId);
      if (silence.logTakenByOther) this.logged.push(event.rideId);
    }
    // A cabeça pode ter mudado: a próxima da fila assume o card.
    this.syncAlert();
  }

  get isRinging() {
    return this.manager.__ringingRideId === RIDE;
  }
}

/** Barramento compartilhado = canal Realtime `ride-offers`. */
function makeBus(clients: Client[]) {
  return {
    broadcastRevoked(rideId: string, by: string, reason: RevocationEvent['reason']) {
      for (const c of clients) c.onBroadcast({ rideId, by, reason });
    },
  };
}

beforeEach(() => {
  jest.useFakeTimers();
  mockPlayer.playing = true;
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

// NÃO há asserção de tempo de parede aqui. Sob `jest.useFakeTimers()` o
// `Date.now()` fica congelado, então qualquer `expect(elapsed).toBeLessThan(...)`
// compara 0 com o limite e não pode falhar. O contrato de <2s é medida de campo
// (dispositivo real, rede real) e continua PENDENTE — ver a lista de métricas
// não observadas. O que estes testes provam é a ORDEM: o silenciamento acontece
// no mesmo tick do aceite, sem depender de timer.
describe('fan-out: 1 aceita → os outros 3 silenciam no mesmo tick', () => {
  it('todos os não-vencedores chamam stopAll e fecham o card imediatamente', () => {
    const clients = [new Client('drv-0'), new Client('drv-1'), new Client('drv-2'), new Client('drv-3')];
    const bus = makeBus(clients);

    // Oferta em leque: todos os 4 tocam.
    clients.forEach((c) => c.receiveOffer(RIDE));
    expect(clients.every((c) => c.isRinging)).toBe(true);

    // drv-0 aceita: silêncio local + avisa a rede (broadcast 'taken').
    clients[0].accept(RIDE);
    bus.broadcastRevoked(RIDE, 'drv-0', 'taken');

    // Vencedor: parou pelo aceite (o eco do próprio 'taken' NÃO o limpa de novo).
    expect(clients[0].stopAll).toHaveBeenCalledWith(RIDE, 'accepted');
    // Os 3 demais: silenciados pela revogação, com card fechado.
    for (const c of clients.slice(1)) {
      expect(c.stopAll).toHaveBeenCalledWith(RIDE, 'taken');
      expect(c.cardClosed).toBe(true);
    }
    // NINGUÉM continua tocando.
    expect(clients.every((c) => !c.isRinging)).toBe(true);
  });

  it('após o aceite, uma RE-OFERTA da mesma corrida é descartada (tombstone) — não volta a tocar', () => {
    const clients = [new Client('drv-0'), new Client('drv-1'), new Client('drv-2'), new Client('drv-3')];
    const bus = makeBus(clients);
    clients.forEach((c) => c.receiveOffer(RIDE));

    clients[0].accept(RIDE);
    bus.broadcastRevoked(RIDE, 'drv-0', 'taken');

    // Um poll/realtime atrasado tenta reabrir o card nos não-vencedores.
    clients.slice(1).forEach((c) => c.receiveOffer(RIDE));
    expect(clients.every((c) => !c.isRinging)).toBe(true); // tombstone bloqueou
  });
});

describe('fan-out com uma RECUSA antes do aceite', () => {
  it('quem recusou fica em silêncio; ao aceite, os demais silenciam sem re-tocar o que recusou', () => {
    const clients = [new Client('drv-0'), new Client('drv-1'), new Client('drv-2'), new Client('drv-3')];
    const bus = makeBus(clients);
    clients.forEach((c) => c.receiveOffer(RIDE));

    // drv-3 RECUSA primeiro (silêncio local, sem rede).
    clients[3].decline(RIDE);
    expect(clients[3].stopAll).toHaveBeenCalledWith(RIDE, 'declined');
    expect(clients[3].isRinging).toBe(false);
    clients[3].stopAll.mockClear();

    // drv-0 aceita → broadcast.
    clients[0].accept(RIDE);
    bus.broadcastRevoked(RIDE, 'drv-0', 'taken');

    // drv-1 e drv-2 silenciam pela revogação.
    for (const c of [clients[1], clients[2]]) {
      expect(c.stopAll).toHaveBeenCalledWith(RIDE, 'taken');
      expect(c.isRinging).toBe(false);
    }
    // drv-3 (já recusado) NÃO volta a tocar; a revogação é no-op para ele
    // (pendingRideId já é null → resolveRevocation não manda limpar de novo).
    expect(clients[3].stopAll).not.toHaveBeenCalled();
    expect(clients[3].isRinging).toBe(false);
    // Ninguém segue tocando.
    expect(clients.every((c) => !c.isRinging)).toBe(true);
  });
});

describe('fan-out com FILA (multiOffer): a revogada pode estar na CAUDA', () => {
  // Sem este bloco, o modo multi fica sem cobertura nenhuma no fan-out e a
  // regra `multiOffer ? offerInQueue : clearPendingRide` vira meia-morta:
  // no slot único as duas entradas coincidem, então inverter o ternário passa
  // por todos os outros testes deste arquivo. Aqui elas divergem de propósito.
  const OUTRA = 'ride-fanout-2';

  it('a oferta da CAUDA revogada some sem calar a CABEÇA, que segue tocando', () => {
    const drv = new Client('drv-1', true);
    drv.receiveOffer(RIDE); // cabeça: o card que ele vê
    drv.receiveOffer(OUTRA); // cauda: enfileirada, sem cancelar a primeira
    expect(drv.offerQueue.map((o) => o.id)).toEqual([RIDE, OUTRA]);

    // OUTRA é aceita por outro motorista. `resolveRevocation` só compara com a
    // CABEÇA, então `clearPendingRide` é false: quem tem de mandar aqui é a
    // presença na fila.
    drv.onBroadcast({ rideId: OUTRA, by: 'drv-9', reason: 'taken' });

    expect(drv.offerQueue.map((o) => o.id)).toEqual([RIDE]);
    expect(drv.stopAll).toHaveBeenCalledWith(OUTRA, 'taken');
    expect(drv.isRinging).toBe(true); // a cabeça NÃO foi calada junto
  });

  it('a CABEÇA revogada cala e promove a próxima da fila', () => {
    const drv = new Client('drv-1', true);
    drv.receiveOffer(RIDE);
    drv.receiveOffer(OUTRA);

    drv.onBroadcast({ rideId: RIDE, by: 'drv-9', reason: 'taken' });

    expect(drv.stopAll).toHaveBeenCalledWith(RIDE, 'taken');
    expect(drv.pendingRideId).toBe(OUTRA);
  });
});

describe('o aceite emite DOIS eventos: silencia sempre, audita uma vez', () => {
  it('evento repetido ainda cala o som, mas não conta a perda duas vezes', () => {
    const drv = new Client('drv-1');
    drv.receiveOffer(RIDE);

    drv.onBroadcast({ rideId: RIDE, by: 'drv-0', reason: 'taken' });
    expect(drv.logged).toEqual([RIDE]);
    expect(drv.isRinging).toBe(false);

    // Realtime reentrega o MESMO evento e, nesse meio-tempo, um poll atrasado
    // trouxe o card de volta. O segundo evento tem de conseguir calar de novo —
    // silenciar é idempotente e inofensivo; deixar tocando é o defeito.
    drv.offerQueue = [{ id: RIDE }];
    drv.stopAll.mockClear();
    drv.onBroadcast({ rideId: RIDE, by: 'drv-0', reason: 'taken' });

    expect(drv.stopAll).toHaveBeenCalledWith(RIDE, 'taken');
    expect(drv.offerQueue).toEqual([]);
    // ...mas a auditoria continua com UMA perda, não duas.
    expect(drv.logged).toEqual([RIDE]);
  });
});

describe('watchdog de segurança no fan-out', () => {
  it('se o broadcast NUNCA chega, o watchdog de 20s cala cada aparelho', () => {
    const clients = [new Client('drv-0'), new Client('drv-1'), new Client('drv-2'), new Client('drv-3')];
    clients.forEach((c) => c.receiveOffer(RIDE));
    expect(clients.every((c) => c.isRinging)).toBe(true);

    // Rede caiu: nenhum broadcast. O teto de 20s age em cada um.
    jest.advanceTimersByTime(20_000);

    expect(clients.every((c) => !c.isRinging)).toBe(true);
    expect(clients.every((c) => c.cardClosed)).toBe(true);
  });
});
