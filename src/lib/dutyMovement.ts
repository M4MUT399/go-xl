// dutyMovement — máquina de estados PURA da jornada por MOVIMENTO (Bloco 2).
//
// Regra de negócio (compliance, precisão inegociável): o acumulador de jornada
// conta APENAS enquanto o veículo está em movimento e o motorista online.
//   • Parado conta até `toleranceMs` (padrão 10 min) — tolerância de semáforo/
//     embarque; esse tempo entra como trabalhado.
//   • Passando a tolerância, a contagem PAUSA a partir do minuto 10 (os 10 min
//     seguem contados). Flag `toleranceCountsAsWork=false` inverte (não conta a
//     tolerância).
//   • Se o movimento retornar antes de `resetMs` (padrão 6 h) parado, RETOMA do
//     valor pausado.
//   • Parado por mais de `resetMs` ZERA o acumulador (novo ciclo).
//   • OFFLINE conta como DESCANSO: o acumulador também ZERA após `resetMs`
//     contínuo offline (evita o motorista amanhecer preso após a noite toda
//     offline). A política de app usa toleranceMs=0 (só conta em movimento).
//
// Máquina (exata): MOVING →(parou)→ STOPPED_TOLERANCE(0–10min, conta) →(>10min)→
// PAUSED(não conta); STOPPED_TOLERANCE →(movimento)→ MOVING; PAUSED →(mov <6h)→
// MOVING (retoma); PAUSED →(parado >6h)→ RESET(=0).
//
// "Em movimento" (parametrizável): entra MOVING com ≥ `moveOnKmh` (8) sustentado
// por `moveOnSustainMs` (30 s); entra parado com < `moveOnKmh` por
// `moveOffSustainMs` (60 s) — histerese. Perda de GPS ≠ parado → UNKNOWN, que
// CONGELA o estado atual até o sinal voltar.
//
// Robustez: TODO limite é decidido por timestamps epoch UTC PERSISTIDOS, nunca
// por timers em memória — sobrevive a kill/reboot/background/troca de fuso. O
// estado é "banked" (creditado) a cada transição, então reconstruir a partir do
// estado salvo + o horário atual reproduz o mesmo resultado que rodar contínuo.
//
// Isolado de React/RN de propósito: exercitável em teste unitário.

// ─── Configuração (remote-config parametrizável) ─────────────────────────────

export interface DutyMovementConfig {
  /** Velocidade (km/h) do limiar de movimento. */
  moveOnKmh: number;
  /** Tempo (ms) ≥ limiar para CONFIRMAR movimento (entra MOVING). */
  moveOnSustainMs: number;
  /** Tempo (ms) < limiar para CONFIRMAR parada (entra parado). */
  moveOffSustainMs: number;
  /** Tolerância (ms) de parada que ainda conta como trabalhado. */
  toleranceMs: number;
  /** Parado além disto (ms) zera o acumulador (novo ciclo). */
  resetMs: number;
  /** Se a tolerância conta como trabalho (padrão true). */
  toleranceCountsAsWork: boolean;
  /**
   * Validade (ms) de uma leitura de velocidade como PROVA de movimento.
   *
   * `null` = sem validade: a última leitura vale para sempre. É o comportamento
   * histórico e continua sendo o default da lib, para não mudar por baixo dos
   * panos quem já a usa com samples esparsos.
   *
   * ─── POR QUE ISTO EXISTE ────────────────────────────────────────────────
   * A máquina credita trabalho pelo INTERVALO entre samples ("determinística
   * por timestamps"), e o estado só muda quando um sample diz que mudou. Se a
   * fonte de velocidade CONGELA — app minimizado/tela bloqueada, o SO suspende
   * os timers, o GPS para de entregar fix — o próximo sample chega horas depois
   * repetindo a ÚLTIMA velocidade conhecida. Estando em MOVING, essas horas
   * inteiras eram creditadas como jornada, sem uma única prova de que o carro
   * andou. É o "descanso obrigatório" caindo sobre quem não dirigiu.
   *
   * Com um número aqui, o crédito para no horizonte da prova
   * (`speedAtMs + speedMaxAgeMs`) e a leitura vencida passa a valer o mesmo que
   * ausência de leitura: UNKNOWN, que CONGELA — a regra que a lib já escolheu
   * para perda de GPS desde sempre.
   */
  speedMaxAgeMs: number | null;
}

