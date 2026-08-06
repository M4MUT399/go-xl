import {
  isPlausibleStep,
  matchToRoute,
  initialMatchState,
  MAX_PLAUSIBLE_SPEED_MPS,
  OFF_ROUTE_N,
  type LatLngLite,
} from '../mapMatch';
import { bearingBetween } from '../geo';

// Cenário de referência: I-4 × Conroy Rd (Orlando). Uma perna indo para LESTE
// ao longo de Conroy e a rampa subindo para a I-4.
const conroy: LatLngLite[] = [
  { lat: 28.4813, lng: -81.4321 },
  { lat: 28.4814, lng: -81.4300 },
  { lat: 28.4815, lng: -81.4280 },
  { lat: 28.4816, lng: -81.4260 },
  { lat: 28.4817, lng: -81.4240 },
];

describe('isPlausibleStep (anti-teletransporte)', () => {
  it('aceita o primeiro fix (sem anterior)', () => {
    expect(isPlausibleStep(null, conroy[0], 1)).toBe(true);
  });

  it('aceita passo dentro do teto de velocidade', () => {
    // ~200 m em 10 s = 20 m/s (72 km/h) → plausível.
    expect(isPlausibleStep(conroy[0], conroy[1], 10)).toBe(true);
  });

  it('rejeita salto que implica velocidade impossível', () => {
    // ~2 km (0→4) em 1 s → muito acima de 60 m/s.
    expect(isPlausibleStep(conroy[0], conroy[4], 1)).toBe(false);
  });

  it('rejeita dt não-positivo (fix fora de ordem)', () => {
    expect(isPlausibleStep(conroy[0], conroy[1], 0)).toBe(false);
    expect(isPlausibleStep(conroy[0], conroy[1], -3)).toBe(false);
  });

  it('respeita um teto custom', () => {
    expect(isPlausibleStep(conroy[0], conroy[1], 10, 5)).toBe(false);
    expect(MAX_PLAUSIBLE_SPEED_MPS).toBe(60);
  });
});

describe('matchToRoute — casamento básico', () => {
  it('rota com < 2 pontos → null', () => {
    expect(matchToRoute(conroy[0], null, [conroy[0]])).toBeNull();
  });

  it('cola o ponto no segmento certo e reporta distância pequena', () => {
    // Ponto quase em cima do 2º vértice, ligeiramente ao norte.
    const p = { lat: 28.4816, lng: -81.4280 };
    const r = matchToRoute(p, 90, conroy, initialMatchState)!;
    expect(r).not.toBeNull();
    expect(r.distanceM).toBeLessThan(40);
    expect(r.offRoute).toBe(false);
    expect(r.confidence).toBeGreaterThan(0.4);
  });

  it('avança o índice de forma MONOTÔNICA conforme progride', () => {
    let st = initialMatchState;
    const idxs: number[] = [];
    for (const v of conroy) {
      const r = matchToRoute(v, 90, conroy, st)!;
      st = r.state;
      idxs.push(r.index);
    }
    // Índices nunca decrescem.
    for (let i = 1; i < idxs.length; i++) {
      expect(idxs[i]).toBeGreaterThanOrEqual(idxs[i - 1]);
    }
    expect(idxs[idxs.length - 1]).toBeGreaterThan(idxs[0]);
  });
});

describe('matchToRoute — janela monotônica evita salto para trás', () => {
  // Rota que VOLTA para perto do início (alça de retorno): vai para leste e
  // depois retorna para oeste numa via paralela logo ao norte. Um ponto no fim
  // fica geograficamente perto de vértices do começo — o snap global cairia lá.
  const loop: LatLngLite[] = [
    { lat: 28.4800, lng: -81.4300 }, // 0 início (oeste)
    { lat: 28.4800, lng: -81.4280 }, // 1 leste
    { lat: 28.4800, lng: -81.4260 }, // 2 leste (ponta)
    { lat: 28.4802, lng: -81.4280 }, // 3 volta oeste (paralela ao norte)
    { lat: 28.4802, lng: -81.4300 }, // 4 volta oeste
  ];

  it('não regride para o trecho já percorrido', () => {
    // Avança até a ponta (índice ~2).
    let st = initialMatchState;
    st = matchToRoute(loop[1], 90, loop, st)!.state;
    const atTip = matchToRoute(loop[2], 90, loop, st)!;
    st = atTip.state;
    expect(atTip.index).toBeGreaterThanOrEqual(1);

    // Agora um ponto na perna de volta (perto de loop[3]), rumo OESTE (270°).
    const back = { lat: 28.4802, lng: -81.4281 };
    const r = matchToRoute(back, 270, loop, st)!;
    // Deve casar na perna de volta (índice ≥ 2), NÃO no trecho inicial (0/1).
    expect(r.index).toBeGreaterThanOrEqual(2);
  });
});

describe('matchToRoute — score composto usa o rumo', () => {
  it('desempata por rumo quando a distância é parecida', () => {
    // Ponto equidistante entre duas pernas antiparalelas; o rumo decide.
    const twoLegs: LatLngLite[] = [
      { lat: 28.4800, lng: -81.4300 },
      { lat: 28.4800, lng: -81.4260 }, // perna leste (bearing ~90)
      { lat: 28.4801, lng: -81.4300 }, // perna oeste (bearing ~270)
    ];
    const mid = { lat: 28.48005, lng: -81.4280 };
    // Rumo leste → prefere a 1ª perna (índice 0).
    const east = matchToRoute(mid, bearingBetween(twoLegs[0], twoLegs[1]), twoLegs, initialMatchState)!;
    expect(east.index).toBe(0);
  });
});

describe('matchToRoute — histerese de off-route por contagem', () => {
  it('só declara off-route após N fixes consecutivos fora', () => {
    // Ponto bem longe da rota (centenas de metros ao norte).
    const far = { lat: 28.4900, lng: -81.4280 };
    let st = initialMatchState;
    for (let i = 1; i < OFF_ROUTE_N; i++) {
      const r = matchToRoute(far, 90, conroy, st)!;
      st = r.state;
      expect(r.offRoute).toBe(false); // ainda dentro da histerese
    }
    const rN = matchToRoute(far, 90, conroy, st)!;
    expect(rN.offRoute).toBe(true); // no N-ésimo, confirma
  });

  it('um único fix bom zera o contador', () => {
    const far = { lat: 28.4900, lng: -81.4280 };
    // Ponto bom À FRENTE (o casamento é monotônico → precisa estar na janela,
    // não atrás do índice já avançado pelos fixes anteriores).
    const near = { lat: 28.4816, lng: -81.4260 }; // = conroy[3]
    let st = initialMatchState;
    st = matchToRoute(far, 90, conroy, st)!.state;
    st = matchToRoute(far, 90, conroy, st)!.state;
    expect(st.offRouteCount).toBe(2);
    const good = matchToRoute(near, 90, conroy, st)!;
    expect(good.distanceM).toBeLessThan(40);
    expect(good.state.offRouteCount).toBe(0);
    expect(good.offRoute).toBe(false);
  });
});
