import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Colors } from '../../constants/colors';

/**
 * Marcador de carro para react-native-maps.
 * Usa layout plano (sem position:absolute) para garantir
 * renderização correta dentro de <Marker> em iOS e Android.
 *
 * `scale` reduz/aumenta proporcionalmente o ícone (1 = tamanho padrão).
 */
export function CarMarker({ scale = 1 }: { scale?: number }) {
  const container = 46 * scale;
  const shadow = 36 * scale;
  const circle = 38 * scale;

  return (
    <View
      collapsable={false}
      style={[styles.container, { width: container, height: container }]}
    >
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
  circle: {
    backgroundColor: Colors.primary,
    borderColor: Colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emoji: {
    textAlign: 'center',
  },
});
