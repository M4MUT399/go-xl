import {
  shapeTripPayload,
  firstName,
  type RawRide,
  type RawShare,
} from '../tripShare.ts';

// Corrida-base válida e em andamento (sem PII no shape público).
function makeRide(over: Partial<RawRide> = {}): RawRide {
  return {
    status: 'in_progress',
    driver_id: 'driver-1',
    origin_lat: 28.5,
    origin_lng: -81.3,
    origin_address: 'Origem 123',
    destination_lat: 28.4,
    destination_lng: -81.4,
    destination_address: 'Destino 456',
    driver_lat: 28.45,
    driver_lng: -81.35,
    driver_heading: 90,
    driver_eta_min: 7,
    ...over,
  };
}

const FUTURE: RawShare = { expires_at: new Date(Date.now() + 3_600_000).toISOString(), revoked_at: null };
const NOW = Date.now();

describe('shapeTripPayload — decisão de atividade', () => {
  it('not_found quando não há share', () => {
    const out = shapeTripPayload({ share: null, ride: null, driverProfile: null, vehicle: null, driverLocation: null, now: NOW });
    expect(out).toEqual({ active: false, reason: 'not_found' });
  });

  it('expired quando o share foi revogado', () => {
    const out = shapeTripPayload({
      share: { expires_at: new Date(NOW + 3_600_000).toISOString(), revoked_at: new Date(NOW).toISOString() },
      ride: makeRide(), driverProfile: null, vehicle: null, driverLocation: null, now: NOW,
    });
    expect(out).toEqual({ active: false, reason: 'expired' });
  });

  it('expired quando o TTL já passou', () => {
    const out = shapeTripPayload({
      share: { expires_at: new Date(NOW - 1000).toISOString(), revoked_at: null },
      ride: makeRide(), driverProfile: null, vehicle: null, driverLocation: null, now: NOW,
    });
    expect(out).toEqual({ active: false, reason: 'expired' });
  });

  it('not_found quando o share é válido mas a corrida não existe', () => {
    const out = shapeTripPayload({ share: FUTURE, ride: null, driverProfile: null, vehicle: null, driverLocation: null, now: NOW });
    expect(out).toEqual({ active: false, reason: 'not_found' });
  });

  it.each(['completed', 'cancelled'])('ended quando a corrida está %s', (status) => {
    const out = shapeTripPayload({ share: FUTURE, ride: makeRide({ status }), driverProfile: null, vehicle: null, driverLocation: null, now: NOW });
    expect(out).toEqual({ active: false, reason: 'ended' });
  });
});

describe('shapeTripPayload — payload ativo e whitelist', () => {
  it('monta o payload whitelistado com motorista + veículo', () => {
    const out = shapeTripPayload({
      share: FUTURE,
      ride: makeRide(),
      driverProfile: { full_name: 'Carlos Alberto Souza', avatar_url: 'https://x/a.png' },
      vehicle: { model: 'Tesla Model Y', color: 'Preto', plate: 'ABC1D23' },
      driverLocation: null,
      now: NOW,
    });
    expect(out).toEqual({
      active: true,
      status: 'in_progress',
      origin: { lat: 28.5, lng: -81.3, address: 'Origem 123' },
      destination: { lat: 28.4, lng: -81.4, address: 'Destino 456' },
      position: { lat: 28.45, lng: -81.35, heading: 90 },
      eta_min: 7,
      driver: {
        first_name: 'Carlos',
        avatar_url: 'https://x/a.png',
        vehicle: { model: 'Tesla Model Y', color: 'Preto', plate: 'ABC1D23' },
      },
    });
  });

  it('NUNCA vaza preço, telefone ou e-mail — mesmo que as linhas cruas os tragam', () => {
    // Simula linhas do banco carregando campos sensíveis por engano.
    const dirtyRide = { ...makeRide(), price: 149.9, passenger_phone: '+15551234567' } as unknown as RawRide;
    const dirtyProfile = {
      full_name: 'Carlos Alberto',
      avatar_url: null,
      phone: '+15559998888',
      email: 'carlos@example.com',
    } as unknown as { full_name: string | null; avatar_url: string | null };

    const out = shapeTripPayload({
      share: FUTURE, ride: dirtyRide, driverProfile: dirtyProfile,
      vehicle: { model: 'X', color: 'Y', plate: 'Z' }, driverLocation: null, now: NOW,
    });

    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('149.9');
    expect(serialized).not.toContain('+15551234567');
    expect(serialized).not.toContain('+15559998888');
    expect(serialized).not.toContain('carlos@example.com');
    // Só o primeiro nome do motorista aparece — nunca o nome completo.
    expect(serialized).toContain('Carlos');
    expect(serialized).not.toContain('Alberto');
  });

  it('driver = null quando a corrida ainda não tem motorista', () => {
    const out = shapeTripPayload({
      share: FUTURE, ride: makeRide({ driver_id: null }), driverProfile: null, vehicle: null, driverLocation: null, now: NOW,
    });
    expect(out).toMatchObject({ active: true, driver: null });
  });
});

describe('shapeTripPayload — posição ao vivo', () => {
  it('prefere a telemetria gravada na corrida', () => {
    const out = shapeTripPayload({
      share: FUTURE, ride: makeRide({ driver_lat: 1, driver_lng: 2, driver_heading: 45 }),
      driverProfile: null, vehicle: null,
      driverLocation: { lat: 9, lng: 9, heading: 0 }, now: NOW,
    });
    expect(out).toMatchObject({ position: { lat: 1, lng: 2, heading: 45 } });
  });

  it('cai para driver_locations quando a corrida não tem telemetria', () => {
    const out = shapeTripPayload({
      share: FUTURE, ride: makeRide({ driver_lat: null, driver_lng: null, driver_heading: null }),
      driverProfile: null, vehicle: null,
      driverLocation: { lat: 5, lng: 6, heading: 10 }, now: NOW,
    });
    expect(out).toMatchObject({ position: { lat: 5, lng: 6, heading: 10 } });
  });

  it('position = null quando não há telemetria nem última posição', () => {
    const out = shapeTripPayload({
      share: FUTURE, ride: makeRide({ driver_lat: null, driver_lng: null }),
      driverProfile: null, vehicle: null, driverLocation: null, now: NOW,
    });
    expect(out).toMatchObject({ position: null });
  });
});

describe('firstName', () => {
  it('devolve só o primeiro token', () => {
    expect(firstName('Carlos Alberto Souza')).toBe('Carlos');
  });
  it('usa fallback quando vazio/nulo', () => {
    expect(firstName('')).toBe('Motorista');
    expect(firstName(null)).toBe('Motorista');
    expect(firstName(undefined)).toBe('Motorista');
  });
});
