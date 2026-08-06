import { resolveRevocation, type DriverOfferState } from '../rideRevocation';

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
