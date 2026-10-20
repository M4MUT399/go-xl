// airportFees puxa systemConfig → supabase → AsyncStorage nativo; aqui só a
// conta de distância importa.
jest.mock('../systemConfig', () => ({ getConfigValue: jest.fn() }));
jest.mock('../edgeFunction', () => ({ callEdgeFunction: jest.fn() }));

import {
  detectAirport, guessTerminal, isValidFlightNumber, formatFlightNumber, normalizeFlightNumber,
} from '../airportTrip';
import { mergeSuggestions, PlaceSuggestion } from '../geocoding';

const MCO = { lat: 28.4312, lng: -81.3081 };
const DOWNTOWN = { lat: 28.5383, lng: -81.3792 };

describe('detectAirport', () => {
  it('tipo airport da Google no MCO → MCO com os três terminais', () => {
    const m = detectAirport({ name: 'Orlando International Airport', address: 'Orlando, FL', types: ['airport'], ...MCO });
    expect(m?.code).toBe('MCO');
    expect(m?.terminals).toEqual(['Terminal A', 'Terminal B', 'Terminal C']);
  });

  it('sugestão do Nominatim (sem tipos) pelo nome → aeroporto', () => {
    const m = detectAirport({ name: 'Orlando International Airport', address: 'Orlando, FL', ...MCO });
    expect(m?.code).toBe('MCO');
  });

  it('ponto dentro do MCO sem "airport" no nome (locadora, portão) → MCO', () => {
    const m = detectAirport({ name: 'Alamo Rent A Car', address: '1 Jeff Fuqua Blvd', types: ['car_rental'], ...MCO });
    expect(m?.code).toBe('MCO');
  });

  it('hotel dentro do aeroporto NÃO é viagem para voo', () => {
    const m = detectAirport({
      name: 'Hyatt Regency Orlando International Airport', address: '9300 Jeff Fuqua Blvd',
      types: ['lodging', 'hotel'], ...MCO,
    });
    expect(m).toBeNull();
  });

  it('aeroporto fora da lista conhecida → terminal em texto livre', () => {
    const m = detectAirport({
      name: 'Hartsfield-Jackson Atlanta International Airport', address: 'Atlanta, GA',
      types: ['airport'], lat: 33.6407, lng: -84.4277,
    });
    expect(m).toEqual(expect.objectContaining({ code: null, terminals: null }));
  });

  it('endereço comum no centro → não é aeroporto', () => {
    expect(detectAirport({ name: 'Dr. Phillips Center', address: 'S Magnolia Ave', types: ['performing_arts_theater'], ...DOWNTOWN })).toBeNull();
  });
});

describe('guessTerminal', () => {
  const mco = detectAirport({ name: 'MCO', address: '', types: ['airport'], ...MCO })!;

  it('lê o terminal do nome do lugar', () => {
    expect(guessTerminal(mco, 'Terminal C - Orlando International Airport')).toBe('Terminal C');
  });
  it('sem pista no nome, não chuta', () => {
    expect(guessTerminal(mco, 'Orlando International Airport')).toBe('');
  });
  it('aeroporto de terminal único já vem escolhido', () => {
    const pbi = detectAirport({ name: 'PBI', address: '', types: ['airport'], lat: 26.6832, lng: -80.0956 })!;
    expect(guessTerminal(pbi, 'Palm Beach International Airport')).toBe('Main Terminal');
  });
});

describe('número do voo', () => {
  it.each(['AA 1234', 'aa1234', 'B6 25', 'G4 1101', 'JBU25', 'LA8084'])('aceita %s', (v) => {
    expect(isValidFlightNumber(v)).toBe(true);
  });
  it.each(['', '1234', 'AMERICAN', 'AA', 'AA 12345'])('recusa "%s"', (v) => {
    expect(isValidFlightNumber(v)).toBe(false);
  });
  it('normaliza e formata', () => {
    expect(normalizeFlightNumber(' aa-1234 ')).toBe('AA1234');
    expect(formatFlightNumber('aa1234')).toBe('AA 1234');
  });
});

describe('mergeSuggestions', () => {
  const a: PlaceSuggestion = { placeId: 'p1', shortName: 'Hilton', address: 'Orlando' };
  const aComCoord: PlaceSuggestion = { ...a, location: { lat: 1, lng: 2 } };
  const b: PlaceSuggestion = { placeId: 'p2', shortName: 'Clinic', address: 'Lake Nona', location: { lat: 3, lng: 4 } };

  it('mantém a ordem da primeira lista e soma só os novos', () => {
    expect(mergeSuggestions([a], [aComCoord, b]).map((s) => s.placeId)).toEqual(['p1', 'p2']);
  });
  it('mesmo lugar nas duas: fica com coordenada (dispensa o details)', () => {
    expect(mergeSuggestions([a], [aComCoord])[0].location).toEqual({ lat: 1, lng: 2 });
  });
});
