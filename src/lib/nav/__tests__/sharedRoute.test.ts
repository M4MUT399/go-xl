import { haversineMeters, type LatLngLite } from '../geo';
import {
  DEFAULT_SHARED_ROUTE,
  decodePolyline,
  encodePolyline,
  isNewerRoute,
  isOffRoute,
  parseSharedRoute,
  polylineLengthMeters,
  rerouteThrottleElapsed,
} from '../sharedRoute';

describe('codec de polyline (encoded polyline, precisão 5)', () => {
  it('decodifica o exemplo canônico do Google', () => {
    // "_p~iF~ps|U_ulLnnqC_mqNvxq`@" → 3 pontos conhecidos
    const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
    expect(pts).toHaveLength(3);
    expect(pts[0].lat).toBeCloseTo(38.5, 5);
    expect(pts[0].lng).toBeCloseTo(-120.2, 5);
    expect(pts[1].lat).toBeCloseTo(40.7, 5);
    expect(pts[1].lng).toBeCloseTo(-120.95, 5);
    expect(pts[2].lat).toBeCloseTo(43.252, 5);
    expect(pts[2].lng).toBeCloseTo(-126.453, 5);
  });

  it('encode→decode é ida-e-volta até a 5ª casa', () => {
    const coords: LatLngLite[] = [
      { lat: 28.5383, lng: -81.3792 },
      { lat: 28.539, lng: -81.37 },
      { lat: 28.54, lng: -81.36 },
      { lat: 28.5405, lng: -81.3555 },
    ];
    const round = decodePolyline(encodePolyline(coords));
    expect(round).toHaveLength(coords.length);
    round.forEach((p, i) => {
      expect(p.lat).toBeCloseTo(coords[i].lat, 5);
      expect(p.lng).toBeCloseTo(coords[i].lng, 5);
    });
  });

  it('lista vazia ⇄ string vazia', () => {
    expect(encodePolyline([])).toBe('');
    expect(decodePolyline('')).toEqual([]);
    expect(decodePolyline(null)).toEqual([]);
    expect(decodePolyline(undefined)).toEqual([]);
  });
});

describe('isNewerRoute (reconciliação por versão)', () => {
  it('sem rota atual → adota qualquer versão', () => {
    expect(isNewerRoute(1, null)).toBe(true);
    expect(isNewerRoute(7, undefined)).toBe(true);
  });
  it('adota só versões estritamente maiores (ignora repetição/fora de ordem)', () => {
    expect(isNewerRoute(3, 2)).toBe(true);
    expect(isNewerRoute(2, 2)).toBe(false);
    expect(isNewerRoute(1, 2)).toBe(false); // evento antigo do realtime
  });
});

describe('isOffRoute (desvio geométrico)', () => {
  // rota reta leste→oeste na latitude de Orlando
  const route: LatLngLite[] = [
    { lat: 28.54, lng: -81.4 },
    { lat: 28.54, lng: -81.36 },
  ];
  it('rota vazia → nunca fora de rota', () => {
    expect(isOffRoute({ lat: 28.54, lng: -81.38 }, [])).toBe(false);
  });
  it('em cima da via (poucos metros) → não é reroute', () => {
    expect(isOffRoute({ lat: 28.5401, lng: -81.38 }, route)).toBe(false); // ~11 m
  });
  it('longe da via (além de offRouteMeters) → dispara reroute', () => {
    expect(isOffRoute({ lat: 28.5405, lng: -81.38 }, route)).toBe(true); // ~55 m
  });
});

describe('rerouteThrottleElapsed (estrangulador de tempo)', () => {
  it('sem recálculo anterior → liberado', () => {
    expect(rerouteThrottleElapsed(null, 10_000)).toBe(true);
  });
  it('respeita o intervalo mínimo', () => {
    const t0 = 100_000;
    expect(rerouteThrottleElapsed(t0, t0 + DEFAULT_SHARED_ROUTE.minRerouteIntervalMs - 1)).toBe(false);
    expect(rerouteThrottleElapsed(t0, t0 + DEFAULT_SHARED_ROUTE.minRerouteIntervalMs)).toBe(true);
  });
});

describe('parseSharedRoute (linha do banco → modelo)', () => {
  const coords: LatLngLite[] = [
    { lat: 28.54, lng: -81.4 },
    { lat: 28.54, lng: -81.36 },
  ];
  const polyline = encodePolyline(coords);

  it('rota completa → modelo decodificado (destino = último ponto da polyline)', () => {
    const m = parseSharedRoute({
      route_polyline: polyline,
      route_version: 5,
      route_eta_min: 12,
      route_distance_km: 8.4,
    });
    expect(m).not.toBeNull();
    expect(m!.version).toBe(5);
    expect(m!.coordinates).toHaveLength(2);
    expect(m!.etaMin).toBe(12);
    expect(m!.distanceKm).toBe(8.4);
    expect(m!.destination.lat).toBeCloseTo(28.54, 5);
    expect(m!.destination.lng).toBeCloseTo(-81.36, 5); // fim da rota
  });

  it('null/sem versão/sem polyline → null (cai no legado)', () => {
    expect(parseSharedRoute(null)).toBeNull();
    expect(parseSharedRoute({ route_eta_min: 5 })).toBeNull(); // sem versão nem polyline
    expect(parseSharedRoute({ route_version: 1 })).toBeNull(); // sem polyline
    expect(parseSharedRoute({ route_polyline: polyline })).toBeNull(); // sem versão
    expect(parseSharedRoute({ route_polyline: '', route_version: 1 })).toBeNull(); // polyline vazia
  });

  it('eta/distância ausentes → null nesses campos, mas rota válida', () => {
    const m = parseSharedRoute({ route_polyline: polyline, route_version: 1 });
    expect(m).not.toBeNull();
    expect(m!.etaMin).toBeNull();
    expect(m!.distanceKm).toBeNull();
  });
});

describe('polylineLengthMeters', () => {
  it('soma os segmentos (bate com haversine ponto-a-ponto)', () => {
    const coords: LatLngLite[] = [
      { lat: 28.54, lng: -81.4 },
      { lat: 28.54, lng: -81.38 },
      { lat: 28.54, lng: -81.36 },
    ];
    const expected =
      haversineMeters(coords[0], coords[1]) + haversineMeters(coords[1], coords[2]);
    expect(polylineLengthMeters(coords)).toBeCloseTo(expected, 3);
  });
});
