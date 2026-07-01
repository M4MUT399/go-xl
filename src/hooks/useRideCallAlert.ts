import { useEffect, useRef } from 'react';
import { createAudioPlayer, AudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';

/**
 * useRideCallAlert — alerta sonoro RECORRENTE + vibração periódica enquanto uma
 * chamada de corrida estiver na tela (P1).
 *
 * Diferente do NotificationBanner (que toca o som uma vez), aqui o som fica em
 * loop e a vibração se repete a cada 2s: a chamada "insiste" até o motorista
 * aceitar, recusar, ou o tempo expirar. Basta passar `active` refletindo se o
 * overlay de chamada está visível — o hook liga/desliga o som e limpa tudo ao
 * desmontar (nunca deixa som tocando órfão).
 */
export function useRideCallAlert(active: boolean) {
  const playerRef = useRef<AudioPlayer | null>(null);
  const hapticTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cria o player uma única vez, já em modo loop.
  useEffect(() => {
    try {
      const player = createAudioPlayer(require('../../assets/notification.wav'));
      player.loop = true;
      playerRef.current = player;
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
    const stop = () => {
      try {
        playerRef.current?.pause();
      } catch {
        // ignora
      }
      if (hapticTimer.current) {
        clearInterval(hapticTimer.current);
        hapticTimer.current = null;
      }
    };

    if (!active) {
      stop();
      return stop;
    }

    // Som em loop desde o início.
    try {
      playerRef.current?.seekTo(0);
      playerRef.current?.play();
    } catch {
      // ignora — a chamada ainda funciona sem som
    }

    // Vibração imediata + a cada 2s.
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    hapticTimer.current = setInterval(() => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    }, 2000);

    return stop;
  }, [active]);
}
