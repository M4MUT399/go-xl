import { logRideOfferEvent } from '../rideOfferEvents';

const mockInsert = jest.fn(
  (): Promise<{ error: { message: string } | null }> => Promise.resolve({ error: null })
);

jest.mock('../supabase', () => ({
  supabase: { from: jest.fn(() => ({ insert: mockInsert })) },
}));

beforeEach(() => {
  mockInsert.mockClear();
  mockInsert.mockResolvedValue({ error: null });
});

describe('logRideOfferEvent', () => {
  it('insere o payload completo do evento', async () => {
    await logRideOfferEvent('ride-1', 'driver-1', 'accepted', {
      reason: 'ok',
      metadata: { source: 'test' },
    });
    expect(mockInsert).toHaveBeenCalledWith({
      ride_id: 'ride-1',
      driver_id: 'driver-1',
      event: 'accepted',
      reason: 'ok',
      metadata: { source: 'test' },
    });
  });

  it('preenche reason/metadata com null quando ausentes', async () => {
    await logRideOfferEvent('ride-2', 'driver-2', 'received');
    expect(mockInsert).toHaveBeenCalledWith({
      ride_id: 'ride-2',
      driver_id: 'driver-2',
      event: 'received',
      reason: null,
      metadata: null,
    });
  });

  it('é no-op sem rideId ou driverId', async () => {
    await logRideOfferEvent(undefined, 'driver', 'received');
    await logRideOfferEvent('ride', undefined, 'received');
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it('nunca lança quando o insert rejeita (best-effort)', async () => {
    mockInsert.mockRejectedValueOnce(new Error('boom'));
    await expect(logRideOfferEvent('r', 'd', 'failed')).resolves.toBeUndefined();
  });

  it('nunca lança quando o insert retorna erro', async () => {
    mockInsert.mockResolvedValueOnce({ error: { message: 'rls denied' } });
    await expect(logRideOfferEvent('r', 'd', 'rejected')).resolves.toBeUndefined();
  });
});
