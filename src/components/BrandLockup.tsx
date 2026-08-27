import React from 'react';
import { Image, View, StyleSheet } from 'react-native';

/**
 * BrandLockup — a marca completa: GX, lettering GOXL e a assinatura
 * "Premium Ride-Hailing".
 *
 * ── POR QUE ISTO EXISTE COMO COMPONENTE ────────────────────────────────────
 *
 * O lockup aparece em dois lugares que precisam ser IDÊNTICOS: a abertura
 * animada (BrandSplash) e a tela de boas-vindas. Se cada tela montasse as três
 * peças por conta própria, bastaria alguém ajustar um respiro num lugar para as
 * duas telas mostrarem marcas ligeiramente diferentes — e ninguém notaria,
 * porque nunca aparecem juntas.
 *
 * As proporções ficam aqui, exportadas. A abertura importa `medidasLockup`
 * para animar peça por peça; quem só quer a marca parada usa o componente.
 *
 * ── AS MEDIDAS NÃO SÃO ESCOLHIDAS, SÃO MEDIDAS ─────────────────────────────
 *
 * Os três PNGs de `assets/brand/` são recortes de `assets/feature-graphic.png`,
 * o ativo oficial. Os tamanhos e os dois respiros abaixo foram medidos em pixel
 * naquele arquivo, não ajustados no olho. Trocar os PNGs sem refazer a medição
 * desalinha o conjunto.
 */

export const GX = require('../../assets/brand/gx.png');
export const GOXL = require('../../assets/brand/goxl.png');
export const TAG = require('../../assets/brand/tag.png');

/** Dimensões reais dos recortes, em pixels do ativo. */
export const GX_W = 224, GX_H = 117;
export const GOXL_W = 292, GOXL_H = 80;
export const TAG_W = 258, TAG_H = 36;

/** Respiros medidos no ativo: 27 px marca→lettering, 17 px lettering→assinatura. */
export const RESPIRO_MARCA = 27 / GOXL_W;
export const RESPIRO_ASSINATURA = 17 / GOXL_W;

export type MedidasLockup = {
  gxW: number; gxH: number;
  goxlW: number; goxlH: number;
  tagW: number; tagH: number;
  respiroMarca: number;
  respiroAssinatura: number;
  alturaTotal: number;
};

/**
 * Todas as medidas do lockup a partir da largura do LETTERING (a peça mais
 * larga, que é o que define a presença da marca na tela).
 */
export function medidasLockup(larguraBase: number): MedidasLockup {
  const gxW = larguraBase * (GX_W / GOXL_W);
  const goxlW = larguraBase;
  const tagW = larguraBase * (TAG_W / GOXL_W);
  const respiroMarca = larguraBase * RESPIRO_MARCA;
  const respiroAssinatura = larguraBase * RESPIRO_ASSINATURA;

  const gxH = gxW * (GX_H / GX_W);
  const goxlH = goxlW * (GOXL_H / GOXL_W);
  const tagH = tagW * (TAG_H / TAG_W);

  return {
    gxW, gxH, goxlW, goxlH, tagW, tagH,
    respiroMarca, respiroAssinatura,
    alturaTotal: gxH + respiroMarca + goxlH + respiroAssinatura + tagH,
  };
}

type Props = {
  /** Largura do lettering GOXL. As demais peças derivam dela. */
  largura: number;
};

/** A marca completa, parada. Para a versão animada, ver BrandSplash. */
export function BrandLockup({ largura }: Props) {
  const m = medidasLockup(largura);
  return (
    <View style={styles.lockup} accessible accessibilityRole="image" accessibilityLabel="GOXL — Premium Ride-Hailing">
      <Image source={GX} style={{ width: m.gxW, height: m.gxH }} resizeMode="contain" />
      <View style={{ height: m.respiroMarca }} />
      <Image source={GOXL} style={{ width: m.goxlW, height: m.goxlH }} resizeMode="contain" />
      <View style={{ height: m.respiroAssinatura }} />
      <Image source={TAG} style={{ width: m.tagW, height: m.tagH }} resizeMode="contain" />
    </View>
  );
}

const styles = StyleSheet.create({
  lockup: { alignItems: 'center' },
});
