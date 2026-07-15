import {
  shouldPromptDriverConfirmation,
  canConfirmDriver,
  boardingWarning,
  type BoardingConfirmationInput,
} from '../driverBoardingConfirmation';

const base: BoardingConfirmationInput = {
  rideStatus: 'accepted',
  hasDriverAssigned: true,
  hasVehicleAssigned: true,
  alreadyConfirmed: false,
  confirmationRequired: true,
};

describe('shouldPromptDriverConfirmation', () => {
  it('feature desligada → nunca pede confirmação', () => {
    expect(shouldPromptDriverConfirmation({ ...base, confirmationRequired: false })).toBe(false);
  });

  it('já confirmado → não pede de novo', () => {
    expect(shouldPromptDriverConfirmation({ ...base, alreadyConfirmed: true })).toBe(false);
  });

  it('sem motorista atribuído ainda → não pede', () => {
    expect(shouldPromptDriverConfirmation({ ...base, hasDriverAssigned: false })).toBe(false);
  });

  it('sem veículo atribuído ainda → não pede', () => {
    expect(shouldPromptDriverConfirmation({ ...base, hasVehicleAssigned: false })).toBe(false);
  });

  it.each(['accepted', 'driver_en_route'] as const)('status %s com motorista+veículo → pede confirmação', (rideStatus) => {
    expect(shouldPromptDriverConfirmation({ ...base, rideStatus })).toBe(true);
  });

  it.each(['scheduled', 'requesting', 'in_progress', 'completed', 'cancelled'] as const)(
    'status %s → não pede (fora da janela de pré-embarque)',
    (rideStatus) => {
      expect(shouldPromptDriverConfirmation({ ...base, rideStatus })).toBe(false);
    }
  );
});

describe('canConfirmDriver', () => {
  it('caso normal (accepted, motorista+veículo, não confirmado) → ok', () => {
    expect(canConfirmDriver(base)).toEqual({ ok: true });
  });

  it('driver_en_route também é uma janela válida', () => {
    expect(canConfirmDriver({ ...base, rideStatus: 'driver_en_route' })).toEqual({ ok: true });
  });

  it('confirmação tardia em in_progress ainda é tolerada', () => {
    expect(canConfirmDriver({ ...base, rideStatus: 'in_progress' })).toEqual({ ok: true });
  });

  it('já confirmado → erro already_confirmed (idempotência)', () => {
    expect(canConfirmDriver({ ...base, alreadyConfirmed: true })).toEqual({ ok: false, error: 'already_confirmed' });
  });

  it('sem motorista atribuído → erro no_driver_assigned', () => {
    expect(canConfirmDriver({ ...base, hasDriverAssigned: false })).toEqual({ ok: false, error: 'no_driver_assigned' });
  });

  it('sem veículo atribuído → erro no_driver_assigned', () => {
    expect(canConfirmDriver({ ...base, hasVehicleAssigned: false })).toEqual({ ok: false, error: 'no_driver_assigned' });
  });

  it.each(['scheduled', 'requesting', 'completed', 'cancelled'] as const)(
    'status %s → erro ride_not_active',
    (rideStatus) => {
      expect(canConfirmDriver({ ...base, rideStatus })).toEqual({ ok: false, error: 'ride_not_active' });
    }
  );
});

describe('boardingWarning', () => {
  it('feature desligada → none', () => {
    expect(boardingWarning({ ...base, confirmationRequired: false })).toBe('none');
  });

  it('já confirmado → none', () => {
    expect(boardingWarning({ ...base, alreadyConfirmed: true })).toBe('none');
  });

  it('feature ligada e ainda não confirmado → unconfirmed', () => {
    expect(boardingWarning(base)).toBe('unconfirmed');
  });
});
