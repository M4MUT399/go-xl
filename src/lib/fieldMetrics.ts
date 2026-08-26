// fieldMetrics — costura ÚNICA de medição de desempenho em aparelho.
//
// Irmão de errorReporting.ts, e de propósito com a mesma forma: um sink
// plugável e todo contexto passando por scrubPII. Quando existir um destino de
// verdade (Sentry Performance, tabela no Supabase, o que for), é um
// setMetricsSink(...) no bootstrap e nenhum call-site muda.
//
// DIFERENÇA para o errorReporting: aqui o console NÃO é destino automático, é
// um sink explícito (`consoleMetricsSink`, ligado em App.tsx só em dev). Falha
// é rara e merece aparecer sozinha; métrica é contínua, e logar toda amostra
// por padrão despejava ~240 linhas na saída da suíte de testes — ruído que
// enterra justamente o aviso que alguém precisava ler.
//
// O QUE ESTE MÓDULO NÃO FAZ: inventar número. Ele não estima, não interpola e
// não preenche lacuna. Sem aparelho rodando o app, `recentSamples()` volta
// vazio — e vazio é a resposta correta, não zero. A auditoria inteira depende
// de "NÃO MEDIDO" continuar significando não medido.
import { scrubPII } from './mask';
import { reportWarning } from './errorReporting';

/**
 * Nomes fechados em união, não string livre. Métrica com nome digitado errado
 * não some: ela vira uma série paralela silenciosa que ninguém olha, e a
 * ausência de dado passa por "o app está bem". Aqui o erro é de compilação.
 */
export type MetricName =
  /**
   * Do primeiro módulo JS avaliado até a splash sair (app utilizável).
   *
   * NÃO é a partida a frio. Falta tudo que acontece antes do JS existir:
   * spawn do processo, init nativo, carga do bundle no Hermes. Esse pedaço é
   * invisível daqui e só sai de medição nativa — `adb shell am start -W` no
   * Android, os_signpost no iOS. A régua de 2,5 s se aplica ao TOTAL, então
   * esta amostra é um piso, nunca a resposta.
   */
  | 'js_bootstrap_to_interactive'
  /** Ida e volta completa de uma busca de autocomplete, incluindo fallback. */
  | 'autocomplete_round_trip'
  /** Ida e volta do details que fecha a sessão do Places. */
  | 'place_details_round_trip'
  /**
   * Espera completa por uma rota, tentativa da Google e queda no OSRM inclusas.
   *
   * Não existe métrica separada de reroute porque não existe caminho separado:
   * sair da rota mexe na ORIGEM e cai neste mesmo cálculo. O contexto carrega
   * `trigger`, e o reroute é o `origin_change` — a régua de 3 s se lê filtrando
   * por ele durante navegação ativa.
   */
  | 'route_compute'
  /** Intervalo entre dois fixes consecutivos de GPS durante a corrida. */
  | 'location_fix_interval'
  /** Carga da bateria em pontos percentuais (ver setBatteryProvider). */
  | 'battery_level';

export type MetricUnit = 'ms' | 'pct';

export type MetricContext = Record<string, unknown>;

export type MetricSample = {
  name: MetricName;
  value: number;
  unit: MetricUnit;
  /** Wall clock do registro — para ordenar amostras, nunca para medir duração. */
  at: number;
  context?: MetricContext;
};

/** Destino externo das amostras. null → só console. */
export type MetricsSink = (sample: MetricSample) => void;

/** De onde sai a carga da bateria. Ver a nota em setBatteryProvider. */
export type BatteryProvider = () => Promise<number | null>;

const MAX_SAMPLES = 200;

let sink: MetricsSink | null = null;
let batteryProvider: BatteryProvider | null = null;
const samples: MetricSample[] = [];

/**
 * Relógio MONOTÔNICO para durações.
 *
 * `Date.now()` é relógio de parede: um ajuste de NTP ou uma troca de fuso no
 * meio da medição faz a duração encolher, esticar ou ficar negativa. Numa
 * suíte de métricas de campo isso é pior do que não medir, porque o número
 * errado não se anuncia. `performance.now()` não sofre disso; onde ele não
 * existir, caímos no relógio de parede e o resultado passa pela checagem de
 * duração negativa em `finish`.
 */
function monotonicNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === 'function' ? perf.now() : Date.now();
}

