import React from 'react';
import { View, Image, StyleSheet } from 'react-native';
import { useTheme } from '../../hooks/useTheme';

// Logo GoXL (mesmo asset do app). O PNG tem fundo marinho, que se funde com o
// círculo marinho do marcador — então só o "GX" dourado aparece dentro dele.
const LOGO = require('../../../assets/icon.png');

/**
 * Marcador de motorista para react-native-maps.
 *
 *   ◆   ← seta de sentido em camadas (sombra + contorno branco + accent +
 *  (GX)    ápice escuro). Gira conforme o `heading` do GPS.
 *
 * Decisões de layout:
 *   - A LOGO fica SEMPRE em pé (logo girando/de cabeça pra baixo fica feia).
 *     Só a SETA gira — a rotação é aplicada num grupo próprio, NÃO via prop
 *     `rotation` do <Marker> (senão a logo giraria junto).
 *   - O `container` é DIMENSIONADO A PARTIR do alcance máximo da seta + margem.
 *     No Android o <Marker> rasteriza o filho num bitmap e RECORTA tudo que
 *     passa das bordas do container; por isso o container precisa conter o
 *     círculo, a sombra e a seta INTEIRA (em qualquer ângulo de rotação) com
 *     folga. Era essa a causa do "logo/círculo cortado" no Android.
 *
 * `scale`   aumenta/reduz tudo proporcionalmente (1 = padrão).
 * `heading` em graus (0 = norte, 90 = leste…).
 */
export function CarMarker({ scale = 1, heading = 0 }: { scale?: number; heading?: number }) {
  const { colors } = useTheme();

  // — Círculo com a logo —
  const circle = 44 * scale;
  const circleBorder = 3 * scale;
  const circleOuterR = circle / 2 + circleBorder; // raio externo do círculo
  const shadow = 42 * scale;

  // — Seta de sentido (arrowhead em camadas, apontando p/ CIMA) —
  const arrowH = 20 * scale;     // altura do triângulo principal
  const arrowHW = 12.5 * scale;  // meia-largura da base
  const gap = 1 * scale;         // folga entre base da seta e a borda do círculo
  const tipY = circleOuterR + gap + arrowH; // distância do centro até o ÁPICE

  // Container grande o suficiente p/ conter o ápice (em qualquer rotação) + margem.
  const margin = 8 * scale;
  const container = 2 * (tipY + margin);

  // translateY de cada camada — apexes alinhados no mesmo ponto (-tipY do centro).
  const outlineH = arrowH + 3 * scale;
  const outlineHW = arrowHW + 2.5 * scale;
  const tOutline = -(tipY + 1.5 * scale) + outlineH / 2; // contorno um tico acima
  const tShadow = tOutline + 2 * scale;                  // sombra deslocada p/ baixo
  const tAccent = -tipY + arrowH / 2;
  const apexH = arrowH * 0.34;
  const apexHW = arrowHW * 0.36;
  const tApex = -tipY + apexH / 2;

  const triangle = (hw: number, h: number, color: string) => ({
    width: 0,
    height: 0,
    borderStyle: 'solid' as const,
    borderLeftWidth: hw,
    borderRightWidth: hw,
    borderBottomWidth: h,
    borderBottomColor: color,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  });

  return (
    <View
      collapsable={false}
      style={[styles.container, { width: container, height: container }]}
    >
      {/* sombra suave sob o círculo */}
      <View style={styles.layer} pointerEvents="none">
        <View
          style={[
            styles.circleShadow,
            {
              width: shadow,
              height: shadow,
              borderRadius: shadow / 2,
              transform: [{ translateY: 4 * scale }],
            },
          ]}
        />
      </View>

      {/* círculo + LOGO — NÃO gira, logo sempre legível */}
      <View style={styles.layer} pointerEvents="none">
        <View
          style={[
            styles.circle,
            {
              width: circle,
              height: circle,
              borderRadius: circle / 2,
              borderWidth: circleBorder,
              backgroundColor: colors.primary,
              borderColor: colors.accent,
            },
          ]}
        >
          <Image
            source={LOGO}
            style={{ width: circle * 1.15, height: circle * 1.15 }}
            resizeMode="cover"
          />
        </View>
      </View>

      {/* GRUPO da seta — só ele gira conforme o heading do GPS.
          Todas as camadas empilhadas no mesmo centro do container. */}
      <View
        style={[styles.layer, { transform: [{ rotate: `${heading}deg` }] }]}
        pointerEvents="none"
      >
        {/* sombra da seta */}
        <View style={styles.layer}>
          <View style={[triangle(outlineHW, outlineH, 'rgba(0,0,0,0.22)'), { transform: [{ translateY: tShadow }] }]} />
        </View>
        {/* contorno branco — legibilidade sobre qualquer cor de mapa */}
        <View style={styles.layer}>
          <View style={[triangle(outlineHW, outlineH, '#ffffff'), { transform: [{ translateY: tOutline }] }]} />
        </View>
        {/* preenchimento accent (dourado) */}
        <View style={styles.layer}>
          <View style={[triangle(arrowHW, arrowH, colors.accent), { transform: [{ translateY: tAccent }] }]} />
        </View>
        {/* ápice escuro — ilusão de espessura/3-D, dá o toque premium */}
        <View style={styles.layer}>
          <View style={[triangle(apexHW, apexH, colors.primary), { transform: [{ translateY: tApex }] }]} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Camada que preenche o container e centraliza seu único filho. Usada para
  // empilhar (overlay) sombra, círculo e seta todos no mesmo centro.
  layer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  circleShadow: {
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden', // recorta a imagem no formato do círculo (sem "quina")
  },
});
