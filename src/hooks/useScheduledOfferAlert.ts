import { useEffect, useRef } from 'react';
import { createAudioPlayer, AudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';

/**
 * useScheduledOfferAlert — sinal sonoro ÚNICO e DISTINTO quando um NOVO
 * agendamento chega para o motorista (banner de "Corrida agendada!").
 *
 * Distinto dos demais alertas:
 *   - useRideCallAlert   → ride_call.wav, toca EM LOOP (chamada ao vivo).
 *   - useScheduledReminderAlert → notification.wav, 1× quando a corrida
 *     confirmada fica iminente.
 *   - AQUI → scheduled_offer.wav (arpejo ascendente de sino), 1× quando o
 *     agendamento aparece. Disparo por borda: toca uma vez por `offerId`
 *     (id da corrida). Novo id rearma; some/muda de tela não re-toca.
 */
export function useScheduledOfferAlert(offerId: string | null) {
  const playerRef = useRef<AudioPlayer | null>(null);
  const firedForRef = useRef<string | null>(null);

  useEffect(() => {
    try {
      playerRef.current = createAudioPlayer(require('../../assets/scheduled_offer.wav'));
    } catch {
      playerRef.current = null;
    }
    return () => {
      try {
        playerRef.current?.remove();
      } catch {
        // ignora
      }
      playerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!offerId) {
      // Sem oferta na tela → rearma para a próxima (id diferente OU o mesmo id
      // que voltar a aparecer depois de sumir).
      firedForRef.current = null;
      return;
    }
    if (firedForRef.current === offerId) return; // já sinalizou esta oferta
    firedForRef.current = offerId;

    try {
      playerRef.current?.seekTo(0);
      playerRef.current?.play();
    } catch {
      // ignora — o banner ainda avisa visualmente
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  }, [offerId]);
}
