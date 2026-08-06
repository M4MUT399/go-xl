// Testes do núcleo puro da ponte cliente ↔ motor v2 (PR-c).
//
// Cobrem a matriz de decisão do card do motorista dirigido por `ride_offers` e a
// reconstrução do estado ao reabrir o app (critério 5 do comando Uber).
import {
  decideOfferAction,
  livePendingOffers,
  type OfferRow,
} from '../dispatchClientBridge';

const DRIVER = 'drv-1';
const NOW = 1_000_000;

function offer(partial: Partial<OfferRow>): OfferRow {
  return {
    trip_request_id: 'tr-1',
    driver_id: DRIVER,
    status: 'PENDING',
    expires_at: new Date(NOW + 15_000).toISOString(),
    ...partial,
  };
}

describe('decideOfferAction', () => {
  it('PENDING viva para este motorista → enqueue', () => {
    expect(decideOfferAction(offer({}), { driverId: DRIVER, nowMs: NOW })).toBe('enqueue');
  });

  it('oferta de OUTRO motorista → ignore', () => {
    expect(
      decideOfferAction(offer({ driver_id: 'outro' }), { driverId: DRIVER, nowMs: NOW })
    ).toBe('ignore');
  });

  it('REVOKED → dismiss (perdedor do aceite)', () => {
    expect(decideOfferAction(offer({ status: 'REVOKED' }), { driverId: DRIVER, nowMs: NOW })).toBe('dismiss');
  });

  it('EXPIRED → dismiss', () => {
    expect(decideOfferAction(offer({ status: 'EXPIRED' }), { driverId: DRIVER, nowMs: NOW })).toBe('dismiss');
  });

  it('REJECTED → dismiss', () => {
    expect(decideOfferAction(offer({ status: 'REJECTED' }), { driverId: DRIVER, nowMs: NOW })).toBe('dismiss');
  });

  it('ACCEPTED → ignore (desfecho conduzido pelo acceptRide)', () => {
    expect(decideOfferAction(offer({ status: 'ACCEPTED' }), { driverId: DRIVER, nowMs: NOW })).toBe('ignore');
  });

  it('PENDING mas já expirada pelo relógio → dismiss', () => {
    const stale = offer({ expires_at: new Date(NOW - 1).toISOString() });
    expect(decideOfferAction(stale, { driverId: DRIVER, nowMs: NOW })).toBe('dismiss');
  });

  it('PENDING sem expires_at → tratada como viva (enqueue)', () => {
    expect(decideOfferAction(offer({ expires_at: null }), { driverId: DRIVER, nowMs: NOW })).toBe('enqueue');
  });

  it('PENDING viva mas corrida LAPIDADA neste device → ignore (não reabre)', () => {
    const ctx = {
      driverId: DRIVER,
      nowMs: NOW,
      rideId: 'ride-9',
      tombstoned: (id: string) => id === 'ride-9',
    };
    expect(decideOfferAction(offer({}), ctx)).toBe('ignore');
  });

  it('lápide não afeta um rideId diferente', () => {
    const ctx = {
      driverId: DRIVER,
      nowMs: NOW,
      rideId: 'ride-outra',
      tombstoned: (id: string) => id === 'ride-9',
    };
    expect(decideOfferAction(offer({}), ctx)).toBe('enqueue');
  });
});

describe('livePendingOffers (reconstrução — critério 5)', () => {
  it('mantém só PENDING vivas deste motorista, preservando a ordem', () => {
    const rows: OfferRow[] = [
      offer({ trip_request_id: 'a' }),
      offer({ trip_request_id: 'b', status: 'REVOKED' }),
      offer({ trip_request_id: 'c', expires_at: new Date(NOW - 5).toISOString() }),
      offer({ trip_request_id: 'd', driver_id: 'outro' }),
      offer({ trip_request_id: 'e' }),
    ];
    const live = livePendingOffers(rows, NOW, DRIVER);
    expect(live).toHaveLength(2);
    expect(live[0].trip_request_id).toBe('a');
    expect(live[1].trip_request_id).toBe('e');
  });

  it('oferta stale (revogada após outro vencer) NÃO reaparece', () => {
    const rows: OfferRow[] = [offer({ trip_request_id: 'won-by-other', status: 'REVOKED' })];
    expect(livePendingOffers(rows, NOW, DRIVER)).toHaveLength(0);
  });

  it('lista vazia → vazio', () => {
    expect(livePendingOffers([], NOW, DRIVER)).toHaveLength(0);
  });
});
