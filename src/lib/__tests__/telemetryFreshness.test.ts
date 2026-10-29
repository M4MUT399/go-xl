// A regra que impede o app de apresentar um ETA velho como se fosse fresco.
//
// O caso real: 26/09/2026, o passageiro Jeff leu "11:30" na tela enquanto o
// motorista chegaria 11:03, e quase perdeu o voo. A telemetria tinha parado
// minutos antes — mas a tela não tinha como saber, porque só marcava dado velho
// quando a CONSULTA FALHAVA.
//
// A ordem dos grupos aqui não é estética. Primeiro o que PRECISA ser marcado
// como velho (é o defeito), depois o que NÃO pode ser marcado à toa (senão a
// resposta fácil — "marque tudo como velho" — passaria no primeiro grupo e
// encheria a tela de "~" permanente, que o passageiro aprende a ignorar).

import {
  telemetryFreshness,
  staleMinutes,
  STALE_AFTER_MS,
} from '../telemetryFreshness';

const AGORA = Date.parse('2026-09-26T14:49:00Z');
const hhMmSsAtras = (ms: number) => new Date(AGORA - ms).toISOString();
const SEG = 1000;
const MIN = 60 * SEG;

describe('o que PRECISA ser marcado como velho', () => {
  // O caso do Jeff: telemetria de minutos atrás, lida com sucesso.
  it('fix de 6 minutos atrás', () => {
    const r = telemetryFreshness({ driver_telemetry_at: hhMmSsAtras(6 * MIN) }, AGORA);
    expect(r.stale).toBe(true);
    if (r.stale) { expect(r.reason).toBe('aged'); expect(staleMinutes(r.ageMs)).toBe(6); }
  });

  it('logo depois do limite', () => {
    const r = telemetryFreshness({ driver_telemetry_at: hhMmSsAtras(STALE_AFTER_MS + SEG) }, AGORA);
    expect(r.stale).toBe(true);
  });

  it('consulta falhando manda, mesmo com carimbo fresco', () => {
    const r = telemetryFreshness(
      { driver_telemetry_at: hhMmSsAtras(SEG) }, AGORA, { queryFailed: true },
    );
    expect(r.stale).toBe(true);
    if (r.stale) expect(r.reason).toBe('query_failed');
  });

  // App de motorista anterior a esta regra: sem carimbo, caímos na inferência
  // pela posição que não muda.
  it('sem carimbo, posição parada há muito tempo', () => {
    const r = telemetryFreshness(
      { driver_lat: 28.4, driver_lng: -81.3 }, AGORA, { unchangedSinceMs: AGORA - 5 * MIN },
    );
    expect(r.stale).toBe(true);
    if (r.stale) expect(r.reason).toBe('aged');
  });

  it('sem carimbo e sem posição nenhuma: não afirma que é fresco', () => {
    const r = telemetryFreshness({}, AGORA);
    expect(r.stale).toBe(true);
    if (r.stale) expect(r.reason).toBe('unknown');
  });
});

describe('o que NÃO pode ser marcado à toa', () => {
  // Um "~" permanente é um "~" que ninguém lê.
  it('fix de 4 segundos (heartbeat de primeiro plano)', () => {
    expect(telemetryFreshness({ driver_telemetry_at: hhMmSsAtras(4 * SEG) }, AGORA).stale).toBe(false);
  });

  it('fix de 15 segundos (heartbeat de segundo plano)', () => {
    expect(telemetryFreshness({ driver_telemetry_at: hhMmSsAtras(15 * SEG) }, AGORA).stale).toBe(false);
  });

  // Túnel, garagem, troca de torre — tudo isso cabe dentro da folga.
  it('fix de 60 segundos ainda é confiável', () => {
    expect(telemetryFreshness({ driver_telemetry_at: hhMmSsAtras(60 * SEG) }, AGORA).stale).toBe(false);
  });

  it('exatamente no limite ainda vale', () => {
    expect(telemetryFreshness({ driver_telemetry_at: hhMmSsAtras(STALE_AFTER_MS) }, AGORA).stale).toBe(false);
  });

  it('sem carimbo, mas a posição mudou agora há pouco', () => {
    const r = telemetryFreshness(
      { driver_lat: 28.4, driver_lng: -81.3 }, AGORA, { unchangedSinceMs: AGORA - 10 * SEG },
    );
    expect(r.stale).toBe(false);
  });

  // Relógio do aparelho adiantado daria idade negativa. A culpa é do relógio.
  it('carimbo no futuro não vira dado velho', () => {
    const r = telemetryFreshness({ driver_telemetry_at: new Date(AGORA + 30 * SEG).toISOString() }, AGORA);
    expect(r.stale).toBe(false);
  });

  it('carimbo ilegível cai na inferência, não em pânico', () => {
    const r = telemetryFreshness(
      { driver_telemetry_at: 'nao-e-data', driver_lat: 28.4, driver_lng: -81.3 },
      AGORA, { unchangedSinceMs: AGORA - 5 * SEG },
    );
    expect(r.stale).toBe(false);
  });
});

describe('staleMinutes — o que a tela diz ao passageiro', () => {
  it('arredonda para baixo, mas nunca diz "0 min"', () => {
    expect(staleMinutes(30 * SEG)).toBe(1);
    expect(staleMinutes(6.9 * MIN)).toBe(6);
  });

  it('aguenta ausência de idade', () => {
    expect(staleMinutes(undefined)).toBe(0);
  });
});
