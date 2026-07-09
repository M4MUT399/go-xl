import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { createAudioPlayer, AudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';

/**
 * useRideCallAlert — alerta sonoro RECORRENTE + vibração periódica enquanto uma
 * chamada de corrida estiver na tela (P1).
 *
 * Diferente do NotificationBanner (que toca o som uma vez), aqui o som fica em
 * loop e a vibração se repete a cada ciclo: a chamada "insiste" até o motorista
 * aceitar, recusar, ou o tempo expirar. Basta passar `active` refletindo se o
 * overlay de chamada está visível — o hook liga/desliga o som e limpa tudo ao
 * desmontar (nunca deixa som tocando órfão).
 *
 * O toque (assets/ride_call.wav) é um arco de sino que sobe e desce (crescente/
 * decrescente), rápido e marcante, com um silêncio curto no fim — em loop soa
 * clássico, urgente e intermitente. A vibração é sincronizada ao ciclo (~1.55s)
 * para pulsar junto com cada toque.
 */
/** Duração de um ciclo do ride_call.wav (ms) — mantém a vibração em sincronia. */
const CALL_LOOP_MS = 1550;
export function useRideCallAlert(active: boolean) {
  const playerRef = useRef<AudioPlayer | null>(null);
  const hapticTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // Cria o player uma única vez, já em modo loop.
  useEffect(() => {
    try {
      const player = createAudioPlayer(require('../../assets/ride_call.wav'));
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
      if (__DEV__) {
        console.log(
          `[${Platform.OS}][callAlert] stop() — player=${!!playerRef.current} ` +
          `playing=${playerRef.current?.playing}`
        );
      }
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
      if (__DEV__) console.log(`[${Platform.OS}][callAlert] active=false → PARANDO som/vibração`);
      stop();
      return stop;
    }
    if (__DEV__) console.log(`[${Platform.OS}][callAlert] active=true → tocando som em loop`);

    // Som em loop desde o início.
    const startPlayback = () => {
      try {
        playerRef.current?.seekTo(0);
        playerRef.current?.play();
      } catch {
        // ignora — a chamada ainda funciona sem som
      }
    };
    startPlayback();

    // Vibração imediata + uma por ciclo do toque (em sincronia com o swell).
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    hapticTimer.current = setInterval(() => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
      // Watchdog: o alerta DEVE se repetir até o motorista aceitar ou recusar.
      // Se o loop nativo parar por qualquer motivo, reinicia a reprodução —
      // enquanto `active` for true, o som nunca fica em silêncio.
      try {
        if (!playerRef.current?.playing) startPlayback();
      } catch {
        // ignora
      }
    }, CALL_LOOP_MS);

    return stop;
  }, [active]);
}
