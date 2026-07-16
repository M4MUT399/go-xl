import { buildRideCardModel, type RideCardInput } from '../rideCard';

const base: RideCardInput = {
  phase: 'pickup',
  originAddress: '123 Pickup St',
  destinationAddress: '456 Dropoff Ave',
  passengerName: 'Ana',
  priceLabel: '$24.50',
  distanceLabel: '12.4 mi',
};

describe('buildRideCardModel — fase pickup', () => {
  it('destaca o EMBARQUE (origem) e revela o destino ao expandir', () => {
    const m = buildRideCardModel({ ...base, phase: 'pickup' });
    expect(m.primaryLabelKey).toBe('tripDetails.pickup');
    expect(m.primaryAddress).toBe('123 Pickup St');
    // primeira linha expandida = destino (endereço)
    expect(m.expandedRows[0]).toEqual({
      labelKey: 'tripDetails.dropoff',
      value: '456 Dropoff Ave',
      address: true,
    });
  });

  it('nunca repete o endereço em destaque nas linhas expandidas', () => {
    const m = buildRideCardModel({ ...base, phase: 'pickup' });
    expect(m.expandedRows.some((r) => r.value === m.primaryAddress)).toBe(false);
  });
});

describe('buildRideCardModel — fase dropoff', () => {
  it('destaca o DESTINO e revela onde foi o embarque ao expandir', () => {
    const m = buildRideCardModel({ ...base, phase: 'dropoff' });
    expect(m.primaryLabelKey).toBe('tripDetails.dropoff');
    expect(m.primaryAddress).toBe('456 Dropoff Ave');
    expect(m.expandedRows[0]).toEqual({
      labelKey: 'tripDetails.pickup',
      value: '123 Pickup St',
      address: true,
    });
  });
});

describe('buildRideCardModel — linhas de passageiro e viagem', () => {
  it('inclui o nome do passageiro quando presente', () => {
    const m = buildRideCardModel(base);
    expect(m.expandedRows).toContainEqual({ labelKey: 'driverNav.passenger', value: 'Ana' });
  });

  it('omite o passageiro quando ausente/vazio', () => {
    const m = buildRideCardModel({ ...base, passengerName: '   ' });
    expect(m.expandedRows.some((r) => r.labelKey === 'driverNav.passenger')).toBe(false);
  });

  it('junta preço e distância numa única linha de resumo', () => {
    const m = buildRideCardModel(base);
    expect(m.expandedRows).toContainEqual({
      labelKey: 'driverNav.tripSummary',
      value: '$24.50  ·  12.4 mi',
    });
  });

  it('mostra só o preço quando a distância falta', () => {
    const m = buildRideCardModel({ ...base, distanceLabel: null });
    expect(m.expandedRows).toContainEqual({ labelKey: 'driverNav.tripSummary', value: '$24.50' });
  });

  it('mostra só a distância quando o preço falta', () => {
    const m = buildRideCardModel({ ...base, priceLabel: undefined });
    expect(m.expandedRows).toContainEqual({ labelKey: 'driverNav.tripSummary', value: '12.4 mi' });
  });

  it('omite a linha de viagem quando preço e distância faltam', () => {
    const m = buildRideCardModel({ ...base, priceLabel: null, distanceLabel: null });
    expect(m.expandedRows.some((r) => r.labelKey === 'driverNav.tripSummary')).toBe(false);
  });

  it('ordem das linhas: endereço oposto → passageiro → viagem', () => {
    const m = buildRideCardModel(base);
    expect(m.expandedRows.map((r) => r.labelKey)).toEqual([
      'tripDetails.dropoff',
      'driverNav.passenger',
      'driverNav.tripSummary',
    ]);
  });
});