export const DEFAULT_DUTY_MOVEMENT: DutyMovementConfig = {
  moveOnKmh: 8,
  moveOnSustainMs: 30_000,
  moveOffSustainMs: 60_000,
  toleranceMs: 10 * 60_000,
  resetMs: 6 * 60 * 60_000,
  toleranceCountsAsWork: true,
  speedMaxAgeMs: null,
};

const KMH_PER_MPS = 3.6;

// ─── Estados ─────────────────────────────────────────────────────────────────

export type DutyMovementState =
  | 'OFFLINE' // motorista offline — não conta
  | 'MOVING' // em movimento — conta
  | 'STOPPED_TOLERANCE' // parado dentro da tolerância — conta
  | 'PAUSED' // parado além da tolerância — não conta
  | 'UNKNOWN'; // perda de GPS — congelado

/** Um evento de transição, emitido para auditoria no backend. */
export interface DutyTransition {
  from: DutyMovementState;
  to: DutyMovementState;
  atMs: number;
  /** Motivo legível (ex.: 'stopped', 'tolerance_exceeded', 'reset', 'resume'). */
  reason: string;
}

/**
 * Estado PERSISTÍVEL completo (serializa direto em JSON). Contém tanto a máquina
 * de jornada quanto o classificador de movimento (histerese), para reconstruir
 * tudo de uma vez após kill.
 */
export interface DutyMachine {
  state: DutyMovementState;
  /** ms de trabalho já creditados até `since`. */
  workedMs: number;
  /** Epoch (ms) em que `state` foi entrado (e `workedMs` creditado). */
  since: number;
  /** Início (epoch ms) do episódio de parada atual, ou null se em movimento. */
  stopEpisodeStart: number | null;
  // Classificador de movimento (histerese):
  /** Saída debounced: true=movendo, false=parado, null=desconhecido. */
  moving: boolean | null;
  /** Início contínuo acima do limiar (candidato a MOVING), ou null. */
  fastSince: number | null;
  /** Início contínuo abaixo do limiar (candidato a parado), ou null. */
  slowSince: number | null;
  // Congelamento (UNKNOWN):
  /** Estado de jornada anterior ao congelamento, para restaurar. */
  frozenState: DutyMovementState | null;
  /**
   * Epoch (ms) até quando o estado atual tem PROVA de GPS. `null` = sem
   * horizonte (config com `speedMaxAgeMs: null`). Persistido junto: sem isso,
   * um kill com a máquina em MOVING e um boot oito horas depois creditaria as
   * oito horas antes de o primeiro fix chegar.
   */
  evidenceUntil: number | null;
}

export function initialDutyMachine(nowMs: number): DutyMachine {
  return {
    state: 'OFFLINE',
    workedMs: 0,
    since: nowMs,
    stopEpisodeStart: null,
    moving: null,
    fastSince: null,
    slowSince: null,
    frozenState: null,
    evidenceUntil: null,
  };
}

// ─── Crédito de trabalho (banking) ───────────────────────────────────────────

/**
 * Até que instante o estado atual pode creditar trabalho. Sem prova de GPS não
 * se credita minuto nenhum: `evidenceUntil` é o teto, e `atMs` (o agora) o
 * outro. Ver `speedMaxAgeMs`.
 */
function evidenceHorizon(m: DutyMachine, atMs: number): number {
  return m.evidenceUntil == null ? atMs : Math.min(atMs, m.evidenceUntil);
}

/** ms de trabalho acumulados no intervalo [since, atMs] para o estado dado. */
function accrual(m: DutyMachine, atMs: number, cfg: DutyMovementConfig): number {
  const ate = evidenceHorizon(m, atMs);
  switch (m.state) {
    case 'MOVING':
      return Math.max(0, ate - m.since);
    case 'STOPPED_TOLERANCE': {
      if (!cfg.toleranceCountsAsWork) return 0;
      // Conta só até o teto de tolerância desde o início do episódio de parada.
      const stopStart = m.stopEpisodeStart ?? m.since;
      const counted = Math.min(ate, stopStart + cfg.toleranceMs) - m.since;
      return Math.max(0, counted);
    }
    default:
      return 0; // PAUSED / OFFLINE / UNKNOWN não contam
  }
}

/**
 * Minutos de trabalho acumulados AGORA (para exibir/consumir), sem alterar o
 * estado: crédito banked + o que corre no estado atual até `atMs`.
 */
