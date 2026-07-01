import React from 'react';
import { View } from 'react-native';
import { useTheme } from '../../hooks/useTheme';

/**
 * Marcador de navegação GPS — usado no modo de condução ativa.
 *
 * Triângulo apontando para CIMA (north) quando rotation=0.
 * O <Marker rotation={heading}> pai rotaciona tudo para o sentido do movimento.
 * flat={true} no Marker garante que o ícone fique plano sobre o mapa (não billboard).
 *
 * Camadas:
 *   1. Sombra deslocada — simula profundidade
 *   2. Contorno branco  — garante legibilidade sobre qualquer cor de mapa
 *   3. Preenchimento accent — cor de marca
 */
export function NavChevron({ scale = 1 }: { scale?: number }) {
  const { colors } = useTheme();
  const hw = 17 * scale;   // meia-largura da base
  const h  = 40 * scale;   // altura total

  const containerW = (hw + 6) * 2;
  const containerH = h + 10;

  return (
    <View
      collapsable={false}
      style={{ width: containerW, height: containerH, alignItems: 'center' }}
    >
      {/* Sombra */}
      <View
        style={{
          position: 'absolute',
          top: 6,
          width: 0,
          height: 0,
          borderStyle: 'solid',
          borderLeftWidth: hw + 4,
          borderRightWidth: hw + 4,
          borderBottomWidth: h + 4,
          borderBottomColor: 'rgba(0,0,0,0.22)',
          borderLeftColor: 'transparent',
          borderRightColor: 'transparent',
        }}
      />
      {/* Contorno branco */}
      <View
        style={{
          position: 'absolute',
          top: 0,
          width: 0,
          height: 0,
          borderStyle: 'solid',
          borderLeftWidth: hw + 4,
          borderRightWidth: hw + 4,
          borderBottomWidth: h + 4,
          borderBottomColor: '#ffffff',
          borderLeftColor: 'transparent',
          borderRightColor: 'transparent',
        }}
      />
      {/* Triângulo accent principal */}
      <View
        style={{
          position: 'absolute',
          top: 4,
          width: 0,
          height: 0,
          borderStyle: 'solid',
          borderLeftWidth: hw,
          borderRightWidth: hw,
          borderBottomWidth: h,
          borderBottomColor: colors.accent,
          borderLeftColor: 'transparent',
          borderRightColor: 'transparent',
        }}
      />
      {/* Ápice escuro — cria ilusão de espessura/3-D */}
      <View
        style={{
          position: 'absolute',
          top: 4,
          width: 0,
          height: 0,
          borderStyle: 'solid',
          borderLeftWidth: hw * 0.36,
          borderRightWidth: hw * 0.36,
          borderBottomWidth: h * 0.30,
          borderBottomColor: colors.primary,
          borderLeftColor: 'transparent',
          borderRightColor: 'transparent',
        }}
      />
    </View>
  );
}
