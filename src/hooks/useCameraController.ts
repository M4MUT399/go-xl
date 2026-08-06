import { useMemo, useRef } from 'react';
import type MapView from 'react-native-maps';
import { CameraController } from '../lib/nav/CameraController';
import { useFeatureFlag } from './useFeatureFlag';

/**
 * useCameraController — instancia UM CameraController por tela, estável entre
 * renders, ligado ao `mapRef` da tela e à flag `camera_controller_enabled`.
 *
 * A flag é lida de forma reativa (useFeatureFlag) mas passada ao controller como
 * um getter (`enabled()`), de modo que ligar/desligar no backend passa a valer
 * sem recriar o controller nem perder a "última posição válida".
 *
 * @param mapRef  ref do MapView da tela.
 * @param source  nome do call-site (telemetria), ex.: 'DriverNavigate'.
 */
export function useCameraController(mapRef: React.RefObject<MapView | null>, source: string) {
  const enabled = useFeatureFlag('camera_controller_enabled');
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  return useMemo(
    () =>
      new CameraController({
        getMap: () => mapRef.current,
        enabled: () => enabledRef.current,
        source,
      }),
    // Estável: mapRef é uma ref (identidade fixa), source é constante por tela.
    [mapRef, source],
  );
}
