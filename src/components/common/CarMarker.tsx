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
 * Lições aprendidas (Android):
 *   - O <Marker> no Android rasteriza a view-filha num BITMAP. Se o container
 *     for grande com o círculo pequeno no meio (muita área transparente), o
 *     círculo "some"/fica minúsculo. Por isso o container é MODESTO (~74) e o
 *     círculo OCUPA a maior parte dele (mesma proporção do original que já
 *     funcionava), ficando idêntico ao iOS.
 *   - Nada desenhado pode passar das bordas do container, senão o Android
 *     recorta. A seta é compacta e encostada no círculo (base levemente por
 *     baixo) para o ápice, em QUALQUER rotação, caber com folga.
 *   - Só a SETA gira (logo sempre em pé). A rotação fica numa única camada
 *     (sem camadas full-fill aninhadas, que faziam o marcador sumir no Android).
 *
 * `scale`   aumenta/reduz tudo proporcionalmente (1 = padrão).
 * `heading` em graus (0 = norte, 90 = leste…).
 */
export function CarMarker({ scale = 1, heading = 0 }: { scale?: number; heading?: number }) {
  const { colors } = useTheme();
  const s = scale;

  const container = 74 * s;
  const center = container / 2;
  const circle = 44 * s;          // círculo grande e prominente (igual ao iOS)
  const circleBorder = 3 * s;
  const shadow = 42 * s;

  // Seta (chevron em camadas). apexY = distância do ápice ao centro; mantida
  // curta para o desenho caber no container em qualquer rotação.
  const apexY = 33 * s;
  const aW = 9 * s,  aH = 12 * s;   // triângulo accent (principal)
  const oW = 11.5 * s, oH = 15 * s; // contorno branco + sombra (um pouco maiores)
  const kW = 3.5 * s, kH = 5 * s;   // ápice escuro (dá volume/premium)

  // `top`/`left` absolutos centralizam cada triângulo sem camadas aninhadas.
  const tri = (bw: number, bh: number, color: string, top: number) => (
    <View
      style={{
        position: 'absolute',
        top,
        left: center - bw,
        width: 0,
        height: 0,
        borderStyle: 'solid',
        borderLeftWidth: bw,
        borderRightWidth: bw,
        borderBottomWidth: bh,
        borderLeftColor: 'transparent',
        borderRightColor: 'transparent',
        borderBottomColor: color,
      }}
    />
  );

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
            { width: shadow, height: shadow, borderRadius: shadow / 2, transform: [{ translateY: 4 * s }] },
          ]}
        />
      </View>

      {/* círculo + LOGO — NÃO gira, logo sempre legível */}
      <View collapsable={false} style={styles.layer} pointerEvents="none">
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

      {/* seta de sentido — só ela gira conforme o heading do GPS */}
      <View
        style={[styles.layer, { transform: [{ rotate: `${heading}deg` }] }]}
        pointerEvents="none"
      >
        {/* sombra da seta (atrás, deslocada p/ baixo) */}
        {tri(oW, oH, 'rgba(0,0,0,0.22)', center - apexY + 2 * s)}
        {/* contorno branco — legibilidade sobre qualquer cor de mapa */}
        {tri(oW, oH, '#ffffff', center - apexY)}
        {/* preenchimento accent (dourado), ápice 1.5px abaixo → o branco aparece */}
        {tri(aW, aH, colors.accent, center - apexY + 1.5 * s)}
        {/* ápice escuro — ilusão de espessura/3-D, toque premium */}
        {tri(kW, kH, colors.primary, center - apexY + 1.5 * s)}
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
  // empilhar (overlay) sombra, círculo e a seta rotativa no mesmo centro.
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
