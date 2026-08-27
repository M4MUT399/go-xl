import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Image, StyleSheet, View, useWindowDimensions, AccessibilityInfo } from 'react-native';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withTiming,
  cancelAnimation,
} from 'react-native-reanimated';
import { PISO_MS, TETO_MS, SAIDA_MS } from '../lib/splashTimeline';

/**
 * BrandSplash — a abertura de marca, entre o splash nativo e o app.
 *
 * ── DE ONDE VEM A ARTE ─────────────────────────────────────────────────────
 *
 * As três peças de `assets/brand/` são RECORTES do ativo oficial
 * (`assets/feature-graphic.png`), com o navy virado em alfa. Nada aqui é
 * lettering redesenhado: a marca que aparece na abertura é a mesma que vai à
 * Play Store. As proporções e os respiros entre as peças são os do arquivo
 * original, medidos em pixel, e não valores escolhidos no olho.
 *
 * ── POR QUE O FUNDO É #1A1A2E, E NÃO UM AZUL NOVO ──────────────────────────
 *
 * É o `primary` do tema (src/constants/theme.ts) e o `backgroundColor` do
 * splash nativo em app.config.js. Os três sendo a mesma cor, a passagem
 * splash nativo → abertura → app não pisca em momento nenhum: o navy nunca
 * sai da tela, só o que está em cima dele muda.
 *
 * ── A REGRA DE SAÍDA MORA FORA DAQUI ───────────────────────────────────────
 *
 * `src/lib/splashTimeline.ts` decide QUANDO sair, e é testado. Este arquivo
 * só desenha. A separação existe porque a regra de saída é a única parte com
 * consequência real — ela pode prender o usuário na porta do app.
 *
 * ── DEFENSIVO DE PROPÓSITO ─────────────────────────────────────────────────
 *
 * Esta é a tela de maior alcance do app: todo mundo passa por ela, sempre. Por
 * isso há um temporizador absoluto que a dispensa mesmo se `pronto` nunca
 * chegar, e `onDone` é protegido para não ser chamado duas vezes.
 */

// As peças e a geometria vêm do BrandLockup, que é também quem desenha a marca
// parada na tela de boas-vindas. Ter uma fonte só impede que as duas telas
// mostrem marcas ligeiramente diferentes — elas nunca aparecem juntas, então
// ninguém notaria a divergência.
import { GX, GOXL, TAG, medidasLockup } from './BrandLockup';

/** Amostrado do próprio ativo. Igual ao tema e ao splash nativo. */
const NAVY = '#1A1A2E';

/** A curva única da peça. Nada quica, nada gira, nada passa do alvo. */
const CURVA = Easing.bezier(0.22, 1, 0.36, 1);

type Props = {
  /** O app terminou de resolver o que precisava (auth). */
  pronto: boolean;
  /** Chamado uma única vez, quando a abertura já saiu de cena. */
  onDone: () => void;
  /**
   * `false` roda os 8 s inteiros mesmo com o app pronto antes. O padrão é
   * antecipar: numa abertura morna o app fica pronto em menos de 1 s, e
   * segurar o usuário por mais sete para exibir animação é pedágio.
   */
  antecipar?: boolean;
  /**
   * Disparado no PRIMEIRO layout, ou seja, quando esta tela de fato existe em
   * pixels. É o gancho para esconder o splash NATIVO.
   *
   * A ordem importa e é sutil: se a coreografia começasse na montagem, ela
   * rodaria enquanto o splash nativo ainda cobre tudo, e o usuário pegaria a
   * animação no meio. Por isso o relógio só parte daqui.
   */
  onVisivel?: () => void;
};

