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

describe('dutyMovement — transições e telemetria', () => {
  it('emite transição MOVING→STOPPED_TOLERANCE ao parar', () => {
    let m = initialDutyMachine(0);
    m = stepDuty(m, { atMs: 0, speedMps: MOVE, online: true }, CFG).machine;
    const r = stepDuty(m, { atMs: 1 * HOUR, speedMps: STOP, online: true }, CFG);
    expect(r.transition).toEqual({
      from: 'MOVING',
      to: 'STOPPED_TOLERANCE',
      atMs: 1 * HOUR,
      reason: 'stopped',
    });
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
