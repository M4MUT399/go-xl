import {
  resolveRevocation,
  decideOfferSilence,
  type DriverOfferState,
  type OfferSilenceInput,
} from '../rideRevocation';

// Estado base de um motorista com uma corrida imediata e uma agendada em oferta,
// além de uma corrida ativa já aceita — para exercitar cada caminho isolado.
const baseState: DriverOfferState = {
  driverId: 'driver-me',
  pendingRideId: 'ride-pending',
  pendingScheduledRideId: 'sched-pending',
  activeRideId: 'ride-active',
};

describe('resolveRevocation', () => {
  it('ignora evento sem rideId', () => {
    const a = resolveRevocation({ rideId: undefined, reason: 'taken' }, baseState);
    expect(a).toEqual({
      clearPendingRide: false,
      clearPendingScheduledRide: false,
      endActiveRide: false,
      logTakenByOther: false,
    });
  });

  it('ignora o eco do próprio aceite (taken por mim mesmo)', () => {
    // Mesmo que o rideId bata com a oferta pendente, NÃO deve limpar nada:
    // é o motorista recebendo o broadcast do seu próprio aceite.
    const a = resolveRevocation(
      { rideId: 'ride-pending', by: 'driver-me', reason: 'taken' },
      baseState
    );
    expect(a.clearPendingRide).toBe(false);
    expect(a.logTakenByOther).toBe(false);
  });

  it('outro motorista aceitou a MINHA corrida pendente → limpa card + audita', () => {
    const a = resolveRevocation(
      { rideId: 'ride-pending', by: 'driver-other', reason: 'taken' },
      baseState
    );
    expect(a.clearPendingRide).toBe(true);
    expect(a.logTakenByOther).toBe(true);
    expect(a.endActiveRide).toBe(false);
  });

  it('passageiro cancelou a corrida imediata pendente → limpa card (para o som)', () => {
    const a = resolveRevocation(
      { rideId: 'ride-pending', reason: 'cancelled' },
      baseState
    );
    expect(a.clearPendingRide).toBe(true);
    expect(a.logTakenByOther).toBe(true);
  });

  it('agendamento pendente revogado (expired) → limpa o popup de agendamento', () => {
    const a = resolveRevocation(
      { rideId: 'sched-pending', reason: 'expired' },
      baseState
    );
    expect(a.clearPendingScheduledRide).toBe(true);
    expect(a.clearPendingRide).toBe(false);
  });

  it('passageiro cancelou a corrida ATIVA já aceita → encerra a corrida ativa', () => {
    const a = resolveRevocation(
      { rideId: 'ride-active', reason: 'cancelled' },
      baseState
    );
    expect(a.endActiveRide).toBe(true);
    // Não é a oferta pendente, então não mexe nos cards de oferta.
    expect(a.clearPendingRide).toBe(false);
    expect(a.clearPendingScheduledRide).toBe(false);
  });

  it('corrida ativa "expirou" NÃO encerra a corrida (só cancelamento encerra)', () => {
    const a = resolveRevocation(
      { rideId: 'ride-active', reason: 'expired' },
      baseState
    );
    expect(a.endActiveRide).toBe(false);
  });

  it('evento de corrida que não é minha (nenhum id bate) → nenhuma ação', () => {
    const a = resolveRevocation(
      { rideId: 'ride-desconhecida', by: 'driver-other', reason: 'cancelled' },
      baseState
    );
    expect(a).toEqual({
      clearPendingRide: false,
      clearPendingScheduledRide: false,
      endActiveRide: false,
      logTakenByOther: false,
    });
  });

  it('concorrência: só o vencedor conserva a corrida; os perdedores limpam', () => {
    // Dois motoristas veem a MESMA corrida em oferta; um terceiro aceitou (by).
    const winnerId = 'driver-winner';
    const loserA: DriverOfferState = {
      driverId: 'driver-A',
      pendingRideId: 'ride-x',
      pendingScheduledRideId: null,
      activeRideId: null,
    };
    const loserB: DriverOfferState = {
      driverId: 'driver-B',
      pendingRideId: 'ride-x',
      pendingScheduledRideId: null,
      activeRideId: null,
    };
    const winner: DriverOfferState = {
      driverId: winnerId,
      pendingRideId: 'ride-x',
      pendingScheduledRideId: null,
      activeRideId: null,
    };
    const evt = { rideId: 'ride-x', by: winnerId, reason: 'taken' as const };

    expect(resolveRevocation(evt, loserA).clearPendingRide).toBe(true);
    expect(resolveRevocation(evt, loserB).clearPendingRide).toBe(true);
    // O vencedor recebe o eco do próprio aceite e NÃO limpa.
    expect(resolveRevocation(evt, winner).clearPendingRide).toBe(false);
  });
});

