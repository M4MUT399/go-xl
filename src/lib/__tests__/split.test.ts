import {
  calculateSplit,
  composeRideSplit,
  DEFAULT_DRIVER_SHARE,
  DRIVER_SHARE,
  PLATFORM_SHARE,
} from '../split';

describe('calculateSplit', () => {
  it('usa a fatia padrão (80/20) quando nenhuma é informada', () => {
    const { driverAmount, platformFee } = calculateSplit(100);
    expect(driverAmount).toBe(80);
    expect(platformFee).toBe(20);
  });

  it('aplica a faixa premium (85/15) dos 100 primeiros motoristas', () => {
    const { driverAmount, platformFee } = calculateSplit(100, 0.85);
    expect(driverAmount).toBe(85);
    expect(platformFee).toBe(15);
  });

  it('aplica a faixa padrão (80/20) do 101º motorista em diante', () => {
    const { driverAmount, platformFee } = calculateSplit(100, 0.8);
    expect(driverAmount).toBe(80);
    expect(platformFee).toBe(20);
  });

  // ANTES ESTE BLOCO SÓ AFIRMAVA `driverAmount + platformFee === total`, com o
  // mesmo vício que o arquivo já denuncia lá embaixo para `composeRideSplit`:
  // `platformCents` é DEFINIDO como `priceCents - driverCents` (split.ts:91),
  // então a igualdade valia por construção — continuaria verde com a fatia do
  // motorista inteira errada, que é justamente o número que importa aqui.
  //
  // Agora os dois lados são conferidos à mão:
  // `round-half-away-from-zero(centavos × milésimos ÷ 1000)` para o motorista,
  // a diferença exata para a plataforma. A soma segue travada, mas agora como
  // consequência de valores verificados, não como a única coisa afirmada.
  it('valores conferidos à mão nas duas faixas de repasse (85/15 e 80/20)', () => {
    const casos: Array<[number, number, number, number]> = [
      // total,  share, driverAmount, platformFee
      [12.34, 0.85, 10.49, 1.85], // 1234×850/1000 = 1048.9   → 1049
      [12.34, 0.8, 9.87, 2.47], // 1234×800/1000 =  987.2   →  987
      [57.89, 0.85, 49.21, 8.68], // 5789×850/1000 = 4920.65  → 4921
      [57.89, 0.8, 46.31, 11.58], // 5789×800/1000 = 4631.2   → 4631
      [103.5, 0.85, 87.98, 15.52], // 10350×850/1000 = 8797.5 → 8798 (empate: para LONGE do zero)
      [103.5, 0.8, 82.8, 20.7], // 10350×800/1000 = 8280 exato
      [7.07, 0.85, 6.01, 1.06], // 707×850/1000 = 600.95    →  601
      [7.07, 0.8, 5.66, 1.41], // 707×800/1000 = 565.6     →  566
      [250.01, 0.85, 212.51, 37.5], // 25001×850/1000 = 21250.85 → 21251
      [250.01, 0.8, 200.01, 50], // 25001×800/1000 = 20000.8  → 20001
    ];
    for (const [total, share, driver, plataforma] of casos) {
      const split = calculateSplit(total, share);
      expect({ total, share, ...split }).toEqual({
        total,
        share,
        driverAmount: driver,
        platformFee: plataforma,
      });
      // E nenhum centavo evapora nem nasce entre os dois lados.
      expect(Math.round((split.driverAmount + split.platformFee) * 100) / 100).toBe(
        Math.round(total * 100) / 100,
      );
    }
  });

  it('arredonda a fatia do motorista para centavos', () => {
    // 33.33 * 0.85 = 28.3305 → 28.33; plataforma = 33.33 - 28.33 = 5.00
    const { driverAmount, platformFee } = calculateSplit(33.33, 0.85);
    expect(driverAmount).toBe(28.33);
    expect(platformFee).toBe(5);
  });

  it('cai no padrão quando a fatia é inválida (NULL/negativa/>1)', () => {
    // `null` (e não `undefined`) porque é assim que driver_share_percent chega
    // de um perfil sem faixa atribuída: o supabase-js entrega NULL do banco como
    // `null`, e `null` NÃO dispara o parâmetro-default do JavaScript. Passar
    // `undefined` aqui testaria a semântica de default do JS, não a guarda de
    // `Number.isFinite(...) && > 0 && <= 1` — que é o que precisa segurar o
    // valor corrompido.
    expect(calculateSplit(100, null as unknown as number).driverAmount).toBe(80);
    expect(calculateSplit(100, 0).driverAmount).toBe(80);
    expect(calculateSplit(100, -0.5).driverAmount).toBe(80);
    expect(calculateSplit(100, 1.5).driverAmount).toBe(80);
    expect(calculateSplit(100, NaN).driverAmount).toBe(80);
    // O parâmetro-default (undefined) leva ao mesmo lugar, por outro caminho.
    expect(calculateSplit(100, undefined).driverAmount).toBe(80);
  });

  it('mantém os exports de compatibilidade (fallback de exibição)', () => {
    expect(DEFAULT_DRIVER_SHARE).toBe(0.8);
    expect(DRIVER_SHARE).toBe(0.8);
    expect(PLATFORM_SHARE).toBeCloseTo(0.2, 10);
  });
});

