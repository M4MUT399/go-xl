import { useState, useEffect, useCallback, useRef } from 'react';
import * as ExpoLocation from 'expo-location';
import type { Coordinates } from '../types';
import { startTiming } from '../lib/fieldMetrics';

export type LocationStatus = 'loading' | 'ready' | 'denied' | 'error';

// expo-location retorna -1 (ou null) quando o sentido do movimento é desconhecido.
function validHeading(heading: number | null | undefined): number | undefined {
  return heading != null && heading >= 0 ? heading : undefined;
}

// Idem para velocidade: valores negativos indicam leitura inválida/desconhecida.
function validSpeed(speed: number | null | undefined): number | undefined {
  return speed != null && speed >= 0 ? speed : undefined;
}

interface UseLocationOptions {
  /** Quando true, inicia watchPositionAsync e atualiza a posição continuamente. */
  watch?: boolean;
}

export function useLocation(options?: UseLocationOptions) {
  const watchEnabled = options?.watch ?? false;

  const [location, setLocation] = useState<Coordinates | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [status, setStatus] = useState<LocationStatus>('loading');
  const watchRef = useRef<ExpoLocation.LocationSubscription | null>(null);
  /**
   * Fecha o intervalo até o próximo fix de GPS.
   *
   * Mede a CADÊNCIA de entrega do SO ao app — não é a latência de rastreamento
   * ponta a ponta que a régua de 2 s cobra. Falta desta amostra tudo depois do
   * fix: publicação, realtime do Supabase e render no aparelho do passageiro.
   * E o piso é configuração, não física: com `timeInterval: 5000` abaixo, um
   * carro parado entrega um fix a cada 5 s por definição.
   */
  const desdeUltimoFix = useRef<ReturnType<typeof startTiming> | null>(null);

  const load = useCallback(async () => {
    setStatus('loading');
    setErrorMsg(null);
    try {
      const { status: perm } = await ExpoLocation.requestForegroundPermissionsAsync();
      if (perm !== 'granted') {
        setErrorMsg('Permissão de localização negada');
        setStatus('denied');
        return;
      }

      // 1) Posição em cache SÓ se for BEM recente (<15s) e precisa (<50m). Antes,
      // o cache só servia de "preview" e o mapa continuava em `loading` até o
      // fix preciso (passo 2) responder — em áreas fechadas/urbanas isso podia
      // levar vários segundos. Agora, assim que o cache chega, já liberamos
      // `ready` (mapa aparece na hora); o fix preciso do passo 2 só refina a
      // posição em segundo plano, sem bloquear a UI.
      //
      // Cuidado: a tolerância aqui era 60s/100m e isso deixava o marcador
      // dourado (posição customizada da GoXL) aparecer temporariamente num
      // lugar ERRADO do mapa — bem diferente do pontinho azul nativo do
      // iOS/Android (que usa o GPS ao vivo, sem depender deste cache). Uma
      // janela apertada (15s/50m) reduz drasticamente a chance de mostrar
      // uma posição desatualizada, mantendo o ganho de velocidade.
      try {
        const last = await ExpoLocation.getLastKnownPositionAsync({
          maxAge: 15000,
          requiredAccuracy: 50,
        });
        if (last) {
          setLocation({ lat: last.coords.latitude, lng: last.coords.longitude, heading: validHeading(last.coords.heading), speed: validSpeed(last.coords.speed) });
          setStatus('ready');
        }
      } catch {
        // ignora — segue para a posição precisa
      }

      // 2) Fix inicial: usa `Balanced` (bem mais rápido que `High` em ambientes
      // urbanos/fechados) apenas para o ponto de partida. Precisão fina vem
      // depois via watchPositionAsync (quando `watch: true`).
      const loc = await ExpoLocation.getCurrentPositionAsync({
        accuracy: ExpoLocation.Accuracy.Balanced,
      });
      setLocation({ lat: loc.coords.latitude, lng: loc.coords.longitude, heading: validHeading(loc.coords.heading), speed: validSpeed(loc.coords.speed) });
      setStatus('ready');
    } catch {
      // Se já tínhamos exibido o cache, mantém "ready" — o usuário já está
      // vendo o mapa; só cai em erro quando não há absolutamente nada.
      setErrorMsg('Não foi possível obter sua localização');
      setStatus((prev) => (prev === 'loading' ? 'error' : prev));
    }
  }, []);

  // Carrega posição inicial ao montar
  useEffect(() => {
    let mounted = true;
    (async () => {
      if (mounted) await load();
    })();
    return () => {
      mounted = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Inicia/para watchPositionAsync conforme watchEnabled
  useEffect(() => {
    if (!watchEnabled) return;

    let active = true;
    ExpoLocation.requestForegroundPermissionsAsync().then(({ status: perm }) => {
      if (perm !== 'granted' || !active) return;

      ExpoLocation.watchPositionAsync(
        {
          accuracy: ExpoLocation.Accuracy.High,
          distanceInterval: 15,   // atualiza ao mover ≥15 m
          timeInterval: 5000,     // ou a cada 5 s (o que vier primeiro)
        },
        (pos) => {
          // Intervalo entre dois fixes CONSECUTIVOS. O primeiro só abre o
          // cronômetro: não existe anterior de onde medir.
          desdeUltimoFix.current?.({ accuracy: pos.coords.accuracy ?? undefined });
          desdeUltimoFix.current = startTiming('location_fix_interval');
          setLocation({ lat: pos.coords.latitude, lng: pos.coords.longitude, heading: validHeading(pos.coords.heading), speed: validSpeed(pos.coords.speed) });
          setStatus('ready');
        }
      ).then((sub) => {
        if (active) {
          watchRef.current = sub;
        } else {
          sub.remove();
        }
      });
    });

    return () => {
      active = false;
      watchRef.current?.remove();
      watchRef.current = null;
      // Sem isso, a primeira leitura depois de religar o watch sairia como um
      // intervalo gigante que inclui o tempo com o rastreamento DESLIGADO.
      desdeUltimoFix.current = null;
    };
  }, [watchEnabled]);

  async function refreshLocation(): Promise<Coordinates | null> {
    try {
      const loc = await ExpoLocation.getCurrentPositionAsync({
        accuracy: ExpoLocation.Accuracy.High,
      });
      const coords = { lat: loc.coords.latitude, lng: loc.coords.longitude, heading: validHeading(loc.coords.heading), speed: validSpeed(loc.coords.speed) };
      setLocation(coords);
      return coords;
    } catch {
      return null;
    }
  }

  const loading = status === 'loading';

  return { location, errorMsg, status, loading, refreshLocation, retry: load };
}
