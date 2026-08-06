// dispatchClientBridge — núcleo PURO da fiação do app ao motor de dispatch v2.
//
// Quando a flag `dispatch_engine_v2` está LIGADA, o card do motorista deixa de
// ser dirigido pela tabela `rides` (leque legado) e passa a ser dirigido pela
// tabela `ride_offers` (servidor = fonte da verdade). Este módulo concentra as
// DECISÕES puras dessa ponte — sem React, sem Supabase — para poderem ser
// testadas isoladamente, no mesmo espírito de `dispatchEngine.ts`/`offerQueue.ts`:
//
//   • decideOfferAction — dado um registro de `ride_offers` chegando pelo
//     realtime (INSERT/UPDATE) e o contexto do motorista, decide se a oferta deve
//     ENTRAR na fila (enqueue), SAIR dela (dismiss) ou ser IGNORADA (ignore).
//   • livePendingOffers — dado o conjunto de ofertas lido do servidor na
//     reabertura do app (reconstrução — critério 5), devolve só as que ainda
//     estão VIVAS (PENDING e não expiradas), reconstituindo o card sem fantasma.
//
// A camada de I/O (hook useDriverRide) só aplica o que este módulo decide:
// resolve o `ride_id` do `trip_request`, busca a linha de `rides` e chama
// setPendingRide/dismissOffer conforme a ação.

export type OfferStatus = 'PENDING' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'REVOKED';

/** Espelho mínimo de uma linha de `ride_offers` (só o que a decisão precisa). */
export interface OfferRow {
  trip_request_id: string;
  driver_id: string;
  status: OfferStatus;
  /** ISO string; ausente = sem expiração conhecida (trata como viva). */
  expires_at?: string | null;
}

export interface OfferDecisionContext {
  /** Motorista dono deste device. */
  driverId: string;
  /** Relógio (ms) — injetável para teste determinístico. */
  nowMs: number;
  /**
   * Predicado de "lápide": ids de corrida que este device já encerrou
   * localmente (aceite/recusa/expiração) e não devem reabrir card. Reaproveita
   * o offerAlertManager.isTombstoned no chamador. Recebe o `rideId` (não o
   * trip_request_id) — por isso o chamador passa o rideId já resolvido.
   */
  tombstoned?: (rideId: string) => boolean;
  /** rideId já resolvido do trip_request (para checar a lápide). Opcional. */
  rideId?: string;
}

export type OfferAction = 'enqueue' | 'dismiss' | 'ignore';

function isExpired(row: OfferRow, nowMs: number): boolean {
  if (!row.expires_at) return false;
  const t = new Date(row.expires_at).getTime();
  return Number.isFinite(t) && t <= nowMs;
}

/**
 * Decide o que fazer com um registro de `ride_offers` recebido pelo realtime.
 *
 * Regras (uma única fonte de verdade da ponte):
 *   1. Oferta de OUTRO motorista → 'ignore' (RLS já filtra, mas defendemos).
 *   2. Status terminal de saída (REVOKED | EXPIRED | REJECTED) → 'dismiss'
 *      (som/card somem; a próxima da fila assume).
 *   3. ACCEPTED → 'ignore': o desfecho do aceite é conduzido pelo fluxo de
 *      acceptRide (vencedor navega; perdedor já recebeu REVOKED). Não mexe na
 *      fila aqui para não competir com aquele fluxo.
 *   4. PENDING porém já EXPIRADA (expires_at no passado) → 'dismiss'.
 *   5. PENDING viva, mas a corrida está LAPIDADA neste device → 'ignore'
 *      (motorista já recusou/expirou; não reabre).
 *   6. PENDING viva → 'enqueue'.
 */
export function decideOfferAction(row: OfferRow, ctx: OfferDecisionContext): OfferAction {
  if (row.driver_id !== ctx.driverId) return 'ignore';

  if (row.status === 'REVOKED' || row.status === 'EXPIRED' || row.status === 'REJECTED') {
    return 'dismiss';
  }
  if (row.status === 'ACCEPTED') return 'ignore';

  // A partir daqui, status === 'PENDING'.
  if (isExpired(row, ctx.nowMs)) return 'dismiss';

  if (ctx.rideId && ctx.tombstoned?.(ctx.rideId)) return 'ignore';

  return 'enqueue';
}

/**
 * Reconstrução (critério 5): das ofertas lidas do servidor ao reabrir o app,
 * mantém só as VIVAS para este motorista — PENDING e ainda não expiradas —
 * ordenadas por `offered_at`/chegada (o chamador passa já ordenado; aqui só
 * filtramos, preservando a ordem recebida). Assim o card volta exatamente ao
 * estado do servidor, sem oferta stale reaparecendo como fantasma.
 */
export function livePendingOffers(rows: OfferRow[], nowMs: number, driverId: string): OfferRow[] {
  return rows.filter(
    (r) => r.driver_id === driverId && r.status === 'PENDING' && !isExpired(r, nowMs)
  );
}
