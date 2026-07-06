import { canReceiveNewRideOffer } from '../rideDispatch';

// Mocka o Supabase para não carregar módulos nativos ao importar
// (rideDispatch → airportFees → systemConfig → supabase → AsyncStorage).
jest.mock('../supabase', () => ({ supabase: { from: jest.fn() } }));

const ACTIVE_ACCEPTED = {
  id: 'active-1',
  status: 'accepted',
  destination_lat: 28.4312,
  destination_lng: -81.3081,
  destination_address: 'Aeroporto de Orlando (MCO)',
  driver_eta_min: 25,
};

const OFFER_FAR = {
  id: 'offer-1',
  destination_lat: 28.5721,
  destination_lng: -81.2,
  destination_address: 'Downtown Orlando',
};

describe('canReceiveNewRideOffer', () => {
  it('sempre permite quando o motorista não tem corrida ativa', () => {
    expect(canReceiveNewRideOffer(null, OFFER_FAR)).toBe(true);
    expect(canReceiveNewRideOffer(undefined, OFFER_FAR)).toBe(true);
  });

  it('permite se a "nova" oferta é a própria corrida ativa (mesmo id)', () => {
    expect(canReceiveNewRideOffer(ACTIVE_ACCEPTED, { id: 'active-1', destination_address: 'qualquer' })).toBe(true);
  });

  it('permite se o status ativo não é um status "ocupado" (ex.: completed/cancelled)', () => {
    expect(canReceiveNewRideOffer({ ...ACTIVE_ACCEPTED, status: 'completed' }, OFFER_FAR)).toBe(true);
    expect(canReceiveNewRideOffer({ ...ACTIVE_ACCEPTED, status: 'cancelled' }, OFFER_FAR)).toBe(true);
  });

  it('bloqueia oferta de destino diferente enquanto ocupado (accepted/in_progress)', () => {
    expect(canReceiveNewRideOffer(ACTIVE_ACCEPTED, OFFER_FAR)).toBe(false);
    expect(canReceiveNewRideOffer({ ...ACTIVE_ACCEPTED, status: 'in_progress' }, OFFER_FAR)).toBe(false);
    expect(canReceiveNewRideOffer({ ...ACTIVE_ACCEPTED, status: 'driver_en_route' }, OFFER_FAR)).toBe(false);
  });

  it('libera quando faltam <=5 minutos para finalizar a corrida atual', () => {
    expect(canReceiveNewRideOffer({ ...ACTIVE_ACCEPTED, driver_eta_min: 5 }, OFFER_FAR)).toBe(true);
    expect(canReceiveNewRideOffer({ ...ACTIVE_ACCEPTED, driver_eta_min: 2 }, OFFER_FAR)).toBe(true);
    expect(canReceiveNewRideOffer({ ...ACTIVE_ACCEPTED, driver_eta_min: 6 }, OFFER_FAR)).toBe(false);
  });

  it('libera se o destino da oferta é o MESMO endereço (case/espaço-insensível)', () => {
    expect(
      canReceiveNewRideOffer(ACTIVE_ACCEPTED, {
        id: 'offer-2',
        destination_address: '  aeroporto de orlando (MCO)  ',
      })
    ).toBe(true);
  });

  it('libera se o destino da oferta está dentro de 1km do destino ativo', () => {
    // ~0.3km do MCO
    expect(
      canReceiveNewRideOffer(ACTIVE_ACCEPTED, {
        id: 'offer-3',
        destination_lat: 28.4339,
        destination_lng: -81.3081,
      })
    ).toBe(true);
  });

  it('bloqueia se o destino da oferta está fora do raio de 1km', () => {
    expect(
      canReceiveNewRideOffer(ACTIVE_ACCEPTED, {
        id: 'offer-4',
        destination_lat: 28.55,
        destination_lng: -81.3081,
      })
    ).toBe(false);
  });

  it('sem ETA nem destino informado na oferta → bloqueia (padrão seguro)', () => {
    expect(canReceiveNewRideOffer(ACTIVE_ACCEPTED, { id: 'offer-5' })).toBe(false);
  });
});
