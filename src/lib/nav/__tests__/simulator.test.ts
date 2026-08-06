import { simulateRouteFixes } from '../simulator';
import { haversineMeters } from '../geo';

describe('nav/simulator — fixes ao longo da rota', () => {
  const eastward = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 0.01 }, // ~1113 m para leste
  ];

  test('rota vazia → nenhum fix', () => {
    expect(simulateRouteFixes([])).toEqual([]);
  });

  test('rota de um ponto → um fix parado nesse ponto', () => {
    const fixes = simulateRouteFixes([{ lat: 5, lng: 6 }]);
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toMatchObject({ lat: 5, lng: 6, speed: 0 });
  });

  test('começa na origem e termina exatamente no destino', () => {
    const fixes = simulateRouteFixes(eastward, { speedMps: 13.9, intervalMs: 1000 });
    expect(fixes.length).toBeGreaterThan(2);
    expect(fixes[0].lat).toBeCloseTo(0, 9);
    expect(fixes[0].lng).toBeCloseTo(0, 9);
    const last = fixes[fixes.length - 1];
    expect(last.lat).toBeCloseTo(0, 9);
    expect(last.lng).toBeCloseTo(0.01, 9);
  });

  test('timestamps avançam de intervalMs em intervalMs', () => {
    const fixes = simulateRouteFixes(eastward, { speedMps: 13.9, intervalMs: 1000, startTimeMs: 0 });
    expect(fixes[0].timestampMs).toBe(0);
    expect(fixes[1].timestampMs).toBe(1000);
    expect(fixes[2].timestampMs).toBe(2000);
  });

  test('cada passo avança ~speed·interval metros', () => {
    const fixes = simulateRouteFixes(eastward, { speedMps: 13.9, intervalMs: 1000 });
    const d = haversineMeters(fixes[0], fixes[1]);
    expect(d).toBeCloseTo(13.9, 0); // dentro de ~0.5 m
  });

  test('rumo aponta na direção do deslocamento (leste ≈ 90°)', () => {
    const fixes = simulateRouteFixes(eastward, { speedMps: 13.9, intervalMs: 1000 });
    expect(fixes[1].heading).toBeCloseTo(90, 0);
  });
});
