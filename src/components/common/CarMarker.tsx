import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '../../hooks/useTheme';

/**
 * Marcador de carro para react-native-maps.
 * Usa layout plano (sem position:absolute) para garantir
 * renderização correta dentro de <Marker> em iOS e Android.
 *
 * `scale` reduz/aumenta proporcionalmente o ícone (1 = tamanho padrão).
 */
export function CarMarker({ scale = 1 }: { scale?: number }) {
  const { colors } = useTheme();
  const container = 46 * scale;
  const shadow = 36 * scale;
  const circle = 38 * scale;
  const arrowSize = 13 * scale;

  return (
    <View
      collapsable={false}
      style={[styles.container, { width: container, height: container }]}
    >
      {/* Seta de sentido — fica no topo do marcador; a rotação do <Marker> pai
          gira tudo junto, então a ponta passa a apontar para onde o veículo
          está se movendo (heading do GPS). */}
      <View
        style={[
          styles.arrow,
          {
            borderLeftWidth: arrowSize * 0.7,
            borderRightWidth: arrowSize * 0.7,
            borderBottomWidth: arrowSize,
            borderBottomColor: colors.accent,
            top: -2 * scale,
          },
        ]}
      />
      <View
        style={[
          styles.shadow,
          { width: shadow, height: shadow, borderRadius: shadow / 2, top: 8 * scale },
        ]}
      />
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
        <Text style={[styles.emoji, { fontSize: 20 * scale, lineHeight: 24 * scale }]}>
          🚙
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  shadow: {
    position: 'absolute',
    backgroundColor: 'rgba(0,0,0,0.18)',
  },
  arrow: {
    position: 'absolute',
    width: 0,
    height: 0,
    backgroundColor: 'transparent',
    borderStyle: 'solid',
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    zIndex: 1,
  },
  circle: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: {
    textAlign: 'center',
  },
});