// Estes casos são a REFERÊNCIA da economia que public.compute_ride_split (0065)
// precisa reproduzir centavo a centavo. ATENÇÃO AO QUE ELES NÃO SÃO: eles NÃO
// exercitam o Postgres. Não há harness de banco neste repositório, então nada
// aqui prova que o trigger, o GUC ou a função SQL se comportam como o descrito —
// isso só se verifica contra um Postgres de verdade. O que estes testes travam
// é a fórmula, para que uma mudança em TS que divirja do SQL fique visível.
describe('composeRideSplit (fórmula espelhada em public.compute_ride_split)', () => {
  it('sem pedágio nem taxa, é o split simples', () => {
    expect(composeRideSplit(100, 0, 0, 0.85)).toEqual({ driverAmount: 85, platformFee: 15 });
  });

  it('pedágio é pass-through: sai da base de comissão e vai inteiro ao motorista', () => {
    // price 110 = tarifa 100 + pedágio 10. Comissão só sobre os 100.
    const { driverAmount, platformFee } = composeRideSplit(110, 10, 0, 0.85);
    expect(driverAmount).toBe(95); // 85 do split + 10 de pedágio
    expect(platformFee).toBe(15);
  });

  it('taxa de aeroporto/porto é regulatória: sai da base e fica com a plataforma', () => {
    // price 110 = tarifa 100 + taxa 10.
    const { driverAmount, platformFee } = composeRideSplit(110, 0, 10, 0.85);
    expect(driverAmount).toBe(85);
    expect(platformFee).toBe(25); // 15 do split + 10 de taxa
  });

  it('pedágio e taxa juntos', () => {
    const { driverAmount, platformFee } = composeRideSplit(117.5, 10, 7.5, 0.8);
    expect(driverAmount).toBe(90); // (117.5-17.5)*0.8 = 80, +10 de pedágio
    expect(platformFee).toBe(27.5); // 20 do split + 7.5 de taxa
  });

  // ANTES ESTE BLOCO ERA `driverAmount + platformFee === price`, o que é
  // tautológico: platformFee é DEFINIDO como o resto, então a igualdade valia
  // por construção mesmo com a comissão inteira errada. Agora os valores são
  // calculados à mão (tarifa = price - toll - venue; corte do motorista com
  // desempate para longe do zero; resto para a plataforma; depois soma-se o
  // pedágio de um lado e a taxa do outro) — é a ECONOMIA que está travada aqui,
  // não a aritmética de subtração.
  it('valores conferidos à mão, com pedágio e taxa', () => {
    const casos: Array<[number, number, number, number, number, number]> = [
      // price,   toll, venue, share, driverAmount, platformFee
      [49.77, 0, 0, 0.85, 42.3, 7.47], // fare 49.77 → 42.3045 → 42.30
      [49.77, 0, 0, 0.8, 39.82, 9.95], // fare 49.77 → 39.816  → 39.82
      [63.41, 5.25, 0, 0.85, 54.69, 8.72], // fare 58.16 → 49.436 → 49.44 (+5.25 de pedágio)
      [88.03, 0, 3.5, 0.85, 71.85, 16.18], // fare 84.53 → 71.8505 → 71.85
      [124.99, 7.35, 6.15, 0.85, 102.12, 22.87], // fare 111.49 → 94.7665 → 94.77
      [8.9, 0, 0, 0.8, 7.12, 1.78], // fare 8.90 → 7.12
    ];
    for (const [price, toll, venue, share, driverAmount, platformFee] of casos) {
      expect(composeRideSplit(price, toll, venue, share)).toEqual({ driverAmount, platformFee });
    }
  });

  // P1-7: paridade real com o `numeric` do Postgres. Estes dois valores caem
  // EXATAMENTE no empate de meio centavo em decimal, e são os casos que a
  // aritmética em ponto flutuante errava:
  //   23.50 * 0.85 → JS 19.974999999999998 (→ 19.97), numeric 19.97500 (→ 19.98)
  //   20.90 * 0.85 → JS 17.764999999999997 (→ 17.76), numeric 17.76500 (→ 17.77)
  // Os esperados abaixo são os do Postgres — escritos à mão, não gerados pelo
  // próprio código.
  it('empate de meio centavo arredonda para cima, igual ao round(numeric,2) do Postgres', () => {
    expect(composeRideSplit(23.5, 0, 0, 0.85)).toEqual({ driverAmount: 19.98, platformFee: 3.52 });
    expect(composeRideSplit(20.9, 0, 0, 0.85)).toEqual({ driverAmount: 17.77, platformFee: 3.13 });
    // A faixa de 0.800 não tem empates nesta escala — continua batendo.
    expect(composeRideSplit(23.5, 0, 0, 0.8)).toEqual({ driverAmount: 18.8, platformFee: 4.7 });
    expect(composeRideSplit(20.9, 0, 0, 0.8)).toEqual({ driverAmount: 16.72, platformFee: 4.18 });
  });

  it('cai em 80% quando a fatia do perfil é nula/corrompida', () => {
    // `null` é o que o supabase-js entrega quando driver_share_percent é NULL no
    // banco (motorista sem onboarding concluído) — e `null` não dispara o
    // parâmetro-default, então isto chega mesmo na guarda de calculateSplit.
    expect(composeRideSplit(100, 0, 0, null as unknown as number).driverAmount).toBe(80);
    expect(composeRideSplit(100, 0, 0, NaN).driverAmount).toBe(80);
    expect(composeRideSplit(100, 0, 0, 1.5).driverAmount).toBe(80);
    expect(composeRideSplit(100, 0, 0, undefined).driverAmount).toBe(80);
  });

  it('grampeia pedágio + taxa ao preço: o repasse nunca passa da cobrança', () => {
    // P0-3. `Math.max(fare, 0)` sozinho devolvia driverAmount 8 + platformFee 6
    // = 14 sobre um price de 10 — o pedágio inflado virava pass-through
    // integral. Agora o excesso é cortado da taxa de local primeiro (o pedágio
    // tem precedência) e a soma fecha no preço.
    //
    // Os esperados abaixo MUDARAM em relação à versão anterior deste teste: o
    // teto por componente de P0-1 corta ANTES da soma. Com price = 10 o teto é
    // 60% = $6, então o pedágio de $8 vira $6 e a taxa de $6 é cortada em $4
    // (o que sobra do preço) na segunda etapa.
    expect(composeRideSplit(10, 8, 6, 0.85)).toEqual({ driverAmount: 6, platformFee: 4 });
    // Caso extremo do exploit: cobrança de $1, pedágio declarado de $2000. Teto
    // ⇒ $0.60 de "pedágio"; os $0.40 de tarifa ainda pagam comissão (0.34/0.06).
    expect(composeRideSplit(1, 2000, 0, 0.85)).toEqual({ driverAmount: 0.94, platformFee: 0.06 });
    // Só a taxa de local estourando: cortada em 60% do preço, e os $4 de tarifa
    // restantes continuam sendo divididos normalmente (3.40/0.60).
    expect(composeRideSplit(10, 0, 2000, 0.85)).toEqual({ driverAmount: 3.4, platformFee: 6.6 });
    // Em TODOS os casos a identidade continua valendo: nada evapora, nada nasce.
    for (const [p, t, v] of [[10, 8, 6], [1, 2000, 0], [10, 0, 2000], [37.4, 12, 5]]) {
      const s = composeRideSplit(p, t, v, 0.85);
      expect(Math.round((s.driverAmount + s.platformFee) * 100)).toBe(Math.round(p * 100));
    }
  });

  it('teto por componente: pedágio nunca zera a comissão inteira (P0-1)', () => {
    // O grampo de soma sozinho deixava passar `toll = price`: a tarifa ia a
    // zero, a comissão ia a zero junto e o motorista levava 100% da cobrança
    // como "reembolso de pedágio". A plataforma não ficava negativa, então
    // nenhum invariante de soma acusava — mas a comissão INTEIRA sumia. Com o
    // teto de min(60% do preço, $120) sobra sempre tarifa comissionável.
    // price 100, teto 60 ⇒ tarifa 40 ⇒ 34 de repasse + 60 de pedágio.
    const s = composeRideSplit(100, 100, 0, 0.85);
    expect(s).toEqual({ driverAmount: 94, platformFee: 6 });
    expect(s.platformFee).toBeGreaterThan(0);

    // O teto ABSOLUTO ($120) morde antes dos 60% a partir de price = $200.
    // price 1000 ⇒ 60% seria 600, mas vale 120 ⇒ tarifa 880 ⇒ 748 + 120.
    expect(composeRideSplit(1000, 500, 0, 0.85)).toEqual({ driverAmount: 868, platformFee: 132 });

    // O teto usa FLOOR, não arredondamento — é assim que ele bate centavo a
    // centavo com o CHECK rides_fee_components_bounded_by_price e com
    // compute_ride_split. 60% de 13.09 = 7.854 ⇒ 7.85 (não 7.86).
    // tarifa 5.24 × 0.80 = 4.192 ⇒ 4.19; repasse 4.19 + 7.85 = 12.04.
    expect(composeRideSplit(13.09, 99, 0, 0.8)).toEqual({ driverAmount: 12.04, platformFee: 1.05 });

    // Pedágio ABAIXO do teto continua passando INTEIRO ao motorista: o teto é
    // limite de estrago, não confisco de reembolso legítimo.
    // tarifa 45.25 × 0.85 = 38.4625 ⇒ 38.46; repasse 38.46 + 4.75 = 43.21.
    expect(composeRideSplit(50, 4.75, 0, 0.85)).toEqual({ driverAmount: 43.21, platformFee: 6.79 });
  });

  it('trata pedágio/taxa ausentes ou negativos como zero', () => {
    expect(composeRideSplit(100)).toEqual({ driverAmount: 80, platformFee: 20 });
    expect(composeRideSplit(100, NaN, NaN, 0.85)).toEqual({ driverAmount: 85, platformFee: 15 });
    // Pedágio negativo viraria desconto na comissão; taxa negativa, dinheiro
    // extra para a plataforma. Os dois são cortados em zero (greatest(...,0) do
    // lado SQL).
    expect(composeRideSplit(100, -50, -50, 0.85)).toEqual({ driverAmount: 85, platformFee: 15 });
  });

  it('preço inválido/negativo não produz repasse', () => {
    expect(composeRideSplit(-100, 0, 0, 0.85)).toEqual({ driverAmount: 0, platformFee: 0 });
    expect(composeRideSplit(NaN, 0, 0, 0.85)).toEqual({ driverAmount: 0, platformFee: 0 });
  });
});
