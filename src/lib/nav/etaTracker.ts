// nav/etaTracker — ETA DINÂMICO (Bug B3), núcleo puro e testável.
//
// Problema: hoje o ETA só muda quando a rota é recomputada, e a rota só é
// recomputada quando o motorista anda > 150 m. Parado no trânsito, o número
// CONGELA — o passageiro vê "7 min" por vários minutos. Estilo Uber/Waze, o
// ETA deve DECRESCER com o tempo real entre recálculos e só "respirar" de volta
// quando uma nova rota chega (com trânsito atualizado).
//
// Estratégia (sem depender de React): guardamos uma BASELINE (o ETA em segundos
// no instante em que a rota foi calculada) e, a cada tick, projetamos
// `baselineSeconds - decorrido`. Quando o veículo está PARADO, congelamos o
// decremento (senão o ETA iria a zero sem o carro se mover); quando volta a
// andar, retoma. Uma nova rota simplesmente cria uma baseline nova.
//
// Tudo aqui é DETERMINÍSTICO (recebe `nowMs` por parâmetro) para os testes.

export interface EtaBaseline {
  /** ETA de referência, em segundos, no instante `atMs`. */
  seconds: number;
  /** Epoch (ms) em que essa baseline foi capturada (rota calculada). */
  atMs: number;
}

/**
 * Cria uma baseline a partir do ETA (em minutos) devolvido pela rota. Use
 * sempre que uma NOVA rota/ETA chegar (recálculo ou reroute). `etaMin` nulo →
 * null (sem baseline: o chamador mostra travessão).
 */
export function makeEtaBaseline(etaMin: number | null | undefined, atMs: number): EtaBaseline | null {
  if (etaMin == null || !Number.isFinite(etaMin) || etaMin < 0) return null;
  return { seconds: Math.round(etaMin * 60), atMs };
}

export interface ProjectOptions {
  /** Veículo parado (velocidade ~0): congela o decremento até voltar a andar. */
  stopped?: boolean;
}

/**
 * Projeta o ETA restante em SEGUNDOS a partir da baseline e do relógio.
 *  - andando: max(0, baseline.seconds - (nowMs - baseline.atMs)/1000)
 *  - parado:  mantém baseline.seconds (não decrementa "de graça")
 * Nunca fica negativo. `nowMs` anterior a `atMs` (clock skew) → baseline cheia.
 */
export function projectEtaSeconds(
  baseline: EtaBaseline | null,
  nowMs: number,
  opts: ProjectOptions = {},
): number | null {
  if (!baseline) return null;
  if (opts.stopped) return Math.max(0, baseline.seconds);
  const elapsedSec = Math.max(0, (nowMs - baseline.atMs) / 1000);
  return Math.max(0, baseline.seconds - elapsedSec);
}

/**
 * Converte segundos de ETA para MINUTOS de exibição (mínimo 1 enquanto houver
 * qualquer tempo restante; 0 só quando chega de fato a zero). Ex.: 61 s → 2,
 * 1 s → 1, 0 s → 0.
 */
export function etaSecondsToMinutes(seconds: number | null): number | null {
  if (seconds == null) return null;
  if (seconds <= 0) return 0;
  return Math.max(1, Math.ceil(seconds / 60));
}

/**
 * Horário de chegada previsto = agora + ETA restante. Retorna null sem ETA.
 * O componente formata (ex.: "14:37").
 */
export function arrivalDate(nowMs: number, etaSeconds: number | null): Date | null {
  if (etaSeconds == null) return null;
  return new Date(nowMs + etaSeconds * 1000);
}