export function workedMinutes(m: DutyMachine, atMs: number, cfg: DutyMovementConfig = DEFAULT_DUTY_MOVEMENT): number {
  return (m.workedMs + accrual(m, atMs, cfg)) / 60_000;
}

// ─── Classificador de movimento (histerese) ──────────────────────────────────

/**
 * Atualiza a decisão debounced de movimento. Velocidade null = perda de GPS →
 * moving=null (o chamador congela). Entra em movimento com ≥ limiar por
 * `moveOnSustainMs`; sai com < limiar por `moveOffSustainMs`.
 */
function classifyMotion(
  m: DutyMachine,
  atMs: number,
  speedMps: number | null | undefined,
  cfg: DutyMovementConfig,
): { moving: boolean | null; fastSince: number | null; slowSince: number | null } {
  if (speedMps == null || !Number.isFinite(speedMps)) {
    return { moving: null, fastSince: null, slowSince: null };
  }
  const kmh = Math.max(0, speedMps * KMH_PER_MPS);
  const fast = kmh >= cfg.moveOnKmh;
  // Base: se estava desconhecido, assume parado como ponto de partida seguro.
  const wasMoving = m.moving === true;
  let { fastSince, slowSince } = m;

  if (!wasMoving) {
    // Candidato a entrar em MOVING: precisa de `fast` sustentado.
    if (fast) {
      fastSince = fastSince ?? atMs;
      if (atMs - fastSince >= cfg.moveOnSustainMs) {
        return { moving: true, fastSince: null, slowSince: null };
      }
      return { moving: false, fastSince, slowSince: null };
    }
    return { moving: false, fastSince: null, slowSince: null };
  } else {
    // Candidato a parar: precisa de `!fast` sustentado.
    if (!fast) {
      slowSince = slowSince ?? atMs;
      if (atMs - slowSince >= cfg.moveOffSustainMs) {
        return { moving: false, fastSince: null, slowSince: null };
      }
      return { moving: true, fastSince: null, slowSince };
    }
    return { moving: true, fastSince: null, slowSince: null };
  }
}

// ─── Redutor principal ───────────────────────────────────────────────────────

export interface DutySample {
  atMs: number;
  /** Velocidade instantânea (m/s); null/undefined = leitura de GPS ausente. */
  speedMps?: number | null;
  /**
   * Epoch (ms) do fix que produziu `speedMps` — NÃO é `atMs`. Ausente/null =
   * "a leitura é deste instante". Só faz diferença com `speedMaxAgeMs` setado:
   * é o que permite a máquina saber que a velocidade que ela recebeu é velha.
   */
  speedAtMs?: number | null;
  /** Motorista online (sessão de serviço aberta). */
  online: boolean;
}

export interface DutyStepResult {
  machine: DutyMachine;
  /**
   * Transições ocorridas neste passo, em ORDEM CRONOLÓGICA (`atMs` crescente),
   * para emitir à trilha de auditoria. Vazio quando nada mudou.
   *
   * É uma LISTA, e não uma transição só, porque um passo pode legitimamente
   * produzir duas: o corte da prova vencida (o buraco, carimbado onde a prova
   * acabou) e a mudança de estado que o sample novo provoca (carimbada agora).
   * Enquanto isto era um campo único, a segunda apagava a primeira — e o caso
   * comum era justamente esse: o app acorda depois de horas com o carro já
   * parado, o passo transita MOVING→STOPPED_TOLERANCE e o buraco de três horas
   * sumia da trilha. A migration 0053 declara essa tabela como o registro
   * imutável de QUANDO cada mudança ocorreu; um `worked_minutes` que anda 1,5
   * min num período MOVING de 3 h, sem uma linha explicando por quê, é
   * exatamente o que ela existe para não deixar acontecer.
   */
  transitions: DutyTransition[];
}

/** Credita a acrual atual e devolve uma cópia com workedMs/since atualizados. */
function bank(m: DutyMachine, atMs: number, cfg: DutyMovementConfig): DutyMachine {
  return { ...m, workedMs: m.workedMs + accrual(m, atMs, cfg), since: atMs };
}

function transitionTo(
  m: DutyMachine,
  to: DutyMovementState,
  atMs: number,
  reason: string,
  cfg: DutyMovementConfig,
  extra: Partial<DutyMachine> = {},
): DutyStepResult {
  const banked = bank(m, atMs, cfg);
  const machine: DutyMachine = { ...banked, state: to, since: atMs, ...extra };
  return { machine, transitions: [{ from: m.state, to, atMs, reason }] };
}

