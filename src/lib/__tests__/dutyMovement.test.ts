import {
  DEFAULT_DUTY_MOVEMENT,
  deserializeDuty,
  initialDutyMachine,
  serializeDuty,
  stepDuty,
  workedMinutes,
  type DutyMachine,
  type DutyMovementConfig,
} from '../dutyMovement';

const MIN = 60_000;
const HOUR = 60 * MIN;

// Config sem histerese (sustain 0) para exercitar o ACUMULADOR de forma limpa —
// a histerese 30s/60s é testada à parte, abaixo.
const CFG: DutyMovementConfig = {
  ...DEFAULT_DUTY_MOVEMENT,
  moveOnSustainMs: 0,
  moveOffSustainMs: 0,
};

const MOVE = 15; // m/s (~54 km/h)
const STOP = 0;

/** Aplica uma sequência de samples e devolve a máquina final. */
function run(samples: Array<[number, number | null]>, cfg = CFG): DutyMachine {
  let m = initialDutyMachine(samples[0][0]);
  for (const [atMs, speedMps] of samples) {
    m = stepDuty(m, { atMs, speedMps, online: true }, cfg).machine;
  }
  return m;
}

describe('dutyMovement — cenários de compliance', () => {
  it('2h contínuas em movimento → 2h00', () => {
    const m = run([
      [0, MOVE],
      [1 * HOUR, MOVE],
      [2 * HOUR, MOVE],
    ]);
    expect(workedMinutes(m, 2 * HOUR, CFG)).toBeCloseTo(120, 5);
  });

  it('1h + parada de 8min + 1h → 2h08 (parada dentro da tolerância conta)', () => {
    const m = run([
      [0, MOVE],
      [1 * HOUR, MOVE],
      [1 * HOUR, STOP], // para
      [1 * HOUR + 8 * MIN, MOVE], // retoma em 8min
      [2 * HOUR + 8 * MIN, MOVE],
    ]);
    expect(workedMinutes(m, 2 * HOUR + 8 * MIN, CFG)).toBeCloseTo(128, 5);
  });

  it('parada de 25min → 10 contados + 15 pausados', () => {
    const m = run([
      [0, STOP], // online já parado
      [25 * MIN, STOP],
    ]);
    expect(m.state).toBe('PAUSED');
    expect(workedMinutes(m, 25 * MIN, CFG)).toBeCloseTo(10, 5);
  });

  it('parada de 6h01 → acumulador zerado', () => {
    const m = run([
      [0, MOVE],
      [1 * HOUR, MOVE],
      [1 * HOUR, STOP], // para (episódio de parada começa em 1h)
      [1 * HOUR + 11 * MIN, STOP], // vira PAUSED
      [1 * HOUR + 6 * HOUR + 1 * MIN, STOP], // 6h01 parado
    ]);
    expect(workedMinutes(m, 1 * HOUR + 6 * HOUR + 1 * MIN, CFG)).toBeCloseTo(0, 5);
  });

  it('kill no meio (serialize/deserialize) → mesmo resultado', () => {
    // Roda até 1h05 (parado, dentro da tolerância), "mata" o app, reconstrói e
    // continua. Resultado final deve ser idêntico a rodar contínuo.
    let m = initialDutyMachine(0);
    m = stepDuty(m, { atMs: 0, speedMps: MOVE, online: true }, CFG).machine;
    m = stepDuty(m, { atMs: 1 * HOUR, speedMps: STOP, online: true }, CFG).machine;
    // kill:
    const revived = deserializeDuty(serializeDuty(m));
    expect(revived).not.toBeNull();
    let m2 = revived as DutyMachine;
    // retoma movimento em 8min e segue +1h
    m2 = stepDuty(m2, { atMs: 1 * HOUR + 8 * MIN, speedMps: MOVE, online: true }, CFG).machine;
    m2 = stepDuty(m2, { atMs: 2 * HOUR + 8 * MIN, speedMps: MOVE, online: true }, CFG).machine;
    expect(workedMinutes(m2, 2 * HOUR + 8 * MIN, CFG)).toBeCloseTo(128, 5);
  });

  it('flag toleranceCountsAsWork=false → parada não conta nada', () => {
    const cfg = { ...CFG, toleranceCountsAsWork: false };
    const m = run(
      [
        [0, STOP],
        [25 * MIN, STOP],
      ],
      cfg,
    );
    expect(workedMinutes(m, 25 * MIN, cfg)).toBeCloseTo(0, 5);
  });
});

