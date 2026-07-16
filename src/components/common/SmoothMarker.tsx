// components/SmoothMarker — marcador de veículo com MOVIMENTO FLUIDO (Bloco 2).
//
// Reutilizável (motorista e passageiro). Envolve <MarkerAnimated> preso a uma
// <AnimatedRegion>: cada fix ANIMA a posição nativamente (60 fps, sem re-render
// do React nem teleporte). Toda a decisão (interpolação, snap-na-rota, dead
// reckoning, rotação pelo arco mais curto) vem do núcleo PURO nav/smoothMarker,
// que é testado em unidade. Aqui só orquestramos os timers/refs do Animated.
//
// Uso (render-prop entrega o heading suavizado ao visual):
//   <SmoothMarker fix={fix} route={remaining} anchor={{x:0.5,y:0.5}}>
//     {(heading) => <CarMarker scale={0.75} heading={heading} />}
//   </SmoothMarker>

import React, { useEffect, useRef, useState } from 'react';
import { MarkerAnimated, AnimatedRegion } from 'react-native-maps';
import type { LatLngLite } from '../../lib/nav/geo';
import {
  DEFAULT_SMOOTH,
  continuousHeading,
  deadReckon,
  interpolationDuration,
  resolveTarget,
  type MarkerFix,
  type SmoothMarkerConfig,
} from '../../lib/nav/smoothMarker';

interface SmoothMarkerProps {
  /** Fix atual (posição/rumo/velocidade/timestamp). null = ainda sem posição. */
  fix: MarkerFix | null | undefined;
  /** Polyline da rota (trecho restante) para colar o marcador na via. Opcional. */
  route?: LatLngLite[] | null;
  /** Ajustes finos sobre DEFAULT_SMOOTH (interpolação/snap/dead reckoning). */
  config?: Partial<SmoothMarkerConfig>;
  /** Projeta a posição à frente quando o fix atrasa (padrão: true). */
  deadReckoning?: boolean;
  anchor?: { x: number; y: number };
  zIndex?: number;
  /** Visual do marcador; recebe o heading contínuo/suavizado (graus). */
  children: (heading: number) => React.ReactNode;
}

export function SmoothMarker({
  fix,
  route,
  config,
  deadReckoning = true,
  anchor = { x: 0.5, y: 0.5 },
  zIndex,
  children,
}: SmoothMarkerProps) {
  const cfg: SmoothMarkerConfig = { ...DEFAULT_SMOOTH, ...config };
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  // AnimatedRegion viva do marcador (criada uma vez). latitude/longitude são o
  // que o MarkerAnimated consome; os deltas ficam em 0 (marcador não tem área).
  const regionRef = useRef<AnimatedRegion | null>(null);
  if (regionRef.current == null && fix) {
    regionRef.current = new AnimatedRegion({
      latitude: fix.lat,
      longitude: fix.lng,
      latitudeDelta: 0,
      longitudeDelta: 0,
    });
  }

  const hasFixRef = useRef(false);
  const prevTsRef = useRef<number | null>(null);
  const lastFixRef = useRef<MarkerFix | null>(null);
  const contHeadingRef = useRef<number | null>(null);
  const [heading, setHeading] = useState(0);
  // Força montar o MarkerAnimated assim que a região existir (1º fix).
  const [ready, setReady] = useState(false);

  // ── A cada novo fix: anima posição + atualiza rumo, e reancora o relógio do
  //    dead reckoning. Depende só de lat/lng/timestamp (evita reprocessar à toa).
  useEffect(() => {
    const region = regionRef.current;
    if (!fix || !region) return;
    lastFixRef.current = fix;

    const target = resolveTarget(fix, route, cfgRef.current);

    if (!hasFixRef.current) {
      // Primeiro fix: crava a posição (sem glide vindo de um seed velho).
      region.setValue({ latitude: target.lat, longitude: target.lng, latitudeDelta: 0, longitudeDelta: 0 });
      hasFixRef.current = true;
      setReady(true);
    } else {
      const duration = interpolationDuration(prevTsRef.current, fix.timestampMs, cfgRef.current);
      region
        .timing({
          latitude: target.lat,
          longitude: target.lng,
          latitudeDelta: 0,
          longitudeDelta: 0,
          duration: duration || cfgRef.current.interpolateMs,
          useNativeDriver: false,
          toValue: 0,
        } as any)
        .start();
    }
    prevTsRef.current = fix.timestampMs;

    const nextHeading = continuousHeading(contHeadingRef.current, fix, cfgRef.current);
    contHeadingRef.current = nextHeading;
    setHeading(nextHeading);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fix?.lat, fix?.lng, fix?.timestampMs]);

  // ── Dead reckoning: quando o próximo fix atrasa, projeta a posição à frente
  //    pelo último rumo+velocidade (limitado a deadReckonMaxMs no núcleo puro).
  //    Depois desse teto a projeção para de avançar → o marcador congela sozinho.
  useEffect(() => {
    if (!deadReckoning) return;
    const tickMs = 500;
    const id = setInterval(() => {
      const region = regionRef.current;
      const last = lastFixRef.current;
      if (!region || !last || !hasFixRef.current) return;
      const now = Date.now();
      // Só projeta se o fix já "venceu" a janela de interpolação (senão a própria
      // animação do fix ainda está em curso e não devemos competir com ela).
      if (now - last.timestampMs < cfgRef.current.interpolateMs) return;
      const projected = deadReckon(last, now, cfgRef.current);
      region
        .timing({
          latitude: projected.lat,
          longitude: projected.lng,
          latitudeDelta: 0,
          longitudeDelta: 0,
          duration: tickMs,
          useNativeDriver: false,
          toValue: 0,
        } as any)
        .start();
    }, tickMs);
    return () => clearInterval(id);
  }, [deadReckoning]);

  if (!regionRef.current || !ready) return null;

  return (
    <MarkerAnimated
      coordinate={regionRef.current as any}
      anchor={anchor}
      zIndex={zIndex}
      tracksViewChanges={false}
    >
      {children(heading)}
    </MarkerAnimated>
  );
}
