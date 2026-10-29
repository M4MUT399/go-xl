// Divisão de receita por corrida (modelo "Separate Charges & Transfers").
//
// A plataforma cobra o passageiro e, semanalmente, repassa a fatia do motorista.
// A fatia do motorista NÃO é um valor global fixo: cada motorista tem sua
// própria `driver_share_percent`, gravada no onboarding em
// profiles.driver_share_percent. Desde a 0089 é 80% para todos (plataforma 20%);
// a faixa de 85% dos 100 primeiros (0037) acabou.
//
// Como no PEDIDO o motorista ainda é desconhecido (pool aberto), o split gravado
// na criação da corrida usa o padrão (DEFAULT_DRIVER_SHARE). Quem grava o valor
// que REALMENTE é repassado é o servidor — ver a nota de paridade em
// `composeRideSplit`.

/** Fatia padrão do motorista quando a específica ainda não é conhecida (pool aberto). */
export const DEFAULT_DRIVER_SHARE = 0.80;

/**
 * @deprecated Preferir a `driver_share_percent` por motorista. Mantido como
 * fallback de exibição (ex.: EarningsScreen estima ganhos de corridas antigas
 * sem driver_amount gravado).
 */
export const DRIVER_SHARE = DEFAULT_DRIVER_SHARE; // 80% para o motorista
export const PLATFORM_SHARE = 1 - DEFAULT_DRIVER_SHARE; // 20% para o app

