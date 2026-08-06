// offerQueue — fila PURA de ofertas de corrida no lado do motorista (PR-a do
// dispatch concorrente). Isolada de React/Supabase de propósito: toda a decisão
// "qual oferta o motorista vê agora, e o que acontece quando uma some" vive aqui,
// testável sem montar componente.
//
// CONTEXTO DO BUG (causa raiz): o app do motorista guardava UMA única oferta
// pendente (`pendingRide`). Quando um segundo passageiro (P2) solicitava antes de
// alguém aceitar P1, o INSERT de P2 SOBRESCREVIA P1 no slot único e, pior, o
// alerta sonoro (offerAlertManager) LAPIDAVA P1 por 10 min (tombstone) ao trocar
// de oferta — de modo que P1 nunca mais reaparecia. As duas corridas morriam.
//
// MODELO CORRETO: cada oferta é uma entidade independente. O motorista pode ter
// VÁRIAS ofertas válidas ao mesmo tempo; ele atende UMA por vez (a cabeça da
// fila), em ordem de chegada (FIFO). Quando a oferta da cabeça é resolvida
// (aceita, recusada, expira, tomada por outro, revogada), ela sai da fila e a
// PRÓXIMA vira a cabeça — sem nunca cancelar/lapidar as outras que continuam
// válidas. Criar/receber uma nova oferta JAMAIS altera as demais.
//
// Compatibilidade (rollout gradual): o parâmetro `multiOffer` reproduz o
// comportamento antigo quando falso — a fila nunca passa de 1 item (a nova
// oferta substitui a anterior). Com a flag `dispatch_multi_offer_fix` ligada,
// `multiOffer=true` habilita a fila FIFO de verdade.

/** Identidade mínima de uma oferta na fila. */
export interface QueuedOffer {
  id: string;
}

/**
 * Uma nova oferta chegou (INSERT/poll). FIFO com dedupe por id.
 *
 *  • `multiOffer=false` (legado): a fila é um slot único — a nova oferta
 *    SUBSTITUI o que houver (comportamento antigo de `setPendingRide(ride)`).
 *  • `multiOffer=true`: se o id já está na fila, é no-op (não reordena nem
 *    reinicia o alarme); senão a oferta é anexada ao FIM (não rouba a vez de
 *    quem já estava tocando).
 *
 * Retorna SEMPRE a mesma referência de array quando nada muda (deixa o React
 * pular re-render).
 */
export function arriveOffer<T extends QueuedOffer>(
  queue: T[],
  offer: T,
  multiOffer: boolean
): T[] {
  if (!offer || !offer.id) return queue;

  if (!multiOffer) {
    // Slot único (legado): idempotente para o MESMO id da cabeça; senão troca.
    if (queue.length === 1 && queue[0].id === offer.id) return queue;
    return [offer];
  }

  if (queue.some((o) => o.id === offer.id)) return queue; // já enfileirada
  return [...queue, offer];
}

/**
 * Uma oferta foi resolvida/revogada (aceita, recusada, expirou, tomada por
 * outro, cancelada). Remove aquele id de QUALQUER posição da fila — se era a
 * cabeça, a próxima assume automaticamente (é só o novo `queue[0]`).
 *
 * Idempotente: remover um id que não está na fila devolve a MESMA referência.
 */
export function resolveOffer<T extends QueuedOffer>(queue: T[], id: string): T[] {
  if (!id) return queue;
  if (!queue.some((o) => o.id === id)) return queue;
  return queue.filter((o) => o.id !== id);
}

/** A oferta que o motorista vê agora (cabeça da FIFO), ou null se a fila vazia. */
export function headOffer<T extends QueuedOffer>(queue: T[]): T | null {
  return queue.length > 0 ? queue[0] : null;
}

/** true se algum item da fila tem esse id (cabeça ou cauda). */
export function queueHasOffer<T extends QueuedOffer>(queue: T[], id: string): boolean {
  return !!id && queue.some((o) => o.id === id);
}
