import React from 'react';
import { View, Image, StyleSheet } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Path, Ellipse } from 'react-native-svg';
import { useTheme } from '../../hooks/useTheme';

// Logo GoXL (mesmo asset do app). O PNG tem fundo marinho, que se funde com o
// círculo marinho do marcador — então só o "GX" dourado aparece dentro dele.
const LOGO = require('../../../assets/icon.png');

/**
 * Marcador de motorista para react-native-maps.
 *
 *   ◆   ← seta de sentido em 3D (sombra + degradê dourado com "aresta" clara
 *  (GX)    no centro + contorno branco + brilho). Gira conforme o `heading`.
 *   ○     halo cinza 50% translúcido por trás do badge — dá destaque à
 *          posição do veículo sem competir com a seta.
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
 *   - A logo usa borderRadius PRÓPRIO (além do overflow:hidden do círculo
 *     pai), pois o clipping via View+overflow falha às vezes no Android com
 *     uma <Image> filha maior que o pai (ver comentário abaixo).
 *   - Cada instância usa um id de gradiente único (useId) — vários
 *     marcadores na mesma tela reaproveitando o mesmo id de <LinearGradient>
 *     causam glitch de render no react-native-svg/Android.
 *
 * `scale`   aumenta/reduz tudo proporcionalmente (1 = padrão).
 * `heading` em graus (0 = norte, 90 = leste…).
 */
export function CarMarker({ scale = 1, heading = 0 }: { scale?: number; heading?: number }) {
  const { colors } = useTheme();
  const s = scale;
  const gradId = `carMarkerArrow-${React.useId()}`;

  const container = 74 * s;
  const center = container / 2;
  const circle = 44 * s;          // círculo grande e prominente (igual ao iOS)
  const circleBorder = 3 * s;
  const shadow = 42 * s;
  const halo = 60 * s;            // halo cinza translúcido — destaca a posição do veículo

  // Seta em 3D: chevron com reentrância central (dorso "dobrado", como uma
  // seta de navegação real) preenchido por um degradê vertical — claro no
  // ápice (luz batendo na ponta), escuro na base (sombra própria) — o que
  // cria a ilusão de volume que o triângulo chapado antigo não tinha.
  // apexY = distância do ápice ao centro do marcador.
  const apexY = 33 * s;
  const arrowW = 23 * s;   // largura total da base
  const arrowH = 15 * s;   // altura (ápice → base)
  const notch = 11 * s;    // profundidade da reentrância central (dorso)

  const arrowPath = `M${arrowW / 2},0 L${arrowW},${arrowH} L${arrowW / 2},${notch} L0,${arrowH} Z`;

  // A imagem é propositalmente maior que o círculo (1.15x) para o
  // resizeMode="cover" preencher sem sobras, contando com o overflow:hidden
  // do círculo pai para recortar o excesso. No Android esse recorte via
  // View+overflow:hidden falha às vezes com um <Image> filho maior que o
  // pai (o quadrado da logo aparece por cima, cortando o anel/seta com
  // cantos retos). Por isso a logo também recebe borderRadius PRÓPRIO —
  // clipping nativo do <Image>, confiável nas duas plataformas.
  const logoSize = circle * 1.15;

  return (
    <View
      collapsable={false}
      style={[styles.container, { width: container, height: container }]}
    >
      {/* sombra suave sob o círculo */}
      <View collapsable={false} style={styles.layer} pointerEvents="none">
        <View
          style={[
            styles.circleShadow,
            { width: shadow, height: shadow, borderRadius: shadow / 2, transform: [{ translateY: 4 * s }] },
          ]}
        />
      </View>

      {/* halo cinza 50% translúcido — dá destaque à posição do veículo */}
      <View collapsable={false} style={styles.layer} pointerEvents="none">
        <View
          style={{
            width: halo,
            height: halo,
            borderRadius: halo / 2,
            backgroundColor: colors.gray[500],
            opacity: 0.5,
          }}
        />
      </View>

      {/* círculo + LOGO — NÃO gira, logo sempre legível */}
      <View collapsable={false} style={styles.layer} pointerEvents="none">
        <View
          collapsable={false}
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
            style={{ width: logoSize, height: logoSize, borderRadius: logoSize / 2 }}
            resizeMode="cover"
          />
        </View>
      </View>

      {/* seta de sentido em 3D — só ela gira conforme o heading do GPS */}
      <View
        collapsable={false}
        style={[
          styles.layer,
          { transform: [{ rotate: `${heading}deg` }] },
        ]}
        pointerEvents="none"
      >
        <View
          collapsable={false}
          style={{ position: 'absolute', top: center - apexY, left: center - arrowW / 2, width: arrowW, height: arrowH }}
        >
          <Svg width={arrowW} height={arrowH} viewBox={`0 0 ${arrowW} ${arrowH}`}>
            <Defs>
              <LinearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={colors.accentLight} />
                <Stop offset="0.55" stopColor={colors.accent} />
                <Stop offset="1" stopColor="#8A6A28" />
              </LinearGradient>
            </Defs>
            {/* sombra (atrás, deslocada p/ baixo) — dá profundidade */}
            <Path d={arrowPath} fill="rgba(0,0,0,0.25)" transform={`translate(0, ${1.5 * s})`} />
            {/* corpo com degradê + contorno branco fino p/ legibilidade sobre qualquer mapa */}
            <Path d={arrowPath} fill={`url(#${gradId})`} stroke="#ffffff" strokeWidth={1.3 * s} strokeLinejoin="round" />
            {/* brilho especular perto do ápice — reforça a sensação de volume/3D */}
            <Ellipse cx={arrowW / 2} cy={arrowH * 0.32} rx={arrowW * 0.16} ry={arrowH * 0.22} fill="#ffffff" opacity={0.45} />
          </Svg>
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
  // empilhar (overlay) sombra, halo, círculo e a seta rotativa no mesmo centro.
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
