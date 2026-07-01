// rideOfferEvents — registro do ciclo de vida de cada chamada de corrida
// (tabela public.ride_offer_events, migration 0023).
//
// Best-effort por design: registrar um evento NUNCA pode lançar exceção nem
// bloquear o fluxo do motorista (aceite/recusa/expiração). Se a tabela ainda
// não existir (migration pendente em prod) ou a query falhar, apenas logamos
// um aviso no console e seguimos — a corrida continua funcionando normalmente.
import { supabase } from './supabase';

export type RideOfferEvent =
  | 'received'        // overlay de chamada apareceu para o motorista
  | 'accepted'        // motorista tocou ACEITAR e o aceite foi confirmado
  | 'rejected'        // motorista tocou RECUSAR
  | 'expired'         // tempo esgotou sem ação
  | 'failed'          // erro (ex.: pagamento recusado)
  | 'taken_by_other'; // outro motorista aceitou antes

export async function logRideOfferEvent(
  rideId: string | undefined,
  driverId: string | undefined,
  event: RideOfferEvent,
  opts?: { reason?: string; metadata?: Record<string, unknown> }
): Promise<void> {
  if (!rideId || !driverId) return;
  try {
    const { error } = await supabase.from('ride_offer_events').insert({
      ride_id: rideId,
      driver_id: driverId,
      event,
      reason: opts?.reason ?? null,
      metadata: opts?.metadata ?? null,
    });
    if (error) {
      console.warn('[rideOfferEvents] falha ao registrar', event, error.message);
    }
  } catch (e) {
    console.warn('[rideOfferEvents] exceção ao registrar', event, e);
  }
}