export interface Split {
  driverAmount: number;
  platformFee: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Aritmética em centavos inteiros — e por quê.
// ─────────────────────────────────────────────────────────────────────────────
// O gêmeo em SQL (public.compute_ride_split, migração 0065) opera sobre
// `numeric`, que é DECIMAL EXATO. O `number` do JavaScript é IEEE-754 BINÁRIO,
// onde 0.85 e 23.50 não têm representação exata. Fazer `preço * fatia` em ponto
// flutuante e arredondar o resultado diverge do Postgres sempre que o produto
// exato cai num empate de meio centavo: o binário chega um ulp ABAIXO do empate
// e arredonda para baixo, enquanto o decimal vê o empate e arredonda para cima.
//
//   23.50 * 0.85  → JS 19.974999999999998 → 19.97 | numeric 19.97500 → 19.98
//   20.90 * 0.85  → JS 17.764999999999997 → 17.76 | numeric 17.76500 → 17.77
//
// Na faixa de 0.800 não há divergência (o produto nunca cai no empate para
// preços de 2 casas), mas na de 0.850 são ~1766 tarifas entre $0.01 e $2000 que
// diferem em um centavo. (A versão anterior deste arquivo culpava
// "half-away-from-zero vs half-up" — isso é falso: para valores não-negativos os
// dois critérios coincidem. A causa é binário vs decimal.)
//
// Conserto: nada de multiplicar floats. `price` vira centavos inteiros e `share`
// vira milésimos inteiros (a coluna é numeric(4,3), então 3 casas é o domínio
// exato), e o arredondamento é feito sobre a razão de dois inteiros, com
// desempate PARA LONGE DO ZERO — exatamente o `round(numeric, 2)` do Postgres.

/**
 * `numerator / denominator` arredondado ao inteiro mais próximo, empate para
 * longe do zero. Ambos os argumentos precisam ser inteiros exatos em double
 * (|n| < 2^53), o que sempre vale aqui: preço ≤ $2000 → ≤ 200000 centavos, e
 * 200000 * 1000 = 2e8.
 */
function roundHalfAwayFromZero(numerator: number, denominator: number): number {
  const sign = numerator < 0 ? -1 : 1;
  const n = Math.abs(numerator);
  return sign * Math.floor((2 * n + denominator) / (2 * denominator));
}

/** Dólares (float) → centavos inteiros, com o mesmo desempate. */
function toCents(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const scaled = value * 100;
  return scaled < 0 ? -Math.round(-scaled) : Math.round(scaled);
}

/** Centavos inteiros → dólares. */
function fromCents(cents: number): number {
  return cents / 100;
}

/** Fatia validada (0,1] → milésimos inteiros; qualquer coisa inválida vira 800. */
function shareToMilli(driverSharePercent: number): number {
  const valid =
    Number.isFinite(driverSharePercent) && driverSharePercent > 0 && driverSharePercent <= 1;
  return Math.round((valid ? driverSharePercent : DEFAULT_DRIVER_SHARE) * 1000);
}

/** Núcleo do split, tudo em centavos inteiros. */
function splitCents(priceCents: number, driverSharePercent: number): {
  driverCents: number;
  platformCents: number;
} {
  const driverCents = roundHalfAwayFromZero(priceCents * shareToMilli(driverSharePercent), 1000);
  // A plataforma fica com a diferença EXATA — nenhum centavo evapora nem nasce.
  return { driverCents, platformCents: priceCents - driverCents };
}

/**
 * Calcula a divisão de uma tarifa.
 * @param totalPrice         valor sobre o qual incide o split (tarifa, sem pedágio/taxas).
 * @param driverSharePercent fatia do motorista (0..1). Default = DEFAULT_DRIVER_SHARE.
 *                           NULL/NaN/≤0/>1 (valor corrompido vindo do banco) cai
 *                           em DEFAULT_DRIVER_SHARE.
 */
export function calculateSplit(
  totalPrice: number,
  driverSharePercent: number = DEFAULT_DRIVER_SHARE,
): Split {
  const { driverCents, platformCents } = splitCents(toCents(totalPrice), driverSharePercent);
  return { driverAmount: fromCents(driverCents), platformFee: fromCents(platformCents) };
}

/**
 * Split de uma CORRIDA inteira, com pedágio e taxa de aeroporto/porto.
 *
 * As duas regras que `calculateSplit` sozinha não expressa:
 *   • o pedágio é PASS-THROUGH: não sofre comissão e vai inteiro ao motorista;
 *   • a taxa de aeroporto/porto é regulatória: fica inteira com a plataforma.
 * Por isso a comissão incide só sobre a TARIFA (`price - toll - venueFee`).
 *
 * O GRAMPO (clamp), NÍVEL 1 — soma. Pedágio e taxa nunca podem somar mais que
 * `price`. Cortar a tarifa em zero (o antigo `Math.max(fare, 0)`) conserta o
 * SINAL mas transforma um pedágio inflado em pass-through integral: com
 * price = 10 e toll = 8 + venue = 6, a "tarifa" ia a zero e o motorista recebia
 * os 8 de pedágio de uma cobrança de 10 — driverAmount + platformFee = 14 sobre
 * um preço de 10. Levado ao extremo (price = 1.00, toll = 2000.00) isso é furto
 * direto do saldo da plataforma. O excesso é cortado: o pedágio tem precedência
 * sobre a taxa de local, e driverAmount + platformFee = price SEMPRE.
 *
 * O GRAMPO, NÍVEL 2 — teto por componente. O nível 1 sozinho ainda deixa passar
 * `toll = price`: a tarifa vai a zero, a comissão vai a zero junto e o motorista
 * leva 100% da cobrança como "reembolso de pedágio". A plataforma não fica no
 * negativo, mas perde a comissão INTEIRA. Por isso cada componente é limitado a
 * `min(60% do preço, $120)` — os mesmos números do CHECK
 * `rides_fee_components_bounded_by_price` e de `compute_ride_split` (migração
 * 0065). A justificativa de cada constante está lá; em resumo: como
 * `price = fare + toll + venueFee`, um componente só chega a 50% do preço quando
 * já iguala a tarifa inteira, então 60% é folga; e $120 é um LIMITE DE ESTRAGO
 * escolhido por não existir nenhuma tabela de praças no repositório (o único
 * provider implementado devolve $0 e `airport_port_fees` nasce vazio), não um
 * valor medido.
 *
 * O QUE O TETO DEVOLVE, EM NÚMEROS (e o que ele NÃO devolve). Com `venueFee = 0`
 * e pedágio `t`, o repasse é `share·(price − t) + t = share·price + t·(1 − share)`
 * — crescente em `t`, então quem extrai escolhe o maior `t` permitido,
 * `min(0.60·price, 120)`. Para `price <= $200` vale o teto dos 60% e o resultado
 * fecha em
 *
 *   driverAmount = price · (0.40·share + 0.60)
 *   platformFee  = price · 0.40 · (1 − share)
 *
 * isto é, PISO DE COMISSÃO de `40%·(1 − share)` do preço:
 *
 *   faixa 0.850 → comissão  6% do preço → extração máxima 94,0%
 *   faixa 0.800 → comissão  8% do preço → extração máxima 92,0%
 *
 * Acima de $200 o teto absoluto de $120 morde e a fração volta a cair na direção
 * de `share` (em `price = 1000`, faixa 0.850: 868/1000 = 86,8%). Logo o pior caso
 * é 94%, em preços até $200 — o teto NÃO devolve a extração à faixa normal de
 * 80-85%, e ler assim é ler errado. O teste
 * `src/lib/__tests__/split.test.ts:177-179` fixa exatamente esse número:
 * `composeRideSplit(100, 100, 0, 0.85)` → `{ driverAmount: 94, platformFee: 6 }`,
 * ou seja $6 BRUTOS de comissão numa cobrança de $100 — quase tudo consumido
 * pela taxa do Stripe sobre a mesma cobrança. O teto garante que a comissão não
 * seja ZERO. É só isso que ele garante.
 *
 * ⚠️ ISTO NÃO É A CURA. O conserto de verdade é o servidor DERIVAR pedágio e
 * taxa de `system_config` (0028/0030) em vez de aceitar o número que o cliente
 * mandou. Até lá, um pedágio inflado dentro do teto continua passando.
 *
 * ⚠️ ESTA FÓRMULA TEM UM GÊMEO EM SQL. A fonte da verdade para o valor que
 * REALMENTE é repassado é `public.compute_ride_split(...)`, chamada pelo trigger
 * `guard_ride_money_fields` e por `public.apply_driver_split(uuid)` (migração
 * 0065) — desde então o cliente não pode mais escrever driver_amount/platform_fee.
 * Esta versão em TS sobrevive por dois motivos: (1) é ela que compõe o split
 * PADRÃO no payload de INSERT da corrida, o que mantém o app funcionando contra
 * uma base onde a 0065 ainda não foi aplicada; (2) serve de referência testável
 * da economia que o SQL precisa reproduzir. Com a aritmética em centavos acima,
 * "centavo a centavo" deixou de ser uma promessa e passou a ser verdade.
 * Se mexer aqui, mexa lá — e vice-versa.
 */
export function composeRideSplit(
  price: number,
  tollAmount: number = 0,
  venueFee: number = 0,
  driverSharePercent: number = DEFAULT_DRIVER_SHARE,
): Split {
  const priceCents = Math.max(toCents(price), 0);

  // Teto por componente, IDÊNTICO ao do SQL. A forma `floor(price * 60) / 100`
  // (e não `price * 0.60`) é o que mantém a paridade em centavos entre as três
  // cópias da regra — CHECK, compute_ride_split e esta função: com 60% de um
  // preço terminado em centavo ímpar, arredondar e truncar dão respostas
  // diferentes, e o CHECK rejeitaria uma linha que esta função considerou
  // válida. Em centavos, `floor(P * 60) / 100` dólares vira
  // `floor(priceCents * 60 / 100)` centavos.
  const ceilingCents = Math.min(Math.floor((priceCents * 60) / 100), 12000);

  // Grampo, na mesma ordem do SQL: primeiro o teto por componente, depois a
  // soma. Na soma o pedágio (que vai ao motorista) tem precedência, então o
  // excesso é cortado da taxa de local primeiro.
  const tollCapped = Math.min(Math.max(toCents(tollAmount), 0), ceilingCents);
  const venueCapped = Math.min(Math.max(toCents(venueFee), 0), ceilingCents);

  const tollCents = Math.min(tollCapped, priceCents);
  const venueCents = Math.min(venueCapped, priceCents - tollCents);

  const fareCents = priceCents - tollCents - venueCents;
  const { driverCents, platformCents } = splitCents(fareCents, driverSharePercent);

  return {
    driverAmount: fromCents(driverCents + tollCents),
    platformFee: fromCents(platformCents + venueCents),
  };
}
