import {
  haversineKm,
  isInsideZone,
  computeAirportFees,
  estimateAirportFees,
  type FeeZone,
} from '../airportFees';
import * as systemConfig from '../systemConfig';

// Mocka o Supabase para não carregar módulos nativos ao importar systemConfig.
jest.mock('../supabase', () => ({ supabase: { from: jest.fn() } }));

// Geofences de exemplo (coordenadas reais; taxas fictícias só para o teste).
const MCO: FeeZone = {
  id: 'mco', name: 'Orlando Intl (MCO)',
  lat: 28.4312, lng: -81.3081, radiusKm: 3,
  pickupFee: 2.5, dropoffFee: 2.5,
};
const PORT: FeeZone = {
  id: 'port-canaveral', name: 'Port Canaveral',
  lat: 28.4058, lng: -80.6203, radiusKm: 4,
  dropoffFee: 3, // só cobra no desembarque
};

// Pontos de teste
const INSIDE_MCO = { lat: 28.4312, lng: -81.3081 };      // centro do MCO
const DOWNTOWN = { lat: 28.5383, lng: -81.3792 };        // ~13 km do MCO
const INSIDE_PORT = { lat: 28.4058, lng: -80.6203 };

describe('haversineKm', () => {
  it('distância zero para o mesmo ponto', () => {
    expect(haversineKm(INSIDE_MCO, INSIDE_MCO)).toBeCloseTo(0, 5);
  });
  it('distância plausível entre downtown e MCO (~13 km)', () => {
    const d = haversineKm(DOWNTOWN, INSIDE_MCO);
    expect(d).toBeGreaterThan(10);
    expect(d).toBeLessThan(16);
  });
});

describe('isInsideZone', () => {
  it('centro está dentro', () => {
    expect(isInsideZone(INSIDE_MCO, MCO)).toBe(true);
  });
  it('ponto distante está fora', () => {
    expect(isInsideZone(DOWNTOWN, MCO)).toBe(false);
  });
  it('raio inválido → fora', () => {
    expect(isInsideZone(INSIDE_MCO, { ...MCO, radiusKm: 0 })).toBe(false);
  });
});

describe('computeAirportFees', () => {
  it('sem zonas → total 0', () => {
    expect(computeAirportFees(INSIDE_MCO, DOWNTOWN, [])).toEqual({ total: 0, lines: [] });
  });

  it('cobra pickup quando a origem está na zona', () => {
    const r = computeAirportFees(INSIDE_MCO, DOWNTOWN, [MCO]);
    expect(r.total).toBe(2.5);
    expect(r.lines).toEqual([{ zoneId: 'mco', name: 'Orlando Intl (MCO)', type: 'pickup', amount: 2.5 }]);
  });

  it('cobra dropoff quando o destino está na zona', () => {
    const r = computeAirportFees(DOWNTOWN, INSIDE_MCO, [MCO]);
    expect(r.total).toBe(2.5);
    expect(r.lines[0].type).toBe('dropoff');
  });

  it('cobra pickup E dropoff da mesma zona (ida e volta no aeroporto)', () => {
    const r = computeAirportFees(INSIDE_MCO, INSIDE_MCO, [MCO]);
    expect(r.total).toBe(5);
    expect(r.lines).toHaveLength(2);
  });

  it('soma zonas diferentes (origem no MCO, destino no porto)', () => {
    const r = computeAirportFees(INSIDE_MCO, INSIDE_PORT, [MCO, PORT]);
    // MCO pickup 2.5 + Port dropoff 3
    expect(r.total).toBe(5.5);
    expect(r.lines).toHaveLength(2);
  });

  it('zona sem taxa de pickup não cobra na origem', () => {
    const r = computeAirportFees(INSIDE_PORT, DOWNTOWN, [PORT]);
    expect(r.total).toBe(0);
    expect(r.lines).toHaveLength(0);
  });

  it('ignora zonas malformadas', () => {
    const bad = { id: 'x', name: 'X', radiusKm: 3, pickupFee: 5 } as unknown as FeeZone;
    const r = computeAirportFees(INSIDE_MCO, DOWNTOWN, [bad]);
    expect(r.total).toBe(0);
  });
});

describe('estimateAirportFees', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sem zonas configuradas → total 0', async () => {
    jest.spyOn(systemConfig, 'getConfigValue').mockResolvedValue([] as never);
    const r = await estimateAirportFees(INSIDE_MCO, DOWNTOWN);
    expect(r).toEqual({ total: 0, lines: [] });
  });

  it('aplica as zonas retornadas pela config', async () => {
    jest.spyOn(systemConfig, 'getConfigValue').mockResolvedValue([MCO] as never);
    const r = await estimateAirportFees(INSIDE_MCO, DOWNTOWN);
    expect(r.total).toBe(2.5);
  });

  it('erro na config → total 0 (não lança)', async () => {
    jest.spyOn(systemConfig, 'getConfigValue').mockRejectedValue(new Error('fail') as never);
    const r = await estimateAirportFees(INSIDE_MCO, DOWNTOWN);
    expect(r).toEqual({ total: 0, lines: [] });
  });

  it('propaga a jurisdição', async () => {
    const spy = jest.spyOn(systemConfig, 'getConfigValue').mockResolvedValue([] as never);
    await estimateAirportFees(INSIDE_MCO, DOWNTOWN, 'US-FL');
    expect(spy).toHaveBeenCalledWith('airport_port_fees', [], 'US-FL');
  });
});
