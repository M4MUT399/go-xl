import React from 'react';
import { View, Image, StyleSheet } from 'react-native';
import { useTheme } from '../../hooks/useTheme';

// Logo GoXL (mesmo asset do app). O PNG tem fundo marinho, que se funde com o
// círculo marinho do marcador — então só o "GX" dourado aparece dentro dele.
const LOGO = require('../../../assets/icon.png');

/**
 * Marcador de motorista para react-native-maps.
 *
 *   ▲   ← seta de sentido (dourada). Gira conforme o `heading` do GPS,
 *  (GX)    indicando para onde o veículo está indo.
 *
 * Decisão de layout:
 *   - A LOGO fica SEMPRE em pé (uma logo girando/de cabeça pra baixo fica feia).
 *   - Só a SETA gira. Por isso a rotação é feita AQUI dentro (transform na
 *     camada da seta) e NÃO mais via prop `rotation` do <Marker> — senão o
 *     marcador inteiro (logo incluída) giraria junto.
 *
 * `scale`   aumenta/reduz tudo proporcionalmente (1 = padrão).
 * `heading` em graus (0 = norte, 90 = leste…).
 */
export function CarMarker({ scale = 1, heading = 0 }: { scale?: number; heading?: number }) {
  const { colors } = useTheme();
  const container = 64 * scale;   // folga p/ a seta orbitar sem ser cortada
  const shadow = 36 * scale;
  const circle = 38 * scale;
  const arrowSize = 13 * scale;
  const arrowRadius = 24 * scale; // distância da seta ao centro do círculo

  return (
    <View
      collapsable={false}
      style={[styles.container, { width: container, height: container }]}
    >
      {/* sombra suave sob o círculo */}
      <View style={styles.layer} pointerEvents="none">
        <View
          style={[
            styles.shadow,
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
              borderWidth: 2.5 * scale,
              backgroundColor: colors.primary,
              borderColor: colors.accent,
            },
          ]}
        >
          {/* 25% maior que o ícone anterior. O "GX" ocupa ~64% da imagem;
              ampliando a imagem para 1.15× o círculo, o mark fica ~27px (o
              carrinho anterior tinha ~20px). O overflow:hidden do círculo
              recorta o excedente no formato redondo. */}
          <Image
            source={LOGO}
            style={{ width: circle * 1.15, height: circle * 1.15 }}
            resizeMode="cover"
          />
        </View>
      </View>

      {/* seta de sentido — só ela gira conforme o heading do GPS */}
      <View
        style={[styles.layer, { transform: [{ rotate: `${heading}deg` }] }]}
        pointerEvents="none"
      >
        <View
          style={[
            styles.arrow,
            {
              borderLeftWidth: arrowSize * 0.7,
              borderRightWidth: arrowSize * 0.7,
              borderBottomWidth: arrowSize,
              borderBottomColor: colors.accent,
              transform: [{ translateY: -arrowRadius }],
            },
          ]}
        />
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
  shadow: {
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden', // recorta a imagem no formato do círculo (sem "quina")
  },
  arrow: {
    width: 0,
    height: 0,
    backgroundColor: 'transparent',
    borderStyle: 'solid',
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
  },
});