describe('dutyMovement — descanso offline zera o acúmulo', () => {
  const NOHYST: DutyMovementConfig = { ...CFG }; // resetMs padrão = 6h

  it('offline por >= 6h ZERA o acumulador (não amanhece bloqueado)', () => {
    let m = initialDutyMachine(0);
    // Acumula ~10h dirigindo online.
    m = stepDuty(m, { atMs: 0, speedMps: MOVE, online: true }, NOHYST).machine;
    m = stepDuty(m, { atMs: 10 * HOUR, speedMps: MOVE, online: true }, NOHYST).machine;
    expect(workedMinutes(m, 10 * HOUR, NOHYST)).toBeCloseTo(600, 5);
    // Fica OFFLINE (fim do turno).
    m = stepDuty(m, { atMs: 10 * HOUR, speedMps: STOP, online: false }, NOHYST).machine;
    expect(m.state).toBe('OFFLINE');
    // 6h01 offline → zera.
    const r = stepDuty(m, { atMs: 16 * HOUR + 1 * MIN, speedMps: STOP, online: false }, NOHYST);
    expect(r.transitions.map((t) => t.reason)).toEqual(['reset_offline']);
    expect(workedMinutes(r.machine, 16 * HOUR + 1 * MIN, NOHYST)).toBeCloseTo(0, 5);
  });

  it('offline por < 6h NÃO zera (mantém o acúmulo)', () => {
    let m = initialDutyMachine(0);
    m = stepDuty(m, { atMs: 0, speedMps: MOVE, online: true }, NOHYST).machine;
    m = stepDuty(m, { atMs: 5 * HOUR, speedMps: MOVE, online: true }, NOHYST).machine;
    m = stepDuty(m, { atMs: 5 * HOUR, speedMps: STOP, online: false }, NOHYST).machine;
    // só 2h offline
    const m2 = stepDuty(m, { atMs: 7 * HOUR, speedMps: STOP, online: false }, NOHYST).machine;
    expect(workedMinutes(m2, 7 * HOUR, NOHYST)).toBeCloseTo(300, 5);
  });
});

describe('dutyMovement — política tolerância ZERO (app)', () => {
  // Espelha o cfgRef do useDutyMovementTracker: só conta em movimento.
  const ZERO: DutyMovementConfig = { ...CFG, toleranceMs: 0, toleranceCountsAsWork: false };

  it('parada não conta NADA (sem tolerância)', () => {
    const m = run(
      [
        [0, MOVE],
        [1 * HOUR, MOVE],
        [1 * HOUR, STOP], // para
        [1 * HOUR + 25 * MIN, STOP],
      ],
      ZERO,
    );
    // Contou só a 1h em movimento; os 25min parado não entram.
    expect(workedMinutes(m, 1 * HOUR + 25 * MIN, ZERO)).toBeCloseTo(60, 5);
  });
});

describe('dutyMovement — transições e telemetria', () => {
  it('emite transição MOVING→STOPPED_TOLERANCE ao parar', () => {
    let m = initialDutyMachine(0);
    m = stepDuty(m, { atMs: 0, speedMps: MOVE, online: true }, CFG).machine;
    const r = stepDuty(m, { atMs: 1 * HOUR, speedMps: STOP, online: true }, CFG);
    expect(r.transitions).toEqual([{
      from: 'MOVING',
      to: 'STOPPED_TOLERANCE',
      atMs: 1 * HOUR,
      reason: 'stopped',
    }]);
  });

  it('perda de GPS → UNKNOWN congela e depois restaura sem contar o gap', () => {
    let m = initialDutyMachine(0);
    m = stepDuty(m, { atMs: 0, speedMps: MOVE, online: true }, CFG).machine;
    // GPS some por 5 min
    m = stepDuty(m, { atMs: 30 * MIN, speedMps: null, online: true }, CFG).machine;
    expect(m.state).toBe('UNKNOWN');
    // volta o sinal em movimento 5 min depois
    m = stepDuty(m, { atMs: 35 * MIN, speedMps: MOVE, online: true }, CFG).machine;
    m = stepDuty(m, { atMs: 60 * MIN, speedMps: MOVE, online: true }, CFG).machine;
    // Contou 30min (antes) + 25min (depois) = 55min; os 5min de UNKNOWN não contam.
    expect(workedMinutes(m, 60 * MIN, CFG)).toBeCloseTo(55, 5);
  });
});