export function BrandSplash({ pronto, onDone, antecipar = true, onVisivel }: Props) {
  const { width, height } = useWindowDimensions();

  // O lockup ocupa 62% da largura, com teto para não estourar em tablet.
  const larguraBase = Math.min(width * 0.62, 300);
  const { gxW, gxH, goxlW, goxlH, tagW, tagH, respiroMarca, respiroAssinatura } =
    medidasLockup(larguraBase);

  const entradaMarca = useSharedValue(0);
  const brilho = useSharedValue(0);
  const lettering = useSharedValue(0);
  const assinatura = useSharedValue(0);
  const respiracao = useSharedValue(0);
  const barra = useSharedValue(0);
  const saida = useSharedValue(0);

  const [reduzirMovimento, setReduzirMovimento] = useState(false);

  // `onDone` só pode acontecer uma vez: ele desmonta a abertura, e chamar duas
  // vezes durante a saída deixaria o app tentando remover algo que já saiu.
  const jaSaiu = useRef(false);
  const encerrar = useCallback(() => {
    if (jaSaiu.current) return;
    jaSaiu.current = true;
    onDone();
  }, [onDone]);

  // Quem pediu menos movimento no sistema recebe o lockup montado, sem a
  // coreografia. A abertura continua existindo — só não se mexe.
  useEffect(() => {
    let vivo = true;
    AccessibilityInfo.isReduceMotionEnabled()
      .then((v) => { if (vivo) setReduzirMovimento(!!v); })
      .catch(() => {});
    return () => { vivo = false; };
  }, []);

  // O relógio da peça. Só corre depois do primeiro layout — ver `onVisivel`.
  const [iniciado, setIniciado] = useState(false);
  const montadoEm = useRef(0);
  const primeiroLayout = useRef(false);

  const aoLayout = useCallback(() => {
    if (primeiroLayout.current) return;
    primeiroLayout.current = true;
    montadoEm.current = Date.now();
    setIniciado(true);
    onVisivel?.();
  }, [onVisivel]);

  // ── A coreografia ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!iniciado) return;
    if (reduzirMovimento) {
      entradaMarca.value = 1;
      lettering.value = 1;
      assinatura.value = 1;
      barra.value = withTiming(1, { duration: TETO_MS, easing: Easing.linear });
      return;
    }

    entradaMarca.value = withDelay(450, withTiming(1, { duration: 1100, easing: CURVA }));
    brilho.value = withDelay(1250, withTiming(1, { duration: 900, easing: Easing.linear }));
    lettering.value = withDelay(1750, withTiming(1, { duration: 1000, easing: CURVA }));
    assinatura.value = withDelay(2550, withTiming(1, { duration: 900, easing: CURVA }));
    respiracao.value = withDelay(
      PISO_MS,
      withTiming(1, { duration: TETO_MS - PISO_MS, easing: Easing.inOut(Easing.quad) }),
    );
    barra.value = withTiming(1, { duration: TETO_MS, easing: Easing.linear });
  }, [iniciado, reduzirMovimento, entradaMarca, brilho, lettering, assinatura, respiracao, barra]);

  // ── A saída ──────────────────────────────────────────────────────────────
  // Duas fontes independentes podem dispará-la, e a primeira que chegar vence:
  // o app ficar pronto depois do piso, ou o teto estourar. O segundo caminho é
  // o que garante que TODO mundo entra no app, mesmo com auth pendurado.
  const saindo = useRef(false);

  const dispararSaida = useCallback(() => {
    if (saindo.current) return;
    saindo.current = true;
    saida.value = withTiming(1, { duration: SAIDA_MS, easing: CURVA }, (fim) => {
      if (fim) runOnJS(encerrar)();
    });
  }, [saida, encerrar]);

  useEffect(() => {
    if (!iniciado || !antecipar || !pronto) return;
    const espera = Math.max(0, PISO_MS - (Date.now() - montadoEm.current));
    const id = setTimeout(dispararSaida, espera);
    return () => clearTimeout(id);
  }, [iniciado, pronto, antecipar, dispararSaida]);

  useEffect(() => {
    if (!iniciado) return;
    const espera = Math.max(0, TETO_MS - (Date.now() - montadoEm.current));
    const id = setTimeout(dispararSaida, espera);
    return () => clearTimeout(id);
  }, [iniciado, dispararSaida]);

  // Rede final: se a animação de saída não completar (Reanimated pausado em
  // background, quadro perdido), ninguém fica preso na abertura.
  useEffect(() => {
    if (!iniciado) return;
    const id = setTimeout(encerrar, TETO_MS + SAIDA_MS + 1500);
    return () => clearTimeout(id);
  }, [iniciado, encerrar]);

  useEffect(() => () => {
    cancelAnimation(entradaMarca); cancelAnimation(brilho);
    cancelAnimation(lettering); cancelAnimation(assinatura);
    cancelAnimation(respiracao); cancelAnimation(barra); cancelAnimation(saida);
  }, [entradaMarca, brilho, lettering, assinatura, respiracao, barra, saida]);

  // ── Estilos animados ─────────────────────────────────────────────────────
  const estiloLockup = useAnimatedStyle(() => ({
    opacity: 1 - saida.value,
    transform: [
      { translateY: -10 * saida.value },
      { scale: 1 + 0.006 * respiracao.value },
    ],
  }));

  const estiloMarca = useAnimatedStyle(() => ({
    opacity: entradaMarca.value,
    transform: [{ scale: 0.94 + 0.06 * entradaMarca.value }],
  }));

  // A fresta que varre o dourado. Ela anda de fora a fora da caixa do GX, e a
  // cópia branca lá dentro anda ao contrário — assim o brilho fica REGISTRADO
  // com o logo em vez de deslizar por cima dele.
  const larguraFresta = gxW * 0.38;
  const estiloFresta = useAnimatedStyle(() => {
    const p = brilho.value;
    const x = -larguraFresta + p * (gxW + larguraFresta);
    return {
      opacity: p > 0 && p < 1 ? Math.sin(p * Math.PI) * 0.45 : 0,
      transform: [{ translateX: x }],
    };
  });
  const estiloCopiaBranca = useAnimatedStyle(() => {
    const p = brilho.value;
    const x = -larguraFresta + p * (gxW + larguraFresta);
    return { transform: [{ translateX: -x }] };
  });

  const estiloLettering = useAnimatedStyle(() => ({
    opacity: lettering.value > 0 ? 1 : 0,
    // Sem clip-path no React Native: a revelação vem da largura da janela que
    // contém o lettering, com ele ancorado à esquerda para não escorregar.
    width: goxlW * lettering.value,
    transform: [{ translateY: 10 * (1 - lettering.value) }],
  }));

  const estiloAssinatura = useAnimatedStyle(() => ({
    opacity: assinatura.value,
    transform: [{ scaleX: 1.06 - 0.06 * assinatura.value }],
  }));

  const estiloBarra = useAnimatedStyle(() => ({
    opacity: (barra.value > 0.125 ? 1 : barra.value / 0.125) * (1 - saida.value),
  }));
  const estiloBarraFill = useAnimatedStyle(() => ({ width: `${barra.value * 100}%` }));

  return (
    <View
      style={[styles.tela, { width, height }]}
      pointerEvents="none"
      accessible={false}
      onLayout={aoLayout}
    >
      <Animated.View style={[styles.lockup, estiloLockup]}>
        <Animated.View style={[{ width: gxW, height: gxH, overflow: 'hidden' }, estiloMarca]}>
          <Image source={GX} style={{ width: gxW, height: gxH }} resizeMode="contain" />
          <Animated.View
            style={[
              { position: 'absolute', top: 0, bottom: 0, width: larguraFresta, overflow: 'hidden' },
              estiloFresta,
            ]}
          >
            <Animated.Image
              source={GX}
              resizeMode="contain"
              style={[
                { position: 'absolute', top: 0, width: gxW, height: gxH, tintColor: '#FFFFFF' },
                estiloCopiaBranca,
              ]}
            />
          </Animated.View>
        </Animated.View>

        <View style={{ height: respiroMarca }} />

        <Animated.View style={[{ height: goxlH, overflow: 'hidden' }, estiloLettering]}>
          <Image source={GOXL} style={{ width: goxlW, height: goxlH }} resizeMode="contain" />
        </Animated.View>

        <View style={{ height: respiroAssinatura }} />

        <Animated.Image
          source={TAG}
          resizeMode="contain"
          style={[{ width: tagW, height: tagH }, estiloAssinatura]}
        />
      </Animated.View>

      {/* O fio existe porque a tela cobre um carregamento. Dizer isso é mais
          honesto do que ficar bonito parado. */}
      <Animated.View style={[styles.fio, { width: width * 0.44, bottom: height * 0.1 }, estiloBarra]}>
        <Animated.View style={[styles.fioFill, estiloBarraFill]} />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  tela: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: NAVY,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
    elevation: 9999,
  },
  lockup: { alignItems: 'center' },
  fio: {
    position: 'absolute',
    height: 1.5,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.10)',
    overflow: 'hidden',
  },
  fioFill: { height: '100%', backgroundColor: '#D4A94B' },
});
