// nav/publishGate — CADÊNCIA de publicação da posição (Feature F4), puro/testável.
//
// O motorista publica a posição em duas tabelas (driver_locations e rides). Até
// aqui o gatilho era SÓ distância (> 30 m). Isso quebra o "movimento fluido" no
// passageiro em dois casos:
//
//   1) TRÂNSITO PARADO / passo a passo: o carro anda < 30 m por vários segundos,
//      então nenhuma publicação sai e o marcador do passageiro CONGELA — mesmo
//      com o motorista se movendo devagar.
//   2) PARADO no embarque: sem heartbeat, a última posição fica "velha"; o
//      passageiro não tem como saber que o dado ainda é atual.
//
// A cadência aqui combina TEMPO + DISTÂNCIA, estilo Uber/Waze:
//   • piso (minIntervalMs): nunca publica mais rápido que isso (anti-flood);
//   • distância (minDistanceM): publica assim que o carro anda o suficiente;
//   • heartbeat (maxIntervalMs): publica de tempos em tempos mesmo parado, para
//     o consumidor saber que o fix é fresco (e o SmoothMarker interpolar/segurar
//     o dead reckoning com base num timestamp recente).
//
// Puro e determinístico (recebe `nowMs` por parâmetro) → testável sem timers/GPS.

import { haversineMeters, type LatLngLite } from './geo';

export interface PublishGateConfig {
  /** Piso entre publicações (ms): nunca publica mais rápido que isso. */
  minIntervalMs: number;
  /** Heartbeat (ms): publica mesmo sem andar, para o dado não "envelhecer". */
  maxIntervalMs: number;
  /** Distância (m) que, sozinha, já autoriza publicar (respeitando o piso). */
  minDistanceM: number;
}

/** Cadência 3–5 s / 25 m, com piso de 1 s. Números estilo Uber para pickup. */
export const DEFAULT_PUBLISH_GATE: PublishGateConfig = {
  minIntervalMs: 1000,
  maxIntervalMs: 4000,
  minDistanceM: 25,
};

// Fase 5b: cadência de publicação com o app em SEGUNDO PLANO. Mais folgada que
// a de primeiro plano (acima) de propósito — em background não há tela para
// mostrar "ao vivo" quadro a quadro, e cada write custa bateria + rádio com o
// processo suspenso/relançado pelo SO. Ainda assim publica com regularidade
// suficiente para o passageiro não perder o motorista de vista por mais de
// ~15 s parado, ou toda vez que ele andar 50 m.
export const DEFAULT_BACKGROUND_PUBLISH_GATE: PublishGateConfig = {
  minIntervalMs: 5000,
  maxIntervalMs: 15000,
  minDistanceM: 50,
};

/** Último ponto publicado + quando. `null` = nada publicado ainda. */
export interface PublishMark {
  lat: number;
  lng: number;
  atMs: number;
}

/**
 * Decide se `next` deve ser publicado agora, dado o último publicado (`last`).
 *
 * Regras (nesta ordem):
 *   • sem `last` (primeiro fix) → publica;
 *   • dentro do piso (`nowMs - last.atMs < minIntervalMs`) → NÃO publica
 *     (anti-flood), mesmo que tenha andado muito;
 *   • andou ≥ `minDistanceM` → publica;
 *   • passou o heartbeat (`≥ maxIntervalMs`) → publica (mesmo parado);
 *   • senão → não publica.
 */
export function shouldPublishFix(
  last: PublishMark | null,
  next: LatLngLite,
  nowMs: number,
  cfg: PublishGateConfig = DEFAULT_PUBLISH_GATE,
): boolean {
  if (!last) return true;
  const elapsed = nowMs - last.atMs;
  if (elapsed < cfg.minIntervalMs) return false;
  if (haversineMeters(last, next) >= cfg.minDistanceM) return true;
  return elapsed >= cfg.maxIntervalMs;
}
