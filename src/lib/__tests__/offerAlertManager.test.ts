// Testes da máquina de estados do OfferAlertManager (dono único do alerta).
// Cobre as regras não-negociáveis do bug crítico de som:
//   • startAlert idempotente (re-oferta/duplicata do MESMO ride_id NÃO reinicia)
//   • QUALQUER transição TERMINAL para o som (revoked/declined/expired/taken)
//   • tombstone: push para ride_id terminado é descartado (não re-toca)
//   • watchdog: nenhum som passa de 20s, mesmo sem nenhum evento
//   • decline para o som localmente (sem rede)
//   • nova oferta (id diferente) substitui a anterior

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

import { offerAlertManager } from '../offerAlertManager';
import { dismissRideNotifications } from '../notifications';

const A = 'ride-aaa';
const B = 'ride-bbb';

beforeEach(() => {
  jest.useFakeTimers();
  offerAlertManager.__resetForTests();
  mockPlayer.playing = true;
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('startAlert', () => {
  it('IDLE→RINGING: inicia o som e marca a corrida como tocando', () => {
    offerAlertManager.startAlert(A);
    expect(mockPlayer.play).toHaveBeenCalledTimes(1);
    expect(offerAlertManager.__ringingRideId).toBe(A);
  });

  it('idempotente: repetir o MESMO ride_id não reinicia o som (re-oferta/duplicata)', () => {
    offerAlertManager.startAlert(A);
    offerAlertManager.startAlert(A);
    offerAlertManager.startAlert(A);
    expect(mockPlayer.play).toHaveBeenCalledTimes(1);
    expect(mockPlayer.seekTo).toHaveBeenCalledTimes(1);
    expect(offerAlertManager.__ringingRideId).toBe(A);
  });

  it('nova oferta (id diferente) substitui a anterior: A vai a TERMINAL, B toca', () => {
    offerAlertManager.startAlert(A);
    offerAlertManager.startAlert(B);
    // A foi lapidada; B é a que toca agora
    expect(offerAlertManager.__ringingRideId).toBe(B);
    expect(offerAlertManager.isTombstoned(A)).toBe(true);
    expect(mockPlayer.play).toHaveBeenCalledTimes(2);
  });
});

describe('stopAll — QUALQUER transição TERMINAL para tudo', () => {
  it.each(['taken', 'declined', 'revoked', 'expired'] as const)(
    'causa "%s": para o som, lapida o id, dispensa a notificação e fecha o card',
    (cause) => {
      const forceClose = jest.fn();
      const unreg = offerAlertManager.registerForceClose(forceClose);

      offerAlertManager.startAlert(A);
      offerAlertManager.stopAll(A, cause);

      expect(mockPlayer.pause).toHaveBeenCalled();
      expect(offerAlertManager.__ringingRideId).toBeNull();
      expect(offerAlertManager.isTombstoned(A)).toBe(true);
      expect(dismissRideNotifications).toHaveBeenCalledWith(A);
      expect(forceClose).toHaveBeenCalledWith(A);

      unreg();
    }
  );

  it('decline funciona 100% local (sem nenhuma chamada de rede envolvida)', () => {
    offerAlertManager.startAlert(A);
    // Nenhum mock de supabase/fetch — stopAll não depende de rede.
    expect(() => offerAlertManager.stopAll(A, 'declined')).not.toThrow();
    expect(mockPlayer.pause).toHaveBeenCalled();
    expect(offerAlertManager.__ringingRideId).toBeNull();
  });

  it('revogação de OUTRA corrida NÃO silencia a chamada válida atual', () => {
    offerAlertManager.startAlert(A);
    mockPlayer.pause.mockClear();
    offerAlertManager.stopAll(B, 'revoked'); // B não é a que toca
    expect(mockPlayer.pause).not.toHaveBeenCalled();
    expect(offerAlertManager.__ringingRideId).toBe(A);
    expect(offerAlertManager.isTombstoned(B)).toBe(true);
  });
});

describe('tombstone', () => {
  it('push/poll para um ride_id já terminado é descartado (não re-toca)', () => {
    offerAlertManager.startAlert(A);
    offerAlertManager.stopAll(A, 'taken');
    mockPlayer.play.mockClear();

    // Chega uma re-oferta da MESMA corrida (poll de 4s / realtime) → ignorada.
    offerAlertManager.startAlert(A);
    expect(mockPlayer.play).not.toHaveBeenCalled();
    expect(offerAlertManager.__ringingRideId).toBeNull();
  });
});

describe('watchdog de 20s', () => {
  it('para o som INCONDICIONALMENTE após 20s mesmo sem nenhum evento', () => {
    const forceClose = jest.fn();
    const unreg = offerAlertManager.registerForceClose(forceClose);

    offerAlertManager.startAlert(A);
    expect(offerAlertManager.__ringingRideId).toBe(A);

    jest.advanceTimersByTime(20_000);

    expect(mockPlayer.pause).toHaveBeenCalled();
    expect(offerAlertManager.__ringingRideId).toBeNull();
    expect(forceClose).toHaveBeenCalledWith(A);
    expect(offerAlertManager.isTombstoned(A)).toBe(true);

    unreg();
  });

  it('antes de 20s o som segue tocando (não corta cedo demais)', () => {
    offerAlertManager.startAlert(A);
    jest.advanceTimersByTime(19_000);
    expect(offerAlertManager.__ringingRideId).toBe(A);
  });
});
