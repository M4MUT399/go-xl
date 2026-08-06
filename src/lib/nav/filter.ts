// nav/filter — limpeza do sinal de GPS antes de qualquer uso na navegação:
//   1) descarte de leituras ruins (accuracy alta ou timestamp fora de ordem);
//   2) filtro de Kalman sobre lat/lng para suavizar o ruído (fim do tremor);
//   3) low-pass simples para grandezas escalares (ex.: velocidade).
//
// Puro e determinístico → testável sem GPS real.

/** Acima disso a leitura é ruidosa demais para navegação e é descartada. */
export const MAX_ACCURACY_M = 25;

export interface FixQuality {
  /** Raio de incerteza em metros informado pelo dispositivo (undefined = desconhecido). */
  accuracy?: number;
  /** Timestamp do fix, em ms. */
  timestampMs: number;
}

/**
 * Uma leitura de GPS é aceitável quando:
 *   - a precisão é conhecida e ≤ MAX_ACCURACY_M (ou desconhecida — não punimos
 *     dispositivos que não reportam accuracy); e
 *   - o timestamp é ESTRITAMENTE mais novo que o último aceito (descarta fixes
 *     fora de ordem/duplicados que o SO às vezes entrega).
 */
export function isAcceptableFix(fix: FixQuality, lastTimestampMs: number | null): boolean {
  if (fix.accuracy != null && fix.accuracy > MAX_ACCURACY_M) return false;
  if (lastTimestampMs != null && fix.timestampMs <= lastTimestampMs) return false;
  return true;
}

/**
 * Filtro de Kalman de posição — modelo de "posição constante" com ruído de
 * processo dirigido pelo tempo (o veículo pode ter se movido entre fixes) e
 * ruído de medição dado pela `accuracy` do próprio GPS.
 *
 * Baseado no filtro geográfico clássico de 1 estado por eixo compartilhando a
 * mesma variância (lat/lng) — barato e estável. Enquanto a incerteza acumula
 * (parado, boa recepção), o ganho cai e o ponto para de tremer; quando chega
 * um fix após um tempo, a variância cresce e o filtro volta a confiar na
 * medição, então não "arrasta".
 */
export class GeoKalman {
  private lat = 0;
  private lng = 0;
  /** Variância da estimativa em metros². < 0 = ainda não inicializado. */
  private variance = -1;
  private timestampMs = 0;

  /**
   * @param processNoiseMps Ruído de processo em m/s (quanto o alvo pode se
   *   mover por segundo de forma imprevisível). Maior = segue mais rápido,
   *   suaviza menos. ~3 m/s é um bom padrão para trânsito urbano.
   */
  constructor(private readonly processNoiseMps: number = 3) {}

  /** Reinicia o filtro num ponto conhecido (ex.: primeiro fix ou re-rota). */
  reset(lat: number, lng: number, accuracy: number, timestampMs: number): void {
    this.lat = lat;
    this.lng = lng;
    this.variance = Math.max(1, accuracy) ** 2;
    this.timestampMs = timestampMs;
  }

  /** Variância atual (m²) — exposta para inspeção/testes. */
  getVariance(): number {
    return this.variance;
  }

  /**
   * Processa uma nova medição e devolve a posição suavizada.
   * A primeira chamada inicializa o filtro e retorna a própria medição.
   */
  process(lat: number, lng: number, accuracy: number, timestampMs: number): { lat: number; lng: number } {
    const acc = Math.max(1, accuracy); // evita ganho = 1 exato / divisão por ~0

    if (this.variance < 0) {
      this.reset(lat, lng, acc, timestampMs);
      return { lat: this.lat, lng: this.lng };
    }

    // Predição: a incerteza cresce com o tempo decorrido desde o último fix.
    const dtSec = (timestampMs - this.timestampMs) / 1000;
    if (dtSec > 0) {
      this.variance += dtSec * this.processNoiseMps * this.processNoiseMps;
      this.timestampMs = timestampMs;
    }

    // Atualização: ganho de Kalman e correção rumo à medição.
    const gain = this.variance / (this.variance + acc * acc); // (0,1)
    this.lat += gain * (lat - this.lat);
    this.lng += gain * (lng - this.lng);
    this.variance = (1 - gain) * this.variance;

    return { lat: this.lat, lng: this.lng };
  }
}

/**
 * Low-pass exponencial para escalares (ex.: suavizar velocidade). `alpha` em
 * [0,1]: 0 = imóvel, 1 = sem suavização. Retorna `next` quando não há valor
 * anterior.
 */
export function lowPass(prev: number | null | undefined, next: number, alpha: number): number {
  if (prev == null) return next;
  const a = Math.max(0, Math.min(1, alpha));
  return prev + a * (next - prev);
}