describe('decideOfferSilence', () => {
  // Modo antigo (uma oferta por vez): quem manda é a cabeça da fila.
  const singleHead: OfferSilenceInput = {
    reason: 'taken',
    multiOffer: false,
    offerInQueue: false,
    clearPendingRide: true,
    alreadyHandled: false,
  };

  it('modo single: silencia quando a revogada é a oferta pendente', () => {
    expect(decideOfferSilence(singleHead).silenceThisOffer).toBe(true);
  });

  it('modo single: NÃO silencia oferta de outra corrida', () => {
    expect(
      decideOfferSilence({ ...singleHead, clearPendingRide: false }).silenceThisOffer
    ).toBe(false);
  });

  it('modo single IGNORA a fila — é a regressão que separa os dois modos', () => {
    // Com a flag desligada, estar na fila não pode bastar: se bastasse, o modo
    // single passaria a silenciar ofertas da cauda que ele nem exibe.
    expect(
      decideOfferSilence({
        ...singleHead,
        offerInQueue: true,
        clearPendingRide: false,
      }).silenceThisOffer
    ).toBe(false);
  });

  it('modo multi: silencia oferta na CAUDA, que a cabeça não enxerga', () => {
    // Este é o defeito concreto que a regra existe para evitar: com múltiplas
    // ofertas, `clearPendingRide` é false para tudo que não é a cabeça, e sem
    // a fila a oferta da cauda continuaria tocando depois de dada a outro.
    expect(
      decideOfferSilence({
        ...singleHead,
        multiOffer: true,
        offerInQueue: true,
        clearPendingRide: false,
      }).silenceThisOffer
    ).toBe(true);
  });

  it('modo multi IGNORA a cabeça quando a oferta saiu da fila', () => {
    expect(
      decideOfferSilence({
        ...singleHead,
        multiOffer: true,
        offerInQueue: false,
        clearPendingRide: true,
      }).silenceThisOffer
    ).toBe(false);
  });

  it.each([
    ['taken', 'taken'],
    ['expired', 'expired'],
    ['cancelled', 'revoked'],
  ] as const)('motivo %s vira alerta %s', (reason, expected) => {
    expect(decideOfferSilence({ ...singleHead, reason }).alertReason).toBe(expected);
  });

  it('audita apenas na primeira vez (broadcastRideRevoked emite dois eventos)', () => {
    expect(decideOfferSilence(singleHead).logTakenByOther).toBe(true);
    expect(
      decideOfferSilence({ ...singleHead, alreadyHandled: true }).logTakenByOther
    ).toBe(false);
  });

  it('o dedupe vale só para a auditoria: o segundo evento AINDA silencia', () => {
    // Silenciar é idempotente e barato; contar a mesma perda duas vezes não é.
    // Se alguém "simplificar" fazendo o dedupe barrar o silenciamento, um card
    // que voltasse depois do primeiro evento ficaria tocando para sempre.
    const segundo = decideOfferSilence({ ...singleHead, alreadyHandled: true });
    expect(segundo.silenceThisOffer).toBe(true);
    expect(segundo.logTakenByOther).toBe(false);
  });

  it('nunca audita o que não silenciou', () => {
    // Invariante: auditar 'taken_by_other' sem ter tirado a oferta deste
    // motorista registraria uma perda de corrida que não aconteceu.
    for (const multiOffer of [false, true]) {
      for (const offerInQueue of [false, true]) {
        for (const clearPendingRide of [false, true]) {
          const d = decideOfferSilence({
            ...singleHead,
            multiOffer,
            offerInQueue,
            clearPendingRide,
          });
          if (!d.silenceThisOffer) expect(d.logTakenByOther).toBe(false);
        }
      }
    }
  });
});
