import {
  normalizeGoogleDirections,
  mapGoogleManeuver,
  stripHtml,
  type GoogleDirectionsResponse,
} from '../directions';
import { encodePolyline } from '../sharedRoute';

// Coordenadas reais na região de Orlando (I-4 × Conroy Rd / Millenia), usadas no
// cenário de referência da missão. Codificamos com o MESMO codec do app para
// montar respostas realistas da Google sem depender de rede.
const conroyStep = [
  { lat: 28.4813, lng: -81.4321 },
  { lat: 28.4820, lng: -81.4335 },
  { lat: 28.4831, lng: -81.4350 },
];
const rampStep = [
  { lat: 28.4831, lng: -81.4350 },
  { lat: 28.4845, lng: -81.4360 },
];
const overview = [...conroyStep, ...rampStep];

function sampleResponse(overrides?: Partial<GoogleDirectionsResponse>): GoogleDirectionsResponse {
  return {
    status: 'OK',
    routes: [
      {
        overview_polyline: { points: encodePolyline(overview) },
        legs: [
          {
            distance: { value: 3200 }, // 3.2 km
            duration: { value: 300 }, // 5 min sem trânsito
            duration_in_traffic: { value: 420 }, // 7 min com trânsito
            steps: [
              {
                distance: { value: 1800 },
                duration: { value: 180 },
                html_instructions: 'Turn left onto <b>S Conroy Rd</b>',
                maneuver: 'turn-left',
                polyline: { points: encodePolyline(conroyStep) },
              },
              {
                distance: { value: 1400 },
                duration: { value: 240 },
                html_instructions: 'Take the ramp to <b>I-4 E</b>',
                maneuver: 'ramp-right',
                polyline: { points: encodePolyline(rampStep) },
              },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

describe('normalizeGoogleDirections', () => {
  it('retorna null para respostas inválidas', () => {
    expect(normalizeGoogleDirections(null)).toBeNull();
    expect(normalizeGoogleDirections(undefined)).toBeNull();
    expect(normalizeGoogleDirections({ status: 'ZERO_RESULTS', routes: [] })).toBeNull();
    expect(normalizeGoogleDirections({ status: 'OK', routes: [] })).toBeNull();
  });

  it('PREFERE duration_in_traffic para o ETA (trânsito em tempo real)', () => {
    const r = normalizeGoogleDirections(sampleResponse());
    expect(r).not.toBeNull();
    // 420 s → 7 min (não 5)
    expect(r!.durationMin).toBe(7);
  });

  it('cai em duration puro quando não há duration_in_traffic', () => {
    const resp = sampleResponse();
    delete resp.routes![0].legs![0].duration_in_traffic;
    const r = normalizeGoogleDirections(resp);
    expect(r!.durationMin).toBe(5); // 300 s
  });

  it('converte distância para km', () => {
    const r = normalizeGoogleDirections(sampleResponse());
    expect(r!.distanceKm).toBeCloseTo(3.2, 5);
  });

  it('decodifica a geometria de overview no formato {latitude,longitude}', () => {
    const r = normalizeGoogleDirections(sampleResponse());
    expect(r!.coordinates.length).toBe(overview.length);
    expect(r!.coordinates[0].latitude).toBeCloseTo(overview[0].lat, 4);
    expect(r!.coordinates[0].longitude).toBeCloseTo(overview[0].lng, 4);
  });

  it('popula geometria POR STEP (alta resolução) + manobra mapeada', () => {
    const r = normalizeGoogleDirections(sampleResponse());
    expect(r!.steps.length).toBe(2);
    expect(r!.steps[0].maneuver).toEqual({ type: 'turn', modifier: 'left' });
    expect(r!.steps[0].coordinates!.length).toBe(conroyStep.length);
    expect(r!.steps[0].coordinates![0].latitude).toBeCloseTo(conroyStep[0].lat, 4);
    expect(r!.steps[0].name).toBe('Turn left onto S Conroy Rd');
    expect(r!.steps[1].maneuver).toEqual({ type: 'on ramp', modifier: 'right' });
  });

  it('costura a geometria dos steps quando falta a polyline de overview', () => {
    const resp = sampleResponse();
    delete resp.routes![0].overview_polyline;
    const r = normalizeGoogleDirections(resp);
    // conroyStep(3) + rampStep(2) = 5 pontos
    expect(r!.coordinates.length).toBe(conroyStep.length + rampStep.length);
  });
});

describe('mapGoogleManeuver', () => {
  it('traduz manobras do Google para o vocabulário OSRM-like', () => {
    expect(mapGoogleManeuver('turn-left')).toEqual({ type: 'turn', modifier: 'left' });
    expect(mapGoogleManeuver('turn-sharp-right')).toEqual({ type: 'turn', modifier: 'sharp right' });
    expect(mapGoogleManeuver('uturn-left')).toEqual({ type: 'turn', modifier: 'uturn' });
    expect(mapGoogleManeuver('merge')).toEqual({ type: 'merge', modifier: 'straight' });
    expect(mapGoogleManeuver('roundabout-right')).toEqual({ type: 'roundabout', modifier: 'right' });
    expect(mapGoogleManeuver('keep-left')).toEqual({ type: 'fork', modifier: 'slight left' });
  });

  it('desconhecido/ausente → continue straight (seguro)', () => {
    expect(mapGoogleManeuver(undefined)).toEqual({ type: 'continue', modifier: 'straight' });
    expect(mapGoogleManeuver('something-new')).toEqual({ type: 'continue', modifier: 'straight' });
  });
});

describe('stripHtml', () => {
  it('remove tags e normaliza entidades', () => {
    expect(stripHtml('Turn left onto <b>S Conroy Rd</b>')).toBe('Turn left onto S Conroy Rd');
    expect(stripHtml('Head <b>north</b>&nbsp;on 5th&nbsp;<div>Ave</div>')).toBe('Head north on 5th Ave');
    expect(stripHtml(undefined)).toBe('');
  });
});