/**
 * Avança a máquina com um novo sample (velocidade + online + horário). Retorna o
 * novo estado persistível e as transições (se houve) para auditoria. Determinístico
 * por timestamps: chamar com o horário atual após um kill reconstrói o resultado.
 */
export function stepDuty(
  prev: DutyMachine,
  sample: DutySample,
  cfg: DutyMovementConfig = DEFAULT_DUTY_MOVEMENT,
): DutyStepResult {
  const { atMs, online } = sample;

  // 1) Offline domina: não conta jornada — e conta como DESCANSO. Marcamos o
  // início do episódio de descanso (stopEpisodeStart) ao entrar offline; depois
  // de `resetMs` contínuo offline o acumulador ZERA (novo turno). Sem isso,
  // ficar offline a noite toda não zerava as horas e o motorista amanhecia
  // preso em "descanso obrigatório".
  if (!online) {
    if (prev.state === 'OFFLINE') {
      const restStart = prev.stopEpisodeStart ?? prev.since;
      if (atMs - restStart >= cfg.resetMs && prev.workedMs !== 0) {
        // Descanso offline suficiente → zera uma única vez (guard workedMs!==0).
        return transitionTo(prev, 'OFFLINE', atMs, 'reset_offline', cfg, {
          workedMs: 0,
          stopEpisodeStart: restStart,
          moving: null,
          fastSince: null,
          slowSince: null,
          frozenState: null,
        });
      }
      return { machine: { ...prev, moving: null, fastSince: null, slowSince: null }, transitions: [] };
    }
    // Vindo de um estado online → entra OFFLINE e inicia o episódio de descanso.
    // O `bank` dentro de `transitionTo` usa o horizonte de prova ANTERIOR (o de
    // `prev`), que é o certo: encerrar o turno não prova nada sobre o intervalo.
    return transitionTo(prev, 'OFFLINE', atMs, 'offline', cfg, {
      stopEpisodeStart: atMs,
      moving: null,
      fastSince: null,
      slowSince: null,
      frozenState: null,
    });
  }

  // 2) CORTE DA PROVA VENCIDA — acontece ANTES de qualquer prova nova entrar.
  const { maquina: atual, transicao: corte } = cortarSemProva(prev, atMs, cfg);
  const passo = stepOnline(atual, sample, cfg);
  // As DUAS saem, nesta ordem — o corte é carimbado onde a prova acabou, sempre
  // antes do sample que provocou o resto. O corte já esteve condicionado a "o
  // passo não transitou", e o caso comum era exatamente o que ele descartava: o
  // app acorda depois de horas com o carro já parado, o passo transita
  // MOVING→STOPPED_TOLERANCE, e o buraco de três horas não chegava à trilha.
  // Sobrava um período MOVING de 3 h com 1,5 min de `worked_minutes` e nenhuma
  // linha dizendo por quê — que é a pergunta que a auditoria vem fazer.
  return { machine: passo.machine, transitions: corte ? [corte, ...passo.transitions] : passo.transitions };
}

/**
 * Fecha o crédito no horizonte da prova ANTERIOR e recomeça a contar em `atMs`.
 *
 * ─── POR QUE ISTO É UM PASSO SEPARADO, E POR QUE VEM PRIMEIRO ────────────────
 * `evidenceUntil` é recalculado a partir do fix NOVO. Se ele entrasse na máquina
 * antes de o intervalo sem prova ser cortado, o horizonte saltaria para
 * `agora + speedMaxAgeMs` enquanto `since` continuaria lá atrás — e `accrual`
 * creditaria o buraco inteiro. É exatamente o caminho do app minimizado, da tela
 * bloqueada e do kill/reboot: o SO suspende os timers, ninguém chama a máquina
 * por horas, e o primeiro fix que chega ao acordar é FRESCO. A prova nova é
 * legítima; o que ela não pode fazer é provar o passado.
 *
 * O corte credita até `horizonte` (onde a última prova valia), joga `since` para
 * `atMs` — o intervalo [horizonte, atMs] não conta como nada — e deixa
 * `evidenceUntil` no passado, para que um passo sem leitura válida logo em
 * seguida também não credite nada.
 *
 * `stopEpisodeStart` sobrevive de propósito: os prazos de parada (tolerância,
 * reset de 6 h) são de RELÓGIO DE PAREDE, não de prova — quem estacionou e
 * minimizou o app por sete horas descansou de verdade e merece o reset.
 *
 * O preço, dito na cara: um trecho realmente dirigido com o app dormindo deixa
 * de ser creditado. Sem fix não há prova, e a máquina erra para o lado de não
 * inventar jornada — que é o defeito relatado (descanso obrigatório caindo sobre
 * quem estava parado). Com o app em primeiro plano os fixes chegam a cada 5 s e
 * o corte nunca dispara.
 */
