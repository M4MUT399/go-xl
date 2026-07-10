import { dollarsToCents, centsToDollars, sumDollarsToCents } from '../money';

describe('money — dólares ↔ centavos inteiros', () => {
  test('dollarsToCents arredonda meio-acima e trata inválidos como 0', () => {
    expect(dollarsToCents(12.34)).toBe(1234);
    expect(dollarsToCents(0)).toBe(0);
    expect(dollarsToCents(0.005)).toBe(1); // 0.5 centavo → 1
    expect(dollarsToCents(null)).toBe(0);
    expect(dollarsToCents(undefined)).toBe(0);
    expect(dollarsToCents(NaN)).toBe(0);
  });

  test('centsToDollars devolve dólares com 2 casas', () => {
    expect(centsToDollars(1234)).toBe(12.34);
    expect(centsToDollars(0)).toBe(0);
    expect(centsToDollars(5)).toBe(0.05);
  });

  test('soma em centavos é exata onde o float erraria', () => {
    // 0.1 + 0.2 = 0.30000000000000004 em float; em centavos dá 30 cravado.
    expect(sumDollarsToCents([0.1, 0.2])).toBe(30);
  });

  test('sumDollarsToCents ignora nulos/NaN e soma o resto', () => {
    expect(sumDollarsToCents([10.5, null, 4.25, undefined, NaN])).toBe(1475);
    expect(sumDollarsToCents([])).toBe(0);
  });

  test('ida e volta preserva o valor', () => {
    expect(centsToDollars(sumDollarsToCents([13.9, 7.1, 0.01]))).toBe(21.01);
  });
});
