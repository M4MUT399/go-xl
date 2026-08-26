import { canReceiveNewRideOffer, driversFreeForOffer } from '../rideDispatch';

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

describe('driversFreeForOffer', () => {
  const DRIVERS = ['livre-1', 'ocupado-1', 'livre-2'];
  const busy = (driver_id: string, over: Partial<typeof ACTIVE_ACCEPTED> = {}) => ({
    ...ACTIVE_ACCEPTED,
    ...over,
    driver_id,
  });

  it('remove do leque o motorista com corrida ativa para outro destino', () => {
    expect(driversFreeForOffer(DRIVERS, [busy('ocupado-1')], OFFER_FAR)).toEqual([
      'livre-1',
      'livre-2',
    ]);
  });

  it('preserva a ordem original e não inventa motorista que não estava no leque', () => {
    const rows = [busy('ocupado-1'), busy('nem-estava-no-leque')];
    expect(driversFreeForOffer(DRIVERS, rows, OFFER_FAR)).toEqual(['livre-1', 'livre-2']);
  });

  it('mantém o ocupado quando a oferta vai para o mesmo destino dele', () => {
    const offerSameDest = { id: 'offer-6', destination_address: 'Aeroporto de Orlando (MCO)' };
    expect(driversFreeForOffer(DRIVERS, [busy('ocupado-1')], offerSameDest)).toEqual(DRIVERS);
  });

  it('mantém o ocupado que está a <=5min de terminar', () => {
    const rows = [busy('ocupado-1', { driver_eta_min: 4 })];
    expect(driversFreeForOffer(DRIVERS, rows, OFFER_FAR)).toEqual(DRIVERS);
  });

  it('ignora linha ocupada sem driver_id em vez de derrubar o leque', () => {
    const rows = [{ ...ACTIVE_ACCEPTED, driver_id: null }];
    expect(driversFreeForOffer(DRIVERS, rows, OFFER_FAR)).toEqual(DRIVERS);
  });

  it('sem linhas de ocupados (lista vazia, null ou undefined) libera todo o leque', () => {
    // É este o caminho que o cliente enxergava sob a RLS de `rides`: nunca via
    // corrida alheia, então o filtro nunca recusava ninguém. No servidor a lista
    // vazia significa de fato "ninguém ocupado".
    expect(driversFreeForOffer(DRIVERS, [], OFFER_FAR)).toEqual(DRIVERS);
    expect(driversFreeForOffer(DRIVERS, null, OFFER_FAR)).toEqual(DRIVERS);
    expect(driversFreeForOffer(DRIVERS, undefined, OFFER_FAR)).toEqual(DRIVERS);
  });

  it('leque vazio continua vazio', () => {
    expect(driversFreeForOffer([], [busy('ocupado-1')], OFFER_FAR)).toEqual([]);
  });
});
