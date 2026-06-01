import React from 'react';
import { View } from 'react-native';

/**
 * SUV preto visto de cima — Views puras, sem SVG.
 * Funciona dentro de <Marker> do react-native-maps em iOS e Android.
 * Nariz aponta para CIMA; a rotação vem do prop `rotation` do <Marker>.
 */
export function TopDownSuvMarker({ size = 40 }: { size?: number }) {
  // Tudo calculado a partir do height (size). Proporção: 28 × 48.
  const h = size;
  const w = Math.round(size * (28 / 48));
  // Espaço lateral para os retrovisores sem posicionamento negativo
  const mirrorW = Math.round(size * (4 / 48));
  const totalW = w + mirrorW * 2;
  const p = (v: number) => Math.round((v / 48) * size); // escala

  return (
    <View collapsable={false} style={{ width: totalW, height: h }}>

      {/* ── Retrovisor esquerdo ── */}
      <View style={{
        position: 'absolute',
        left: 0,
        top: p(16),
        width: mirrorW,
        height: p(7),
        backgroundColor: '#1a1a1a',
        borderTopLeftRadius: p(1),
        borderBottomLeftRadius: p(1),
      }} />

      {/* ── Retrovisor direito ── */}
      <View style={{
        position: 'absolute',
        right: 0,
        top: p(16),
        width: mirrorW,
        height: p(7),
        backgroundColor: '#1a1a1a',
        borderTopRightRadius: p(1),
        borderBottomRightRadius: p(1),
      }} />

      {/* ── Carroceria ── */}
      <View style={{
        position: 'absolute',
        left: mirrorW,
        top: 0,
        width: w,
        height: h,
        backgroundColor: '#111111',
        borderRadius: p(7),
        overflow: 'hidden',
      }}>

        {/* Capô / frente */}
        <View style={{
          position: 'absolute',
          top: 0, left: 0, right: 0,
          height: p(14),
          backgroundColor: '#181818',
          borderTopLeftRadius: p(7),
          borderTopRightRadius: p(7),
        }} />

        {/* Para-brisa dianteiro */}
        <View style={{
          position: 'absolute',
          top: p(5),
          left: p(3), right: p(3),
          height: p(8),
          backgroundColor: 'rgba(140,210,245,0.55)',
          borderRadius: p(3),
        }} />

        {/* Teto */}
        <View style={{
          position: 'absolute',
          top: p(15),
          left: p(2), right: p(2),
          height: p(16),
          backgroundColor: '#1e1e1e',
          borderRadius: p(2),
        }} />

        {/* Vidro traseiro */}
        <View style={{
          position: 'absolute',
          bottom: p(5),
          left: p(3), right: p(3),
          height: p(7),
          backgroundColor: 'rgba(140,210,245,0.38)',
          borderRadius: p(3),
        }} />

        {/* Tampa traseira */}
        <View style={{
          position: 'absolute',
          bottom: 0, left: 0, right: 0,
          height: p(12),
          backgroundColor: '#181818',
          borderBottomLeftRadius: p(7),
          borderBottomRightRadius: p(7),
        }} />

        {/* Faróis — cinza claro */}
        <View style={{
          position: 'absolute',
          top: p(2), left: p(2),
          width: p(7), height: p(4),
          backgroundColor: '#d0d4d8',
          borderRadius: p(2),
        }} />
        <View style={{
          position: 'absolute',
          top: p(2), right: p(2),
          width: p(7), height: p(4),
          backgroundColor: '#d0d4d8',
          borderRadius: p(2),
        }} />

        {/* Lanternas traseiras — vermelho */}
        <View style={{
          position: 'absolute',
          bottom: p(2), left: p(2),
          width: p(7), height: p(4),
          backgroundColor: '#cc2222',
          borderRadius: p(2),
        }} />
        <View style={{
          position: 'absolute',
          bottom: p(2), right: p(2),
          width: p(7), height: p(4),
          backgroundColor: '#cc2222',
          borderRadius: p(2),
        }} />

      </View>
    </View>
  );
}
