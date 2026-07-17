import {
  shouldPublishFix,
  DEFAULT_PUBLISH_GATE,
  type PublishMark,
} from '../publishGate';
import type { LatLngLite } from '../geo';

// Referência: Conroy Rd (Orlando). ~0.001° de lng ≈ 98 m nesta latitude.
const A: LatLngLite = { lat: 28.4813, lng: -81.4321 };
const near: LatLngLite = { lat: 28.4813, lng: -81.43195 }; // ~15 m a leste
const far: LatLngLite = { lat: 28.4813, lng: -81.4318 }; // ~30 m a leste

describe('shouldPublishFix — cadência tempo + distância', () => {
  it('sempre publica o primeiro fix (sem anterior)', () => {
    expect(shouldPublishFix(null, A, 0)).toBe(true);
  });

  it('respeita o PISO: não publica antes de minIntervalMs, mesmo andando muito', () => {
    const last: PublishMark = { lat: A.lat, lng: A.lng, atMs: 0 };
    // 500 ms depois (< 1000 do piso), mesmo tendo andado ~30 m → não publica.
    expect(shouldPublishFix(last, far, 500)).toBe(false);
  });

  it('publica por DISTÂNCIA quando anda ≥ minDistanceM (fora do piso)', () => {
    const last: PublishMark = { lat: A.lat, lng: A.lng, atMs: 0 };
    // 1500 ms depois (> piso), andou ~30 m (≥ 25) → publica.
    expect(shouldPublishFix(last, far, 1500)).toBe(true);
  });

  it('NÃO publica se andou pouco e ainda não bateu o heartbeat', () => {
    const last: PublishMark = { lat: A.lat, lng: A.lng, atMs: 0 };
    // 1500 ms (> piso, < heartbeat 4000), andou só ~15 m (< 25) → segura.
    expect(shouldPublishFix(last, near, 1500)).toBe(false);
  });

  it('publica por HEARTBEAT quando parado além de maxIntervalMs', () => {
    const last: PublishMark = { lat: A.lat, lng: A.lng, atMs: 0 };
    // Parado no mesmo ponto, mas 4000 ms depois → heartbeat dispara.
    expect(shouldPublishFix(last, A, 4000)).toBe(true);
  });

  it('respeita um config custom', () => {
    const cfg = { minIntervalMs: 2000, maxIntervalMs: 10000, minDistanceM: 50 };
    const last: PublishMark = { lat: A.lat, lng: A.lng, atMs: 0 };
    // 30 m em 3 s: fora do piso custom, mas < 50 m e < 10 s → não publica.
    expect(shouldPublishFix(last, far, 3000, cfg)).toBe(false);
    // O default publicaria (≥ 25 m, > 1 s).
    expect(shouldPublishFix(last, far, 3000, DEFAULT_PUBLISH_GATE)).toBe(true);
  });
});
