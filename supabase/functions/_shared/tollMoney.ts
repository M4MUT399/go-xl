// Leitura PURA do pedágio devolvido pela Google Routes API — sem I/O, sem
// globais do Deno (mesmo padrão de _shared/refundReversal.ts). A Edge Function
// `toll-quote` faz a chamada HTTP; quem INTERPRETA a resposta mora aqui, porque
// é onde um erro silencioso custa dinheiro de verdade.
//
// ── AS DUAS ARMADILHAS DO `Money` DA GOOGLE ────────────────────────────────
//
// 1. `units` vem como STRING, não número. É int64 no protobuf e não caberia em
//    `number` no JSON. `Number(m.units)` funciona, mas `m.units + 1` daria
//    "41" em vez de 5 — e o valor vai INTEIRO para o motorista.
//
// 2. `nanos` são BILIONÉSIMOS, não centavos. Tratar 400000000 como centavos
//    faria um pedágio de US$ 4,40 virar US$ 4.000.000,00. O guard de dinheiro
//    da 0065 barraria (teto de 2000), mas a corrida falharia sem explicação.
//
// ── E A ARMADILHA DA LISTA ─────────────────────────────────────────────────
//
// `estimatedPrice` traz UM ITEM POR MOEDA. Viagem que cruza fronteira pode vir
// com dois. Somar tudo misturaria dólar com peso e produziria um número sem
// significado nenhum — por isso só o item em USD conta, e a ausência de USD
// devolve `null` ("não sei"), nunca 0 ("de graça").

/** O `Money` do Google, como chega no JSON. */
export interface GoogleMoney {
  currencyCode?: string;
  units?: string;
  nanos?: number;
}

/** Converte um `Money` em dólares, arredondado a centavos. */
export function moneyParaDolares(m: GoogleMoney): number {
  const units = Number.parseInt(String(m?.units ?? '0'), 10);
  const nanos = typeof m?.nanos === 'number' && Number.isFinite(m.nanos) ? m.nanos : 0;
  if (!Number.isFinite(units)) return 0;
  return Math.round((units + nanos / 1e9) * 100) / 100;
}

/**
 * Soma o pedágio da rota em USD.
 *
 * @returns o valor, ou `null` quando não há informação de pedágio em dólar.
 *   `null` e `0` são coisas diferentes: `0` é "esta rota não tem praça";
 *   `null` é "a Google não me disse", e o chamador decide o que fazer.
 */
export function pedagioEmUSD(estimatedPrice: GoogleMoney[] | undefined | null): number | null {
  if (!Array.isArray(estimatedPrice) || estimatedPrice.length === 0) return null;

  // Sem `currencyCode` assume-se USD: a conta é de Orlando e a Google omite o
  // campo em alguns retornos. Se um dia vier moeda estrangeira sem rótulo, o
  // erro aparece como valor absurdo, não como cobrança silenciosa em peso.
  const usd = estimatedPrice.filter((m) => (m?.currencyCode ?? 'USD') === 'USD');
  if (usd.length === 0) return null;

  const total = usd.reduce((s, m) => s + moneyParaDolares(m), 0);
  if (!Number.isFinite(total)) return null;
  return Math.round(Math.max(0, total) * 100) / 100;
}