describe('dutyMovement — histerese (30s/60s, 8 km/h)', () => {
  it('só entra MOVING após 8 km/h sustentado por 30s', () => {
    let m = initialDutyMachine(0);
    // 10 km/h a partir de t=0
    m = stepDuty(m, { atMs: 0, speedMps: 3, online: true }, DEFAULT_DUTY_MOVEMENT).machine;
    expect(m.state).not.toBe('MOVING'); // ainda não confirmou
    m = stepDuty(m, { atMs: 30_000, speedMps: 3, online: true }, DEFAULT_DUTY_MOVEMENT).machine;
    expect(m.state).toBe('MOVING'); // 30s sustentado
  });

  it('só sai de MOVING após < 8 km/h sustentado por 60s', () => {
    let m = initialDutyMachine(0);
    m = stepDuty(m, { atMs: 0, speedMps: 5, online: true }, DEFAULT_DUTY_MOVEMENT).machine;
    m = stepDuty(m, { atMs: 30_000, speedMps: 5, online: true }, DEFAULT_DUTY_MOVEMENT).machine;
    expect(m.state).toBe('MOVING');
    // desacelera
    m = stepDuty(m, { atMs: 60_000, speedMps: 0, online: true }, DEFAULT_DUTY_MOVEMENT).machine;
    expect(m.state).toBe('MOVING'); // < 60s parado → ainda movendo
    m = stepDuty(m, { atMs: 120_001, speedMps: 0, online: true }, DEFAULT_DUTY_MOVEMENT).machine;
    expect(m.state).toBe('STOPPED_TOLERANCE'); // 60s de lentidão confirmou parada
  });
});

