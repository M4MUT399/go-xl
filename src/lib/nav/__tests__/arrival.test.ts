import {
  updateArrival,
  updateArrivalAt,
  initialArrivalState,
  DEFAULT_ARRIVAL,
  type ArrivalState,
} from '../arrival';
import type { LatLngLite } from '../geo';

describe('updateArrival — geofence de chegada com histerese', () => {
  it('não declara chegada quando longe', () => {
    const r = updateArrival(initialArrivalState, 120);
    expect(r.arrived).toBe(false);
    expect(r.justArrived).toBe(false);
  });

  it('declara chegada ao entrar em enterM (≤ 50 m)', () => {
    const r = updateArrival(initialArrivalState, 40);
    expect(r.arrived).toBe(true);
    expect(r.justArrived).toBe(true);
  });

  it('justArrived só na BORDA de subida (não repete depois)', () => {
    const first = updateArrival(initialArrivalState, 30);
    expect(first.justArrived).toBe(true);
    const second = updateArrival(first.state, 25);
    expect(second.arrived).toBe(true);
    expect(second.justArrived).toBe(false);
  });

  it('mantém chegada na ZONA DE HISTERESE (entre enterM e exitM)', () => {
    const arrived: ArrivalState = { arrived: true };
    // 65 m: acima de enterM (50) mas abaixo de exitM (80) → continua chegado.
    const r = updateArrival(arrived, 65);
    expect(r.arrived).toBe(true);
  });

  it('cancela chegada só ao passar de exitM (> 80 m)', () => {
    const arrived: ArrivalState = { arrived: true };
    expect(updateArrival(arrived, 81).arrived).toBe(false);
    // Exatamente no exitM ainda conta como chegado (só cancela ACIMA).
    expect(updateArrival(arrived, 80).arrived).toBe(true);
  });

  it('respeita config custom', () => {
    const cfg = { enterM: 20, exitM: 30 };
    expect(updateArrival(initialArrivalState, 25, cfg).arrived).toBe(false);
    expect(updateArrival(initialArrivalState, 18, cfg).arrived).toBe(true);
    expect(DEFAULT_ARRIVAL).toEqual({ enterM: 50, exitM: 80 });
  });
});

describe('updateArrivalAt — a partir dos pontos', () => {
  const target: LatLngLite = { lat: 28.4813, lng: -81.4321 };

  it('alvo/ponto nulo → mantém estado, sem chegada', () => {
    const r = updateArrivalAt(initialArrivalState, null, target);
    expect(r.arrived).toBe(false);
    expect(r.distanceM).toBe(Infinity);
  });

  it('em cima do alvo → chega', () => {
    const r = updateArrivalAt(initialArrivalState, { lat: 28.4813, lng: -81.4321 }, target);
    expect(r.arrived).toBe(true);
    expect(r.distanceM).toBeLessThan(5);
  });

  it('~200 m ao norte → não chega', () => {
    const north = { lat: 28.4831, lng: -81.4321 }; // ~200 m
    const r = updateArrivalAt(initialArrivalState, north, target);
    expect(r.arrived).toBe(false);
    expect(r.distanceM).toBeGreaterThan(150);
  });
});