/** Registra (ou remove, com null) o destino externo das métricas. */
export function setMetricsSink(fn: MetricsSink | null): void {
  sink = fn;
}

/** Sink pronto que despeja no console — o que aparece no `npx expo start`. */
export const consoleMetricsSink: MetricsSink = (s) => {
  console.log(`[metric] ${s.name} ${s.value}${s.unit}`, s.context ?? '');
};

/**
 * Registra de onde ler a bateria.
 *
 * Fica plugável porque o app NÃO tem `expo-battery` instalado, e acrescentar
 * um módulo nativo obriga a um build novo num app que já está na faixa de
 * teste da Play Store. Enquanto ninguém plugar um provider, `sampleBattery()`
 * não registra nada — de novo: ausência de amostra, não um zero inventado.
 */
export function setBatteryProvider(fn: BatteryProvider | null): void {
  batteryProvider = fn;
}

function emit(name: MetricName, value: number, unit: MetricUnit, context?: MetricContext): void {
  const sample: MetricSample = {
    name,
    value,
    unit,
    at: Date.now(),
    context: context ? scrubPII(context) : undefined,
  };

  samples.push(sample);
  if (samples.length > MAX_SAMPLES) samples.shift();

  if (sink) {
    try {
      sink(sample);
    } catch {
      // Um sink quebrado nunca pode derrubar o app.
    }
  }
}

/** Registra uma medida já pronta. */
export function recordMetric(
  name: MetricName,
  value: number,
  unit: MetricUnit,
  context?: MetricContext
): void {
  if (!Number.isFinite(value)) {
    reportWarning(`métrica ${name} com valor não finito`, { value });
    return;
  }
  emit(name, value, unit, context);
}

/**
 * Abre uma medição de duração. Devolve a função que a fecha e devolve os ms.
 *
 * Chamar a função de fim duas vezes registra duas amostras — de propósito não
 * há trava. Um "já fechado" silencioso esconderia um call-site com dois
 * caminhos de saída, que é justamente o bug que faz a série ficar torta.
 */
export function startTiming(name: MetricName): (context?: MetricContext) => number | null {
  const t0 = monotonicNow();
  return (context?: MetricContext) => {
    const elapsed = monotonicNow() - t0;
    if (elapsed < 0) {
      // Só acontece no fallback de relógio de parede. Não é uma medição, e
      // guardá-la contaminaria a série com um número que ninguém observou.
      reportWarning(`relógio andou para trás durante ${name}`, { elapsed });
      return null;
    }
    emit(name, elapsed, 'ms', context);
    return elapsed;
  };
}

// ─── Partida (o pedaço dela que o JS enxerga) ─────────────────────────────────

let finishBootstrap: ((context?: MetricContext) => number | null) | null = null;

/** Marca o instante mais cedo que o JS alcança. Chamado no topo de index.ts. */
export function markJsBootstrapStart(): void {
  // A primeira chamada vence: uma segunda só poderia atrasar o t0 e encurtar
  // artificialmente a medida.
  if (finishBootstrap) return;
  finishBootstrap = startTiming('js_bootstrap_to_interactive');
}

/**
 * Marca o app utilizável (splash saindo).
 *
 * Disparo ÚNICO. O efeito que chama isto depende de `loading`, que volta a
 * oscilar em troca de sessão e logout — e uma segunda amostra ali não seria
 * partida nenhuma, seria re-autenticação disfarçada de bootstrap.
 */
export function markAppInteractive(context?: MetricContext): void {
  const done = finishBootstrap;
  if (!done) return;
  finishBootstrap = null;
  done(context);
}

/** Lê a bateria pelo provider registrado, se houver, e registra a amostra. */
export async function sampleBattery(context?: MetricContext): Promise<number | null> {
  if (!batteryProvider) return null;
  try {
    const level = await batteryProvider();
    if (level == null || !Number.isFinite(level)) return null;
    emit('battery_level', level, 'pct', context);
    return level;
  } catch (e) {
    reportWarning(e, { metric: 'battery_level' });
    return null;
  }
}

/** Amostras retidas em memória, da mais antiga para a mais nova. */
export function recentSamples(): MetricSample[] {
  return [...samples];
}

/** Descarta as amostras retidas (ex.: ao trocar de usuário/sessão). */
export function clearSamples(): void {
  samples.length = 0;
}
