import React from 'react';
import Svg, { Path, Rect, Circle, Ellipse, Line } from 'react-native-svg';

interface Props {
  width?: number;
  height?: number;
}

/**
 * Cadillac Escalade side view — flat / minimal style, dark-grey palette.
 * Front faces right.
 */
export function SuvIcon({ width = 110, height = 52 }: Props) {
  return (
    <Svg width={width} height={height} viewBox="0 0 280 120">

      {/* Shadow */}
      <Ellipse cx="140" cy="117" rx="114" ry="4" fill="rgba(0,0,0,0.18)" />

      {/* ── Main body ─────────────────────────────────────────────── */}
      <Path
        d="
          M 37 76
          L 37 62
          L 40 30
          Q 43 19 50 18
          L 168 18
          L 180 19
          L 194 40
          L 232 40
          L 240 49
          L 244 63
          L 244 76
          Z
        "
        fill="#3a3a3a"
      />

      {/* Hood panel — slightly lighter */}
      <Path
        d="M 181 20 L 194 40 L 232 40 L 232 20 Z"
        fill="#424242"
      />

      {/* ── Windows ───────────────────────────────────────────────── */}

      {/* Rear liftgate glass */}
      <Path
        d="M 41 28 Q 44 20 50 19 L 56 19 L 57 40 L 41 40 Z"
        fill="#1e2d3a"
        opacity="0.88"
      />

      {/* Rear quarter glass */}
      <Rect x="58" y="19" width="26" height="21" fill="#1e2d3a" opacity="0.88" />

      {/* D-pillar */}
      <Rect x="84" y="18" width="4" height="22" fill="#282828" />

      {/* 3rd-row window */}
      <Rect x="89" y="19" width="23" height="21" fill="#1e2d3a" opacity="0.88" />

      {/* C-pillar */}
      <Rect x="112" y="18" width="4" height="22" fill="#282828" />

      {/* 2nd-row window */}
      <Rect x="117" y="19" width="27" height="21" fill="#1e2d3a" opacity="0.88" />

      {/* B-pillar */}
      <Rect x="144" y="18" width="4.5" height="22" fill="#282828" />

      {/* Front door window */}
      <Rect x="149" y="19" width="21" height="21" fill="#1e2d3a" opacity="0.88" />

      {/* Windshield */}
      <Path
        d="M 170 19 L 180 20 L 194 40 L 170 40 Z"
        fill="#1e2d3a"
        opacity="0.88"
      />

      {/* Window glare highlights */}
      <Path d="M 150 21 L 167 21 L 167 24 L 150 23 Z" fill="rgba(255,255,255,0.07)" />
      <Path d="M 118 21 L 140 21 L 140 24 L 118 23 Z" fill="rgba(255,255,255,0.07)" />
      <Path d="M  89 21 L 110 21 L 110 24 L  89 23 Z" fill="rgba(255,255,255,0.07)" />

      {/* ── Roof rail ─────────────────────────────────────────────── */}
      <Rect x="51" y="16" width="117" height="3" rx="1.5" fill="#2e2e2e" />

      {/* ── Side mirror ───────────────────────────────────────────── */}
      <Path d="M 183 27 L 193 27 L 193 33 L 183 31 Z" fill="#2e2e2e" />

      {/* ── Body crease line ──────────────────────────────────────── */}
      <Path d="M 38 55 L 237 55" stroke="#2e2e2e" strokeWidth="2" fill="none" />

      {/* ── Front fascia ──────────────────────────────────────────── */}

      {/* Vertical LED headlight — amber */}
      <Rect x="232" y="40" width="5.5" height="18" rx="2.5" fill="#c8a030" opacity="0.95" />
      {/* DRL strip */}
      <Rect x="220" y="40" width="11" height="2.5" rx="1.2" fill="#d4aa40" opacity="0.8" />

      {/* Grille */}
      <Path d="M 238 52 L 244 52 L 244 65 L 237 65 Z" fill="#252525" />
      <Line x1="237" y1="56" x2="244" y2="56" stroke="#303030" strokeWidth="1.2" />
      <Line x1="237" y1="59" x2="244" y2="59" stroke="#303030" strokeWidth="1.2" />
      <Line x1="237" y1="62" x2="244" y2="62" stroke="#303030" strokeWidth="1.2" />

      {/* Lower bumper */}
      <Path d="M 234 65 L 244 65 L 244 74 L 232 74 Z" fill="#2e2e2e" />
      {/* Fog light */}
      <Rect x="224" y="65" width="10" height="6" rx="1.5" fill="#1a2a38" opacity="0.85" />

      {/* ── Rear fascia ───────────────────────────────────────────── */}

      {/* Tail light — tall vertical strip */}
      <Rect x="35" y="27" width="5.5" height="28" rx="2.5" fill="#6b0000" opacity="0.95" />
      <Rect x="36.5" y="29" width="2.5" height="24" rx="1.2" fill="#cc1010" opacity="0.85" />

      {/* Rear bumper step */}
      <Path d="M 35 67 L 44 67 L 44 74 L 35 74 Z" fill="#2e2e2e" />

      {/* ── Door handles ──────────────────────────────────────────── */}
      <Rect x="161" y="49" width="10" height="2.5" rx="1.2" fill="#505050" />
      <Rect x="128" y="49" width="10" height="2.5" rx="1.2" fill="#505050" />
      <Rect x="97"  y="49" width="10" height="2.5" rx="1.2" fill="#505050" />

      {/* ── Running board ─────────────────────────────────────────── */}
      <Rect x="58" y="72" width="178" height="6" rx="3" fill="#2e2e2e" />
      <Line x1="90"  y1="73" x2="90"  y2="77" stroke="#404040" strokeWidth="1" />
      <Line x1="130" y1="73" x2="130" y2="77" stroke="#404040" strokeWidth="1" />
      <Line x1="170" y1="73" x2="170" y2="77" stroke="#404040" strokeWidth="1" />
      <Line x1="210" y1="73" x2="210" y2="77" stroke="#404040" strokeWidth="1" />

      {/* ── Wheel arches ──────────────────────────────────────────── */}
      <Path d="M 40 76 Q 42 69 68 69 Q 94 69 96 76"  fill="#303030" />
      <Path d="M 184 76 Q 186 69 210 69 Q 234 69 236 76" fill="#303030" />

      {/* ── REAR WHEEL (cx=68, cy=94, r=19) ──────────────────────── */}
      <Circle cx="68" cy="94" r="19"   fill="#282828" />
      <Circle cx="68" cy="94" r="15.5" fill="#333333" />
      {/* 5 spokes — 72° apart */}
      <Line x1="68"   y1="87"    x2="68"   y2="78"    stroke="#555555" strokeWidth="3.5" strokeLinecap="round" />
      <Line x1="74.7" y1="91.8"  x2="83.2" y2="89.1"  stroke="#555555" strokeWidth="3.5" strokeLinecap="round" />
      <Line x1="72.1" y1="99.7"  x2="77.4" y2="106.9" stroke="#555555" strokeWidth="3.5" strokeLinecap="round" />
      <Line x1="63.9" y1="99.7"  x2="58.6" y2="106.9" stroke="#555555" strokeWidth="3.5" strokeLinecap="round" />
      <Line x1="61.3" y1="91.8"  x2="52.8" y2="89.1"  stroke="#555555" strokeWidth="3.5" strokeLinecap="round" />
      <Circle cx="68" cy="94" r="6"   fill="#3a3a3a" />
      <Circle cx="68" cy="94" r="2.5" fill="#484848" />

      {/* ── FRONT WHEEL (cx=210, cy=94, r=19) ────────────────────── */}
      <Circle cx="210" cy="94" r="19"   fill="#282828" />
      <Circle cx="210" cy="94" r="15.5" fill="#333333" />
      <Line x1="210"   y1="87"    x2="210"   y2="78"    stroke="#555555" strokeWidth="3.5" strokeLinecap="round" />
      <Line x1="216.7" y1="91.8"  x2="225.2" y2="89.1"  stroke="#555555" strokeWidth="3.5" strokeLinecap="round" />
      <Line x1="214.1" y1="99.7"  x2="219.4" y2="106.9" stroke="#555555" strokeWidth="3.5" strokeLinecap="round" />
      <Line x1="205.9" y1="99.7"  x2="200.6" y2="106.9" stroke="#555555" strokeWidth="3.5" strokeLinecap="round" />
      <Line x1="203.3" y1="91.8"  x2="194.8" y2="89.1"  stroke="#555555" strokeWidth="3.5" strokeLinecap="round" />
      <Circle cx="210" cy="94" r="6"   fill="#3a3a3a" />
      <Circle cx="210" cy="94" r="2.5" fill="#484848" />

    </Svg>
  );
}