describe('dutyMovement — prova de GPS vencida (speedMaxAgeMs)', () => {
  // Config do APP (ver useDutyMovementTracker.ts): tolerância zero + prova de
  // velocidade válida por 90 s. A HISTERESE É ZERADA AQUI, e o hook de produção
  // NÃO faz isso (ele usa os 30 s/60 s do DEFAULT — useDutyMovementTracker.ts:
  // 73-81): o que estes casos medem é o corte da prova vencida, e os 30 s/60 s
  // só somariam um deslocamento constante a cada cenário sem exercitar nada. A
  // interação com a histerese de verdade é coberta no bloco logo abaixo, com a
  // config idêntica à de produção.
  const APP: DutyMovementConfig = {
    ...DEFAULT_DUTY_MOVEMENT,
    moveOnSustainMs: 0,
    moveOffSustainMs: 0,
    toleranceMs: 0,
    toleranceCountsAsWork: false,
    speedMaxAgeMs: 90_000,
  };

  /**
   * Uma máquina em MOVING há três horas, com a prova vencida aos 91 s.
   * Montada com LITERAIS, sem passar pela própria máquina: se o teste
   * construísse este estado chamando `stepDuty`, ele estaria conferindo o código
   * contra ele mesmo.
   */
  const MOVENDO_HA_3H: DutyMachine = {
    state: 'MOVING',
    workedMs: 0,
    since: 1_000,
    stopEpisodeStart: null,
    moving: true,
    fastSince: null,
    slowSince: null,
    frozenState: null,
    evidenceUntil: 91_000,
  };

  it('o default da lib continua SEM validade — nada mudou para quem não pediu', () => {
    expect(DEFAULT_DUTY_MOVEMENT.speedMaxAgeMs).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // O CENÁRIO DO ENUNCIADO: o app volta do background com um fix NOVO.
  //
  // É o sample que o hook realmente emite ao acordar — `speedAtMs` é o instante
  // em que o fix chegou, ou seja, AGORA. A prova é fresca e legítima; o que ela
  // não pode fazer é cobrir as três horas em que ninguém chamou a máquina.
  // ─────────────────────────────────────────────────────────────────────────
  it('app minimizado 3h e o fix que ACORDA o app é NOVO: credita 90s, não 3 horas', () => {
    const agora = 10_801_000; // 3h + 1s depois do início do estado
    const { machine } = stepDuty(
      MOVENDO_HA_3H,
      { atMs: agora, speedMps: MOVE, speedAtMs: agora, online: true },
      APP,
    );
    expect(workedMinutes(machine, agora, APP)).toBeCloseTo(1.5, 5); // 90s de prova
  });

  it('o buraco vai para a trilha MESMO quando o passo também muda de estado', () => {
    // O caso COMUM, e o que a versão anterior jogava fora: o app acorda depois
    // de horas com o carro já parado. O passo produz a parada, e o corte era
    // descartado por "já ter uma transição". Ficava no banco um período MOVING
    // de 3 h com 1,5 min de trabalho e nenhuma linha dizendo por quê — a
    // pergunta que a auditoria vem fazer (0053:1-9).
    const agora = 10_801_000;
    const { machine, transitions } = stepDuty(
      MOVENDO_HA_3H,
      { atMs: agora, speedMps: STOP, speedAtMs: agora, online: true },
      APP,
    );
    expect(transitions.map((t) => t.reason)).toEqual(['evidence_gap', 'stopped']);
    // Cronológicas: o buraco é carimbado onde a prova acabou, a parada onde o
    // app acordou.
    expect(transitions[0].atMs).toBe(91_000);
    expect(transitions[1].atMs).toBe(agora);
    expect(workedMinutes(machine, agora, APP)).toBeCloseTo(1.5, 5);
  });

  it('o corte é emitido para a auditoria como buraco no intervalo', () => {
    const agora = 10_801_000;
    const { transitions } = stepDuty(
      MOVENDO_HA_3H,
      { atMs: agora, speedMps: MOVE, speedAtMs: agora, online: true },
      APP,
    );
    expect(transitions).toEqual([{
      from: 'MOVING',
      to: 'MOVING',
      atMs: 91_000, // onde a prova acabou, não onde o app acordou
      reason: 'evidence_gap',
    }]);
  });

  it('máquina já congelada não repete o evento a cada tick', () => {
    // O horizonte de prova fica no passado enquanto nenhum fix válido chega, de
    // modo que a condição do corte segue verdadeira em TODO tick de 60 s. Sem o
    // guarda, a madrugada inteira com o app aberto viraria uma linha por minuto
    // na trilha de auditoria.
    const congelada: DutyMachine = {
      state: 'UNKNOWN',
      workedMs: 90_000,
      since: 91_000,
      stopEpisodeStart: null,
      moving: null,
      fastSince: null,
      slowSince: null,
      frozenState: 'MOVING',
      evidenceUntil: 91_000,
    };
    let m = congelada;
    const eventos: string[] = [];
    for (let t = 151_000; t <= 151_000 + 30 * MIN; t += 60_000) {
      const passo = stepDuty(m, { atMs: t, speedMps: MOVE, speedAtMs: 1_000, online: true }, APP);
      m = passo.machine;
      for (const t of passo.transitions) eventos.push(t.reason);
    }
    expect(eventos).toEqual([]);
    expect(workedMinutes(m, 151_000 + 30 * MIN, APP)).toBeCloseTo(1.5, 5);
  });

  it('o fix novo continua valendo dali para a frente — o corte não pune quem voltou', () => {
    const agora = 10_801_000;
    const { machine } = stepDuty(
      MOVENDO_HA_3H,
      { atMs: agora, speedMps: MOVE, speedAtMs: agora, online: true },
      APP,
    );
    expect(machine.state).toBe('MOVING');
    // Mais 60 s de estrada com fix vivo entram normalmente: 1.5 + 1 = 2.5 min.
    const depois = stepDuty(
      machine,
      { atMs: agora + 60_000, speedMps: MOVE, speedAtMs: agora + 60_000, online: true },
      APP,
    ).machine;
    expect(workedMinutes(depois, agora + 60_000, APP)).toBeCloseTo(2.5, 5);
  });

  it('kill+reboot: máquina revivida do disco e primeiro fix FRESCO 8h depois', () => {
    // O caminho determinístico que o hook percorre no boot: o sample de montagem
    // é descartado (guarda `loadedRef`), e o primeiro sample que chega à máquina
    // já carrega o fix novo do `useLocation` — `speedAtMs === atMs`.
    const revivida = deserializeDuty(serializeDuty(MOVENDO_HA_3H)) as DutyMachine;
    expect(revivida.evidenceUntil).toBe(91_000);
    const agora = 28_801_000; // 8h
    const { machine } = stepDuty(
      revivida,
      { atMs: agora, speedMps: MOVE, speedAtMs: agora, online: true },
      APP,
    );
    expect(workedMinutes(machine, agora, APP)).toBeCloseTo(1.5, 5);
  });

  it('máquina de um build ANTERIOR (sem evidenceUntil) também não credita o buraco', () => {
    // Sem isto o furo voltaria por uma porta lateral: quem atualiza o app com a
    // jornada em MOVING tem `evidenceUntil` ausente no JSON gravado. O teto passa
    // a ser derivado de `since`, e não é preciso zerar ninguém em campo.
    const antiga = deserializeDuty(
      JSON.stringify({
        state: 'MOVING',
        workedMs: 0,
        since: 1_000,
        stopEpisodeStart: null,
        moving: true,
        fastSince: null,
        slowSince: null,
        frozenState: null,
      }),
    ) as DutyMachine;
    expect(antiga.evidenceUntil).toBeNull();
    const agora = 10_801_000;
    const { machine } = stepDuty(
      antiga,
      { atMs: agora, speedMps: MOVE, speedAtMs: agora, online: true },
      APP,
    );
    expect(workedMinutes(machine, agora, APP)).toBeCloseTo(1.5, 5);
  });

  it('sem a validade, o mesmo fix novo creditaria as 3 horas inteiras', () => {
    // Guarda explícita do que ESTAVA errado, com o MESMO sample dos testes acima.
    const semTeto: DutyMovementConfig = { ...APP, speedMaxAgeMs: null };
    const agora = 10_801_000;
    const { machine } = stepDuty(
      MOVENDO_HA_3H,
      { atMs: agora, speedMps: MOVE, speedAtMs: agora, online: true },
      semTeto,
    );
    expect(workedMinutes(machine, agora, semTeto)).toBeCloseTo(180, 5);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // O outro caminho: o app fica em PRIMEIRO PLANO e o GPS é que morre. Aí o
  // sample repete uma velocidade VELHA, e é `speedAtMs` que a denuncia.
  // ─────────────────────────────────────────────────────────────────────────
  it('GPS morto em primeiro plano: o tick repete a velocidade velha e congela', () => {
    const agora = 10_801_000;
    const { machine } = stepDuty(
      MOVENDO_HA_3H,
      { atMs: agora, speedMps: MOVE, speedAtMs: 1_000, online: true },
      APP,
    );
    expect(machine.state).toBe('UNKNOWN'); // prova vencida = ausência de prova
    expect(workedMinutes(machine, agora, APP)).toBeCloseTo(1.5, 5);
  });

  it('kill/reboot sem fix nenhum ao acordar também para nos 90s', () => {
    const agora = 28_801_000;
    const { machine } = stepDuty(
      MOVENDO_HA_3H,
      { atMs: agora, speedMps: null, speedAtMs: null, online: true },
      APP,
    );
    expect(workedMinutes(machine, agora, APP)).toBeCloseTo(1.5, 5);
  });

  it('GPS vivo (fix a cada 5s) conta a hora inteira — a validade não penaliza quem roda', () => {
    let m = initialDutyMachine(0);
    for (let t = 0; t <= 60 * MIN; t += 5_000) {
      m = stepDuty(m, { atMs: t, speedMps: MOVE, speedAtMs: t, online: true }, APP).machine;
    }
    expect(m.state).toBe('MOVING');
    expect(workedMinutes(m, 60 * MIN, APP)).toBeCloseTo(60, 5);
  });

  it('túnel de 60s não congela nada (o tick de 60s ainda está dentro da validade)', () => {
    let m = initialDutyMachine(0);
    m = stepDuty(m, { atMs: 0, speedMps: MOVE, speedAtMs: 0, online: true }, APP).machine;
    // Tick sem fix novo: a leitura tem 60s, ainda vale.
    m = stepDuty(m, { atMs: 60_000, speedMps: MOVE, speedAtMs: 0, online: true }, APP).machine;
    expect(m.state).toBe('MOVING');
    expect(workedMinutes(m, 60_000, APP)).toBeCloseTo(1, 5);
  });

  it('sair do congelamento e voltar a andar não recupera o intervalo sem prova', () => {
    let m = initialDutyMachine(0);
    m = stepDuty(m, { atMs: 0, speedMps: MOVE, speedAtMs: 0, online: true }, APP).machine;
    m = stepDuty(m, { atMs: 2 * HOUR, speedMps: MOVE, speedAtMs: 0, online: true }, APP).machine;
    expect(m.state).toBe('UNKNOWN');
    // O GPS volta e o carro anda 10 min de verdade, com fix a cada 5 s.
    for (let t = 2 * HOUR; t <= 2 * HOUR + 10 * MIN; t += 5_000) {
      m = stepDuty(m, { atMs: t, speedMps: MOVE, speedAtMs: t, online: true }, APP).machine;
    }
    // 90s do trecho com prova + 10 min andando de verdade.
    expect(workedMinutes(m, 2 * HOUR + 10 * MIN, APP)).toBeCloseTo(11.5, 5);
  });

  it('encerrar o turno depois de um gap sem prova não credita o gap', () => {
    let m = initialDutyMachine(0);
    m = stepDuty(m, { atMs: 0, speedMps: MOVE, speedAtMs: 0, online: true }, APP).machine;
    // O motorista toca OFFLINE 4h depois, sem nenhum fix no meio.
    m = stepDuty(m, { atMs: 4 * HOUR, speedMps: MOVE, speedAtMs: 0, online: false }, APP).machine;
    expect(m.state).toBe('OFFLINE');
    expect(workedMinutes(m, 4 * HOUR, APP)).toBeCloseTo(1.5, 5);
  });

  it('parada longa com o app dormindo ainda ganha o reset de 6h', () => {
    // O corte não pode roubar o RELÓGIO DE PAREDE de quem descansou: quem
    // estacionou, minimizou o app e voltou 7h depois zerou a jornada de verdade.
    let m = initialDutyMachine(0);
    m = stepDuty(m, { atMs: 0, speedMps: MOVE, speedAtMs: 0, online: true }, APP).machine;
    m = stepDuty(m, { atMs: 60_000, speedMps: STOP, speedAtMs: 60_000, online: true }, APP).machine;
    // Com toleranceMs 0 a parada entra em STOPPED_TOLERANCE e já não credita
    // nada (toleranceCountsAsWork false); PAUSED vem no passo seguinte.
    expect(m.state).toBe('STOPPED_TOLERANCE');
    const seteHoras = 60_000 + 7 * HOUR;
    const passo = stepDuty(
      m,
      { atMs: seteHoras, speedMps: STOP, speedAtMs: seteHoras, online: true },
      APP,
    );
    expect(passo.machine.workedMs).toBe(0);
    expect(workedMinutes(passo.machine, seteHoras, APP)).toBe(0);
  });
});

describe('dutyMovement — a config EXATA de produção (histerese 30s/60s + prova de 90s)', () => {
  /**
   * O que `useDutyMovementTracker.ts:73-81` monta, sem nenhum atalho: o DEFAULT
   * da lib com tolerância zero e prova de velocidade válida por 90 s. A
   * histerese fica intacta — é a que roda no aparelho do motorista.
   */
  const PRODUCAO: DutyMovementConfig = {
    ...DEFAULT_DUTY_MOVEMENT,
    toleranceMs: 0,
    toleranceCountsAsWork: false,
    speedMaxAgeMs: 90_000,
  };

  it('2 h de estrada com fix a cada 5 s creditam 119,5 min — a histerese só come a partida', () => {
    // Conta escrita à mão: a máquina nasce OFFLINE, o primeiro sample a põe em
    // STOPPED_TOLERANCE (que com toleranceCountsAsWork=false não credita nada) e
    // MOVING só é confirmado aos 30 s de velocidade sustentada. De 30 s a 2 h são
    // 7.170 s = 119,5 min. O corte da prova não entra: nenhum intervalo entre
    // fixes chega perto dos 90 s.
    let m = initialDutyMachine(0);
    for (let t = 0; t <= 2 * HOUR; t += 5_000) {
      m = stepDuty(m, { atMs: t, speedMps: MOVE, speedAtMs: t, online: true }, PRODUCAO).machine;
    }
    expect(m.state).toBe('MOVING');
    expect(workedMinutes(m, 2 * HOUR, PRODUCAO)).toBeCloseTo(119.5, 5);
  });

  it('acordar parado: o buraco sai na hora, a parada ainda espera os 60 s da histerese', () => {
    // Máquina LITERAL: em MOVING desde 1 s, com a prova acabando aos 91 s.
    const dormindoEmMovimento: DutyMachine = {
      state: 'MOVING',
      workedMs: 0,
      since: 1_000,
      stopEpisodeStart: null,
      moving: true,
      fastSince: null,
      slowSince: null,
      frozenState: null,
      evidenceUntil: 91_000,
    };
    const agora = 10_801_000; // 3 h depois
    const acordar = stepDuty(
      dormindoEmMovimento,
      { atMs: agora, speedMps: STOP, speedAtMs: agora, online: true },
      PRODUCAO,
    );
    // O buraco não espera histerese nenhuma: ele é sobre PROVA, não sobre estado.
    expect(acordar.transitions.map((t) => t.reason)).toEqual(['evidence_gap']);
    expect(acordar.machine.state).toBe('MOVING'); // 60 s de lentidão ainda não completos
    expect(workedMinutes(acordar.machine, agora, PRODUCAO)).toBeCloseTo(1.5, 5);

    // Sessenta segundos de lentidão depois, a parada é confirmada — e esses 60 s
    // COM prova contam, porque a histerese de produção é assim mesmo: 1,5 + 1.
    const parou = stepDuty(
      acordar.machine,
      { atMs: agora + 60_000, speedMps: STOP, speedAtMs: agora + 60_000, online: true },
      PRODUCAO,
    );
    expect(parou.transitions.map((t) => t.reason)).toEqual(['stopped']);
    expect(workedMinutes(parou.machine, agora + 60_000, PRODUCAO)).toBeCloseTo(2.5, 5);
  });

  it('um passo emite os DOIS eventos quando o motorista já vinha desacelerando', () => {
    // Aqui a histerese de produção JÁ estava correndo quando o app dormiu
    // (`slowSince` gravado): ao acordar, os 60 s de lentidão já se completaram, e
    // o mesmo passo produz o buraco e a parada. É o caso em que o campo único
    // apagava a auditoria do buraco.
    const desacelerandoQuandoDormiu: DutyMachine = {
      state: 'MOVING',
      workedMs: 0,
      since: 1_000,
      stopEpisodeStart: null,
      moving: true,
      fastSince: null,
      slowSince: 30_000, // começou a andar devagar aos 30 s
      frozenState: null,
      evidenceUntil: 91_000,
    };
    const agora = 10_801_000;
    const { machine, transitions } = stepDuty(
      desacelerandoQuandoDormiu,
      { atMs: agora, speedMps: STOP, speedAtMs: agora, online: true },
      PRODUCAO,
    );
    expect(transitions.map((t) => t.reason)).toEqual(['evidence_gap', 'stopped']);
    expect(transitions[0].atMs).toBe(91_000);
    expect(transitions[1].atMs).toBe(agora);
    expect(machine.state).toBe('STOPPED_TOLERANCE');
    expect(workedMinutes(machine, agora, PRODUCAO)).toBeCloseTo(1.5, 5);
  });

  it('o corte não rouba o reset de 6 h de quem estacionou e sumiu', () => {
    // O relógio de parada é de PAREDE, não de prova. Sete horas com o app
    // dormindo continuam sendo descanso de verdade, com a histerese de produção
    // no lugar.
    let m = initialDutyMachine(0);
    for (let t = 0; t <= 10 * MIN; t += 5_000) {
      m = stepDuty(m, { atMs: t, speedMps: MOVE, speedAtMs: t, online: true }, PRODUCAO).machine;
    }
    expect(workedMinutes(m, 10 * MIN, PRODUCAO)).toBeCloseTo(9.5, 5); // 10 min - 30 s de partida
    // Estaciona: 60 s de lentidão confirmam a parada.
    for (let t = 10 * MIN; t <= 11 * MIN; t += 5_000) {
      m = stepDuty(m, { atMs: t, speedMps: STOP, speedAtMs: t, online: true }, PRODUCAO).machine;
    }
    expect(m.state).toBe('STOPPED_TOLERANCE');
    // Some por 7 h e volta.
    const seteHoras = 11 * MIN + 7 * HOUR;
    const volta = stepDuty(
      m,
      { atMs: seteHoras, speedMps: STOP, speedAtMs: seteHoras, online: true },
      PRODUCAO,
    );
    expect(workedMinutes(volta.machine, seteHoras, PRODUCAO)).toBe(0);
  });
});
