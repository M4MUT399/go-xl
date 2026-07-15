// nav/courseUp — orientação "course-up" (mapa gira, carro fixo apontando pra
// cima), estilo Waze/Google Maps Navigation. Lógica PURA (sem mapa/React) para
// poder testar o congelamento parado, o filtro passa-baixa e o desenrolar do
// ângulo em teste unitário.
//
// Regras (Bloco 3):
//   1. Usa o curso do GPS SÓ acima de `minMovingKmh` (default 4 km/h); abaixo
//      disso o curso é ruído → CONGELA a última rotação válida (não gira no
//      semáforo, não pisca).
//   2. Rotação SUAVE: acumula o rumo de forma CONTÍNUA (desenrolada) para girar
//      sempre pelo caminho angular mais curto (359°→1° = +2°, nunca -358°) e
//      aplica um filtro passa-baixa (lerp por `smoothingAlpha`) para matar o
//      jitter entre fixes — sem saltos de 180°.
//   3. Câmera ancorada a ~`anchorFromBottom` do rodapé (carro no terço inferior,
//      via ~mais possível) e `pitch` configurável (perspectiva de navegação).

import { normalizeDeg, shortestAngleDelta } from './geo';

export interface CourseUpConfig {
  /** Abaixo desta velocidade (km/h) o curso é ruído → congela a rotação. */
  minMovingKmh: number;
  /** Fator do filtro passa-baixa por fix (0..1). Menor = mais suave/lento. */
  smoothingAlpha: number;
  /** Inclinação da câmera (graus) — perspectiva de navegação. */
  pitch: number;
  /** Âncora do carro medida a partir do rodapé (0..1). 0.33 = terço inferior. */
  anchorFromBottom: number;
}

export const DEFAULT_COURSE_UP: CourseUpConfig = {
  minMovingKmh: 4,
  smoothingAlpha: 0.25,
  pitch: 45,
  anchorFromBottom: 0.33,
};

const KMH_PER_MPS = 3.6;

/**
 * true se o curso do GPS deve orientar o mapa neste fix: movendo acima do
 * limiar E com curso válido (≥ 0). Abaixo do limiar ou curso inválido → false
 * (o chamador congela a rotação anterior).
 */
export function shouldUpdateHeading(
  speedMps: number | null | undefined,
  course: number | null | undefined,
  cfg: CourseUpConfig = DEFAULT_COURSE_UP,
): boolean {
  const kmh = Math.max(0, (speedMps ?? 0) * KMH_PER_MPS);
  const validCourse = course != null && Number.isFinite(course) && course >= 0;
  return kmh >= cfg.minMovingKmh && validCourse;
}

/** Estado do rumo contínuo (desenrolado + suavizado) mantido entre fixes. */
export interface HeadingState {
  /** Último curso CRU aceito (graus normalizados) — base para desenrolar. */
  lastRawCourse: number | null;
  /** Rumo contínuo desenrolado (pode passar de 360/−360). */
  continuous: number;
  /** Rumo suavizado (passa-baixa) efetivamente enviado à câmera. */
  smoothed: number;
}

export const initialHeadingState: HeadingState = {
  lastRawCourse: null,
  continuous: 0,
  smoothed: 0,
};

/**
 * Avança o rumo a partir de um novo fix.
 *   - Se NÃO deve atualizar (parado/curso inválido): retorna o estado inalterado
 *     (rotação CONGELADA no último válido).
 *   - Se deve: desenrola o curso (caminho mais curto) e aplica o passa-baixa.
 * `smoothed` é o valor a mandar pra câmera; `continuous`/`lastRawCourse` são a
 * memória para o próximo passo.
 */
export function advanceHeading(
  state: HeadingState,
  speedMps: number | null | undefined,
  course: number | null | undefined,
  cfg: CourseUpConfig = DEFAULT_COURSE_UP,
): HeadingState {
  if (!shouldUpdateHeading(speedMps, course, cfg)) return state;
  const raw = normalizeDeg(course as number);
  // Primeiro fix válido: crava (sem lerp a partir de um zero artificial).
  if (state.lastRawCourse == null) {
    return { lastRawCourse: raw, continuous: raw, smoothed: raw };
  }
  const continuous = state.continuous + shortestAngleDelta(state.lastRawCourse, raw);
  const alpha = Math.min(1, Math.max(0, cfg.smoothingAlpha));
  const smoothed = state.smoothed + alpha * (continuous - state.smoothed);
  return { lastRawCourse: raw, continuous, smoothed };
}

/**
 * Padding superior (px) para ancorar o carro a ~`anchorFromBottom` do rodapé.
 * Um padding no topo empurra o centro do mapa pra baixo, colocando o carro no
 * terço inferior e deixando a via à frente ocupar a tela. Convertendo: se o
 * carro deve ficar a `anchorFromBottom` do rodapé (ex.: 0.33), ele fica a
 * (1 - anchorFromBottom) do topo → o padding-top que centra ali é
 * screenH * (1 - 2*anchorFromBottom), limitado a ≥ 0.
 */
export function topPaddingForAnchor(screenH: number, cfg: CourseUpConfig = DEFAULT_COURSE_UP): number {
  return Math.max(0, Math.round(screenH * (1 - 2 * cfg.anchorFromBottom)));
}
