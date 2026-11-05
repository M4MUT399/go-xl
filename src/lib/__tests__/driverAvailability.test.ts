import { driverAvailableNear } from '../driverAvailability';
import { supabase } from '../supabase';

jest.mock('../supabase', () => ({ supabase: { rpc: jest.fn() } }));
const rpc = supabase.rpc as jest.Mock;
const embarque = { lat: 28.43, lng: -81.31 };

describe('driverAvailableNear', () => {
  beforeEach(() => rpc.mockReset());

  it('devolve a resposta do servidor', async () => {
    rpc.mockResolvedValue({ data: false, error: null });
    await expect(driverAvailableNear(embarque)).resolves.toBe(false);
    expect(rpc).toHaveBeenCalledWith('driver_available_near', { p_lat: 28.43, p_lng: -81.31 });
    rpc.mockResolvedValue({ data: true, error: null });
    await expect(driverAvailableNear(embarque)).resolves.toBe(true);
  });

  it('erro do servidor não vira "sem motorista"', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'rate limit' } });
    await expect(driverAvailableNear(embarque)).resolves.toBeNull();
  });

  it('falha de rede não vira "sem motorista"', async () => {
    rpc.mockRejectedValue(new Error('offline'));
    await expect(driverAvailableNear(embarque)).resolves.toBeNull();
  });

  it('resposta lenta não segura o pedido', async () => {
    rpc.mockReturnValue(new Promise(() => {}));
    await expect(driverAvailableNear(embarque, 10)).resolves.toBeNull();
  });
});
