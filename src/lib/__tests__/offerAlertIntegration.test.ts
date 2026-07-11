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
import { resolveRevocation, type RevocationEvent } from '../rideRevocation';

const RIDE = 'ride-fanout-1';

/** Um "aparelho": manager próprio + estado de oferta + card (forceClose). */
class Client {
  manager = new OfferAlertManager();
  pendingRideId: string | null = null;
  cardClosed = false;
  stopAll = jest.spyOn(this.manager, 'stopAll');

  constructor(readonly driverId: string) {
    // O forceClose do manager fecha o card e zera o pendingRide (como no
    // useDriverRide). É assim que o watchdog/stopAll mantêm card e som juntos.
    this.manager.registerForceClose((rideId) => {
      if (this.pendingRideId === rideId) {
        this.pendingRideId = null;
        this.cardClosed = true;
      }
    });
  }

  /** A oferta chega: card aparece e o alarme começa. */
  receiveOffer(rideId: string) {
    this.pendingRideId = rideId;
    this.cardClosed = false;
    this.manager.startAlert(rideId);
  }

  /** ACEITAR (vencedor): silêncio local imediato ANTES de avisar a rede. */
  accept(rideId: string) {
    this.manager.stopAll(rideId, 'accepted');
  }

  /** RECUSAR: silêncio local imediato, sem depender de rede. */
  decline(rideId: string) {
    this.manager.stopAll(rideId, 'declined');
  }

  /** Recebe um evento do canal `ride-offers` e decide como useDriverRide. */
  onBroadcast(event: RevocationEvent) {
    const actions = resolveRevocation(event, {
      driverId: this.driverId,
      pendingRideId: this.pendingRideId,
      pendingScheduledRideId: null,
      activeRideId: null,
    });
    if (actions.clearPendingRide) {
      this.manager.stopAll(
        event.rideId!,
        event.reason === 'taken' ? 'taken' : event.reason === 'expired' ? 'expired' : 'revoked'
      );
    }
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

describe('fan-out: 1 aceita → os outros 3 silenciam em <2s', () => {
  it('todos os não-vencedores chamam stopAll e fecham o card imediatamente', () => {
    const clients = [new Client('drv-0'), new Client('drv-1'), new Client('drv-2'), new Client('drv-3')];
    const bus = makeBus(clients);

    // Oferta em leque: todos os 4 tocam.
    clients.forEach((c) => c.receiveOffer(RIDE));
    expect(clients.every((c) => c.isRinging)).toBe(true);

    // drv-0 aceita: silêncio local + avisa a rede (broadcast 'taken').
    const t0 = Date.now();
    clients[0].accept(RIDE);
    bus.broadcastRevoked(RIDE, 'drv-0', 'taken');
    const elapsed = Date.now() - t0;

    // Contrato de tempo: silenciamento síncrono, muito abaixo de 2s.
    expect(elapsed).toBeLessThan(2000);

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
    const t0 = Date.now();
    clients[0].accept(RIDE);
    bus.broadcastRevoked(RIDE, 'drv-0', 'taken');
    expect(Date.now() - t0).toBeLessThan(2000);

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
