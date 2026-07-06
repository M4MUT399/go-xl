import React from 'react';
import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '../../hooks/useTheme';

// Geometria da seta em um viewBox fixo — aponta para CIMA (north) quando
// rotation=0. O SVG escala pelo container (width/height), então basta ajustar
// containerW/H pelo `scale` para redimensionar sem recalcular pontos.
const BASE_W = 36;
const BASE_H = 48;

/**
 * Corpo inteiro da seta (ponta triangular + haste). Haste 40% mais curta que
 * a versão anterior (35 → 21 de altura) e afunilada (mais larga na base,
 * mais estreita perto da ponta) — o alargamento da base simula perspectiva
 * forçada, como se a cauda estivesse sempre "colada" ao chão bem debaixo do
 * motorista e a seta se estreitasse ao se afastar em direção ao horizonte.
 */
const ARROW_PATH = 'M18,0 L34,27 L24,27 L28,48 L8,48 L12,27 L2,27 Z';

/**
 * Marcador de navegação GPS — usado no modo de condução ativa.
 *
 * Seta (haste + ponta) apontando para CIMA (north) quando rotation=0.
 * O <Marker rotation={heading}> pai rotaciona tudo para o sentido do movimento.
 * flat={true} no Marker garante que o ícone fique plano sobre o mapa (não billboard).
 *
 * Substitui o triângulo simples anterior por uma seta de verdade (mesma ideia
 * de referência visual pedida pelo usuário), redesenhada 100% com a paleta do
 * app — sem nenhum fundo/quadro branco ao redor, só a forma da seta:
 *   1. Sombra deslocada       — simula profundidade
 *   2. Contorno branco (stroke fino) — legibilidade sobre qualquer cor de mapa
 *   3. Preenchimento dourado (accent) — cor de marca, seta toda em dourado
 */
export function NavChevron({ scale = 1 }: { scale?: number }) {
  const { colors } = useTheme();
  const containerW = BASE_W * scale;
  const containerH = BASE_H * scale;

  return (
    <View
      collapsable={false}
      style={{ width: containerW, height: containerH, alignItems: 'center', justifyContent: 'center' }}
    >
      <Svg width={containerW} height={containerH} viewBox={`0 0 ${BASE_W} ${BASE_H}`}>
        {/* Sombra */}
        <Path d={ARROW_PATH} fill="rgba(0,0,0,0.25)" transform="translate(0, 3)" />
        {/* Seta principal: preenchimento dourado + contorno branco fino para legibilidade */}
        <Path d={ARROW_PATH} fill={colors.accent} stroke="#ffffff" strokeWidth={2} strokeLinejoin="round" />
      </Svg>
    </View>
  );
}
