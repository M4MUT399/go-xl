import { useEffect, useRef } from 'react';
import { createAudioPlayer, AudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';

/**
 * useScheduledReminderAlert — alerta ÚNICO (som + vibração) quando uma corrida
 * agendada confirmada fica iminente (P2).
 *
 * Diferente do useRideCallAlert (que toca em loop e "insiste" na chamada ao
 * vivo), aqui o alerta é disparado por borda: toca uma vez quando `imminent`
 * passa de false→true para um dado `key` (id da corrida). Assim o motorista é
 * avisado sem um som contínuo e sem re-tocar a cada re-render/tick do contador.
 * Troca de corrida (key diferente) rearma o alerta.
 */
export function useScheduledReminderAlert(imminent: boolean, key: string | null) {
  const playerRef = useRef<AudioPlayer | null>(null);
  const firedForRef = useRef<string | null>(null);

  useEffect(() => {
    try {
      playerRef.current = createAudioPlayer(require('../../assets/notification.wav'));
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
    if (!imminent || !key) return;
    if (firedForRef.current === key) return; // já alertou para esta corrida
    firedForRef.current = key;

    try {
      playerRef.current?.seekTo(0);
      playerRef.current?.play();
    } catch {
      // ignora — o banner ainda avisa visualmente
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
  }, [imminent, key]);
}
