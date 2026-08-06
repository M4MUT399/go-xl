import React from 'react';
import Svg, { Circle, Line } from 'react-native-svg';

/**
 * Ícone de mira (crosshair/reticle) — usado no botão de "centralizar no mapa".
 * Mais intuitivo que um glifo de texto genérico: lembra um alvo de GPS/câmera.
 */
export function CrosshairIcon({ size, color }: { size: number; color: string }) {
  const c = size / 2;
  const ringR = size * 0.28;
  const tickInner = size * 0.38;
  const tickOuter = size * 0.48;
  const strokeWidth = size * 0.09;
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <Circle cx={c} cy={c} r={ringR} stroke={color} strokeWidth={strokeWidth} fill="none" />
      <Circle cx={c} cy={c} r={strokeWidth * 0.6} fill={color} />
      <Line x1={c} y1={0} x2={c} y2={tickInner} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <Line x1={c} y1={tickOuter} x2={c} y2={size} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <Line x1={0} y1={c} x2={tickInner} y2={c} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
      <Line x1={tickOuter} y1={c} x2={size} y2={c} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" />
    </Svg>
  );
}