function cortarSemProva(
  prev: DutyMachine,
  atMs: number,
  cfg: DutyMovementConfig,
): { maquina: DutyMachine; transicao: DutyTransition | null } {
  if (cfg.speedMaxAgeMs == null) return { maquina: prev, transicao: null };
  // Estado gravado por um build ANTERIOR não tem `evidenceUntil`. Contar o teto
  // a partir da entrada no estado atual fecha o mesmo furo para quem atualiza o
  // app com a máquina em MOVING — sem depender de zerar todo mundo em campo.
  const horizonte = prev.evidenceUntil ?? prev.since + cfg.speedMaxAgeMs;
  if (atMs <= horizonte) return { maquina: prev, transicao: null };
  const creditado = bank(prev, horizonte, cfg);
  return {
    maquina: { ...creditado, since: atMs, evidenceUntil: horizonte },
    // O evento marca um BURACO NO REGISTRO DE JORNADA — só existe se havia
    // jornada correndo. Sem esta condição, uma máquina já congelada satisfaria o
    // corte a cada tick de 60 s (o horizonte fica no passado até um fix válido
    // chegar) e o app inseriria uma linha por minuto na trilha de auditoria
    // durante toda a madrugada em que o motorista esqueceu o app aberto.
    transicao:
      creditado.workedMs !== prev.workedMs
        ? { from: prev.state, to: prev.state, atMs: horizonte, reason: 'evidence_gap' }
        : null,
  };
}

/** O passo propriamente dito, já com o intervalo sem prova cortado e online. */
function stepOnline(
  prev: DutyMachine,
  sample: DutySample,
  cfg: DutyMovementConfig,
): DutyStepResult {
  const { atMs } = sample;

  // Horizonte de PROVA. `speedAtMs` é quando a velocidade foi MEDIDA; `atMs` é
  // quando estamos avaliando. Os dois só coincidem enquanto os fixes chegam.
  // Passado `speedMaxAgeMs`, a leitura vence: vira ausência de leitura (o mesmo
  // que perda de GPS → UNKNOWN, congela).
  const speedAtMs = sample.speedAtMs ?? atMs;
  const vencida = cfg.speedMaxAgeMs != null && atMs - speedAtMs > cfg.speedMaxAgeMs;
  const speedMps = vencida ? null : sample.speedMps;
  const leituraValida = speedMps != null && Number.isFinite(speedMps);
  const evidenceUntil =
    cfg.speedMaxAgeMs == null
      ? null
      : leituraValida
        ? speedAtMs + cfg.speedMaxAgeMs
        // SEM leitura válida o horizonte NÃO avança — ausência de fix não prova
        // nada. Depois de um corte, `prev.evidenceUntil` já está no passado, e é
        // isso que impede o passo seguinte de creditar o vazio.
        : prev.evidenceUntil ?? prev.since + cfg.speedMaxAgeMs;

  // 2) Classifica movimento (histerese). Atualiza candidatos mesmo sem transição.
  const motion = classifyMotion(prev, atMs, speedMps, cfg);
  const base: DutyMachine = { ...prev, ...motion, evidenceUntil };

  // 3) Perda de GPS → UNKNOWN (congela o estado atual, credita o que já correu).
  if (motion.moving === null) {
    if (prev.state === 'UNKNOWN') return { machine: base, transitions: [] };
    const banked = bank(base, atMs, cfg);
    return {
      machine: { ...banked, state: 'UNKNOWN', since: atMs, frozenState: prev.state },
      transitions: [{ from: prev.state, to: 'UNKNOWN', atMs, reason: 'gps_lost' }],
    };
  }

  // 4) Saindo de UNKNOWN: restaura o estado congelado sem contar o gap.
  if (prev.state === 'UNKNOWN') {
    const restored = base.frozenState ?? 'STOPPED_TOLERANCE';
    const m2: DutyMachine = { ...base, state: restored, since: atMs, frozenState: null };
    // Reavalia imediatamente com o estado restaurado.
    return stepFromKnown(m2, atMs, motion.moving, cfg);
  }

  // 5) Estados conhecidos.
  return stepFromKnown(base, atMs, motion.moving, cfg);
}

