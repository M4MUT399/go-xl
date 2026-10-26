import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

/**
 * Marcador do PASSAGEIRO no mapa até o embarque — ponto azul com halo e o nome
 * embaixo, como no app da Uber (print de referência do Edson, 26/10/2026).
 *
 * Feito só com View/Text, sem SVG: o <Marker> do Android rasteriza a view num
 * bitmap, e um container compacto com o desenho ocupando quase tudo é o que
 * evita o marcador sumir (ver as lições em CarMarker.tsx).
 */
export function PassengerMarker({ label }: { label?: string | null }) {
  return (
    <View style={styles.wrap}>
      <View style={styles.halo}>
        <View style={styles.dot}>
          <View style={styles.head} />
          <View style={styles.body} />
        </View>
      </View>
      {label ? (
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
      ) : null}
    </View>
  );
}

const BLUE = '#1E7BE6';

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', width: 110 },
  halo: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: 'rgba(30,123,230,0.22)',
    borderWidth: 1,
    borderColor: 'rgba(30,123,230,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: BLUE,
    borderWidth: 2,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  head: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#FFFFFF', marginTop: 2 },
  body: { width: 14, height: 7, borderTopLeftRadius: 7, borderTopRightRadius: 7, backgroundColor: '#FFFFFF', marginTop: 1 },
  label: {
    marginTop: 2,
    fontSize: 13,
    fontWeight: '700',
    color: BLUE,
    textShadowColor: '#FFFFFF',
    textShadowRadius: 3,
    textShadowOffset: { width: 0, height: 0 },
  },
});
