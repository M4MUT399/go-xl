import { useState, useEffect, useRef, useCallback } from 'react';
import * as ExpoLocation from 'expo-location';
import { GeoKalman, isAcceptableFix } from '../lib/nav/filter';
import { circularMean } from '../lib/nav/geo';
import { headingForMotion } from '../lib/nav/follow';
import type { SimFix } from '../lib/nav/simulator';

/**
 * useNavigationLocation — fonte de localização de MÁXIMA PRECISÃO e já
 * SUAVIZADA para a tela de navegação do motorista (estilo Waze). Diferente do
 * useLocation genérico (usado no resto do app), aqui:
 *
 *   1) o watch usa `BestForNavigation` + `AutomotiveNavigation` +
 *      `distanceInterval: 0` (kCLDistanceFilterNone) + `timeInterval: 1000ms`
 *      → no Android isso mapeia para o FusedLocationProviderClient com
 *      PRIORITY_HIGH_ACCURACY a ~1 fix/s;
 *   2) leituras ruins (accuracy > 25 m ou timestamp fora de ordem) são
 *      DESCARTADAS antes de qualquer uso;
 *   3) lat/lng passam por um filtro de Kalman (fim do tremor do GPS);
 *   4) o heading é escolhido pela regra veicular (curso do GPS quando em
 *      movimento; congelado quando parado) e suavizado por média circular das
 *      últimas leituras.
 *
 * NÃO liga rastreamento em segundo plano (isso exigiria rebuild nativo +
 * revisão das lojas); esta tela é de primeiro plano, com o motorista olhando.
 *
 * Modo simulação: passe `simulate` com uma lista de fixes (ver nav/simulator)
 * para "dirigir" uma rota no emulador, 1 fix por `simulateIntervalMs`, sem GPS.
 */
export interface NavFix {
  lat: number;
  lng: number;
  /** Rumo suavizado (graus, 0 = norte). */
  heading: number;
  /** Velocidade instantânea (m/s, ≥ 0). */
  speed: number;
  /** Precisão (m). */
  accuracy: number;
  /** Timestamp do fix (ms). */
  timestampMs: number;
}

interface Options {
  enabled?: boolean;
  /** Se definido e não-vazio, IGNORA o GPS e reproduz estes fixes. */
  simulate?: SimFix[] | null;
  simulateIntervalMs?: number;
}

const HEADING_WINDOW = 5;

export function useNavigationLocation(options?: Options): { fix: NavFix | null } {
  const enabled = options?.enabled ?? true;
  const simulate = options?.simulate ?? null;
  const simulateIntervalMs = options?.simulateIntervalMs ?? 1000;

  const [fix, setFix] = useState<NavFix | null>(null);

  const kalmanRef = useRef(new GeoKalman());
  const lastTsRef = useRef<number | null>(null);
  const lastHeadingRef = useRef(0);
  const headingRingRef = useRef<number[]>([]);

  // Reinicia todo o estado do filtro (troca GPS↔simulação, re-rota, etc.).
  const resetFilter = useCallback(() => {
    kalmanRef.current = new GeoKalman();
    lastTsRef.current = null;
    lastHeadingRef.current = 0;
    headingRingRef.current = [];
  }, []);

  /**
   * Processa UMA leitura crua (do GPS ou da simulação) por todo o pipeline e,
   * se ela sobreviver ao descarte, publica o fix suavizado.
   */
  const ingest = useCallback(
    (raw: { latitude: number; longitude: number; accuracy?: number | null; heading?: number | null; speed?: number | null }, timestampMs: number) => {
      const accuracy = raw.accuracy != null && raw.accuracy >= 0 ? raw.accuracy : undefined;
      if (!isAcceptableFix({ accuracy, timestampMs }, lastTsRef.current)) return;

      const accForKalman = accuracy ?? 15;
      const smooth = kalmanRef.current.process(raw.latitude, raw.longitude, accForKalman, timestampMs);

      const speed = raw.speed != null && raw.speed >= 0 ? raw.speed : 0;
      const course = raw.heading != null && raw.heading >= 0 ? raw.heading : null;

      const motionHeading = headingForMotion({ speedMps: speed, course, lastHeading: lastHeadingRef.current });
      const ring = headingRingRef.current;
      ring.push(motionHeading);
      if (ring.length > HEADING_WINDOW) ring.shift();
      const smoothHeading = circularMean(ring);

      lastHeadingRef.current = smoothHeading;
      lastTsRef.current = timestampMs;

      setFix({
        lat: smooth.lat,
        lng: smooth.lng,
        heading: smoothHeading,
        speed,
        accuracy: accForKalman,
        timestampMs,
      });
    },
    [],
  );

  // ── Simulação: reproduz os fixes um a um, sem tocar no GPS ──────────────────
  useEffect(() => {
    if (!enabled || !simulate || simulate.length === 0) return;
    resetFilter();
    let i = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      if (i >= simulate.length) return;
      const f = simulate[i++];
      // timestamp real crescente garante ordem no filtro, independente do mock.
      ingest({ latitude: f.lat, longitude: f.lng, accuracy: f.accuracy, heading: f.heading, speed: f.speed }, Date.now());
      timer = setTimeout(tick, simulateIntervalMs);
    };
    tick();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [enabled, simulate, simulateIntervalMs, ingest, resetFilter]);

  // ── GPS real de máxima precisão ─────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || (simulate && simulate.length > 0)) return;

    let active = true;
    let sub: ExpoLocation.LocationSubscription | null = null;
    resetFilter();

    (async () => {
      const { status } = await ExpoLocation.requestForegroundPermissionsAsync();
      if (status !== 'granted' || !active) return;

      // Semente rápida (posição aproximada) para o mapa não abrir vazio enquanto
      // o primeiro fix `BestForNavigation` resolve.
      try {
        const seed = await ExpoLocation.getCurrentPositionAsync({ accuracy: ExpoLocation.Accuracy.Balanced });
        if (active) ingest(seed.coords, seed.timestamp);
      } catch {
        /* segue para o watch de alta precisão */
      }
      if (!active) return;

      sub = await ExpoLocation.watchPositionAsync(
        {
          // `BestForNavigation` já seleciona o perfil de navegação (no iOS mapeia
          // para kCLLocationAccuracyBestForNavigation). O `activityType`
          // (.automotiveNavigation) não é exposto nas options JS desta versão do
          // expo-location, então fica de fora — sem impacto no Android.
          accuracy: ExpoLocation.Accuracy.BestForNavigation,
          distanceInterval: 0, // kCLDistanceFilterNone — todas as leituras
          timeInterval: 1000, // ~1 fix/s (Android FusedLocation PRIORITY_HIGH_ACCURACY)
          mayShowUserSettingsDialog: true,
        },
        (pos) => {
          if (active) ingest(pos.coords, pos.timestamp);
        },
      );
      if (!active) {
        sub.remove();
        sub = null;
      }
    })();

    return () => {
      active = false;
      sub?.remove();
      sub = null;
    };
  }, [enabled, simulate, ingest, resetFilter]);

  return { fix };
}