/** Transições entre estados conhecidos (não-UNKNOWN, online), dado moving. */
function stepFromKnown(
  m: DutyMachine,
  atMs: number,
  moving: boolean,
  cfg: DutyMovementConfig,
): DutyStepResult {
  const noop = (mm: DutyMachine): DutyStepResult => ({ machine: mm, transitions: [] });

  switch (m.state) {
    case 'OFFLINE': {
      // Acabou de voltar online: define estado inicial pelo movimento.
      if (moving) {
        return transitionTo(m, 'MOVING', atMs, 'online_moving', cfg, { stopEpisodeStart: null });
      }
      return transitionTo(m, 'STOPPED_TOLERANCE', atMs, 'online_stopped', cfg, {
        stopEpisodeStart: atMs,
      });
    }

    case 'MOVING': {
      if (moving) return noop(m);
      // Parou → tolerância; início do episódio de parada = agora.
      return transitionTo(m, 'STOPPED_TOLERANCE', atMs, 'stopped', cfg, { stopEpisodeStart: atMs });
    }

    case 'STOPPED_TOLERANCE': {
      const stopStart = m.stopEpisodeStart ?? m.since;
      const stoppedMs = atMs - stopStart;
      if (moving) {
        // Retomou dentro da tolerância → volta a MOVING (crédito da tolerância).
        return transitionTo(m, 'MOVING', atMs, 'resume', cfg, { stopEpisodeStart: null });
      }
      if (stoppedMs >= cfg.resetMs) {
        // Parado além de 6h → zera (novo ciclo), continua parado.
        return transitionTo(m, 'PAUSED', atMs, 'reset', cfg, { workedMs: 0, stopEpisodeStart: stopStart });
      }
      if (stoppedMs >= cfg.toleranceMs) {
        // Passou a tolerância → PAUSED (não conta mais).
        return transitionTo(m, 'PAUSED', atMs, 'tolerance_exceeded', cfg, { stopEpisodeStart: stopStart });
      }
      return noop(m); // ainda dentro da tolerância
    }

    case 'PAUSED': {
      const stopStart = m.stopEpisodeStart ?? m.since;
      const stoppedMs = atMs - stopStart;
      if (moving) {
        // Retomou (antes de 6h) → MOVING, mantém o valor pausado.
        return transitionTo(m, 'MOVING', atMs, 'resume', cfg, { stopEpisodeStart: null });
      }
      if (stoppedMs >= cfg.resetMs && m.workedMs !== 0) {
        // Parado além de 6h → zera uma única vez.
        return transitionTo(m, 'PAUSED', atMs, 'reset', cfg, { workedMs: 0, stopEpisodeStart: stopStart });
      }
      return noop(m);
    }

    default:
      return noop(m);
  }
}

// ─── Persistência ────────────────────────────────────────────────────────────

/** Serializa o estado para AsyncStorage (JSON puro). */
export function serializeDuty(m: DutyMachine): string {
  return JSON.stringify(m);
}

/**
 * Reconstrói o estado a partir do JSON salvo. Retorna null se inválido/ausente,
 * cabendo ao chamador iniciar um estado novo. Como todo limite é por timestamp,
 * basta desserializar e mandar o próximo sample com o horário atual.
 */
export function deserializeDuty(raw: string | null | undefined): DutyMachine | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw) as Partial<DutyMachine>;
    if (
      typeof o?.state !== 'string' ||
      typeof o?.workedMs !== 'number' ||
      typeof o?.since !== 'number'
    ) {
      return null;
    }
    return {
      state: o.state as DutyMovementState,
      workedMs: o.workedMs,
      since: o.since,
      stopEpisodeStart: o.stopEpisodeStart ?? null,
      moving: o.moving ?? null,
      fastSince: o.fastSince ?? null,
      slowSince: o.slowSince ?? null,
      frozenState: o.frozenState ?? null,
      // Estado gravado por um build ANTERIOR não tem este campo. `null` NÃO
      // significa "sem teto": `cortarSemProva` cai no teto derivado de `since`
      // quando ele falta, então a máquina que atravessou a atualização do app em
      // MOVING também não credita o intervalo sem prova.
      evidenceUntil: typeof o.evidenceUntil === 'number' ? o.evidenceUntil : null,
    };
  } catch {
    return null;
  }
}
