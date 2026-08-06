// Dinheiro em CENTAVOS INTEIROS — fonte única da aritmética de repasse.
//
// Por que existe:
//   O fluxo antigo somava `driver_amount` (numeric(8,2), lido como float JS) e
//   comparava/relatava em dólares float. Float acumula erro (0.1 + 0.2 ≠ 0.3) e
//   abre brecha para "saldo fantasma" que trava o repasse. Aqui centralizamos a
//   conversão para centavos inteiros: toda decisão de valor (mínimo, elegível,
//   transferido) acontece em `number` inteiro de centavos; só formatamos de volta
//   para dólares na fronteira com o banco (coluna em dólares) e com a UI.
//
// Módulo PURO: sem I/O, sem globais do Deno — roda igual na Edge Function (Deno)
// e no Jest do app (babel), então a aritmética de dinheiro fica coberta por teste.

/** Dólares (float vindo do banco) → centavos inteiros. Arredonda meio-acima. */
export function dollarsToCents(dollars: number | null | undefined): number {
  if (dollars == null || !Number.isFinite(dollars)) return 0;
  return Math.round(dollars * 100);
}

/** Centavos inteiros → dólares (para gravar na coluna numeric(8,2) e exibir). */
export function centsToDollars(cents: number): number {
  return Math.round(cents) / 100;
}

/**
 * Soma uma lista de valores em DÓLARES devolvendo CENTAVOS inteiros. Cada parcela
 * é convertida para centavos ANTES de somar (nunca soma floats), então o total é
 * exato. Valores nulos/NaN são ignorados (não punem quem não reportou valor).
 */
export function sumDollarsToCents(values: Array<number | null | undefined>): number {
  let total = 0;
  for (const v of values) total += dollarsToCents(v);
  return total;
}
