import { useEffect } from 'react';
import { offerAlertManager } from '../lib/offerAlertManager';

/**
 * useRideCallAlert — ligação React FINA para o alerta de chamada de corrida.
 *
 * NÃO cria mais nenhum player/timer próprio. Todo o som/vibração/watchdog/
 * tombstone vive no SINGLETON `offerAlertManager` (dono único, fora do ciclo de
 * vida do React) — ver src/lib/offerAlertManager.ts. Aqui só traduzimos o estado
 * do card em transições da máquina de estados:
 *
 *   • card visível para a corrida `rideId` e `active` → startAlert(rideId)
 *     (IDLE→RINGING; idempotente — re-render não reinicia o som).
 *   • card desmontado / `active` falso (ex.: aceite em andamento) → stopAll
 *     (RINGING→TERMINAL), que para o som e LAPIDA o rideId por 10 min.
 *
 * Como o player é único e reutilizado, qualquer caminho de parada (este, o botão
 * RECUSAR, a revogação, o watchdog) sempre alcança o MESMO player — acabou a
 * classe de bug do player órfão tocando para sempre.
 */
export function useRideCallAlert(active: boolean, rideId: string | null | undefined) {
  useEffect(() => {
    if (active && rideId) {
      offerAlertManager.startAlert(rideId);
      // Ao desmontar o card (recusa/revogação/expiração zeram o pendingRide) ou
      // ao trocar de oferta, encerra ESTA corrida — para o som e lapida o id.
      return () => {
        offerAlertManager.stopAll(rideId, 'card_unmounted');
      };
    }
    // active=false (aceite em andamento) → garante silêncio imediato.
    if (rideId) offerAlertManager.stopAll(rideId, 'inactive');
    return undefined;
  }, [active, rideId]);
}
