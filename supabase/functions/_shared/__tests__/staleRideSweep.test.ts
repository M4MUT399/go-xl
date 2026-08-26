// Testes da DECISÃO da varredura de corridas cobradas e abandonadas
// (_shared/staleRideSweep.ts).
//
// O que estes testes provam: dado um estado de corrida e um instante, se ela
// entra ou não na varredura, e por qual motivo. Todos os instantes são literais
// escritos à mão — nenhum teste recalcula a fórmula do código para conferir
// contra ela mesma, e nenhum usa `Date.now()` (o resultado não pode depender de
// quando o teste roda).
//
// O que estes testes NÃO provam: que `refunds.create` funciona, que o cron do
// Postgres dispara, que a consulta do PostgREST devolve as linhas certas, ou que
// existe de fato uma corrida em produção neste estado. Isso só um Stripe e um
// Postgres de verdade provam — não há nenhum dos dois neste ambiente.

import {
  classifyStaleRide,
  sweepAnchorMs,
  type StaleRideCandidate,
} from '../staleRideSweep';

const MIN_AGE_MS = 30 * 60 * 1000;

/** 2026-08-19T12:00:00Z — o "agora" de todos os testes abaixo. */
const NOW = Date.parse('2026-08-19T12:00:00.000Z');

/** Corrida no estado do defeito: cobrada, sem motorista, parada em requesting. */
function ride(over: Partial<StaleRideCandidate> = {}): StaleRideCandidate {
  return {
    id: 'ride_1',
    status: 'requesting',
    paid: true,
    stripe_payment_intent_id: 'pi_abc',
    created_at: '2026-08-19T11:00:00.000Z', // 60 min antes de NOW
    scheduled_for: null,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A âncora temporal
// ─────────────────────────────────────────────────────────────────────────────

describe('sweepAnchorMs — o instante MAIS RECENTE, nunca o mais antigo', () => {
  test('sem agendamento nem intent, a âncora é created_at', () => {
    expect(sweepAnchorMs(ride())).toBe(Date.parse('2026-08-19T11:00:00.000Z'));
  });

  test('corrida AGENDADA ancora no horário marcado, não na criação', () => {
    // Este é o motivo do `max`. Uma corrida agendada nasce DIAS antes de ser
    // ativada: fica 'scheduled' e só no horário marcado é cobrada e passa a
    // 'requesting'. Ancorar em created_at varreria — e ESTORNARIA — uma corrida
    // agendada no segundo seguinte à ativação, com o motorista a caminho.
    const a = sweepAnchorMs(ride({
      created_at:    '2026-08-10T09:00:00.000Z', // 9 dias antes
      scheduled_for: '2026-08-19T11:55:00.000Z', // 5 min antes de NOW
    }));
    expect(a).toBe(Date.parse('2026-08-19T11:55:00.000Z'));
  });

  test('a criação do PaymentIntent também entra no max', () => {
    const piCreated = Date.parse('2026-08-19T11:50:00.000Z');
    expect(sweepAnchorMs(ride(), piCreated)).toBe(piCreated);
  });

  test('um intent ANTIGO não puxa a âncora para trás', () => {
    // O max só pode empurrar para frente (menos varredura), nunca para trás.
    const old = Date.parse('2026-08-01T00:00:00.000Z');
    expect(sweepAnchorMs(ride(), old)).toBe(Date.parse('2026-08-19T11:00:00.000Z'));
  });

  test('sem âncora legível nenhuma, devolve null', () => {
    expect(sweepAnchorMs(ride({ created_at: null, scheduled_for: null }))).toBeNull();
    expect(sweepAnchorMs(ride({ created_at: 'não é data', scheduled_for: null }))).toBeNull();
  });

  test('chargeCreatedMs inválido é ignorado em vez de virar NaN', () => {
    expect(sweepAnchorMs(ride(), Number.NaN)).toBe(Date.parse('2026-08-19T11:00:00.000Z'));
    expect(sweepAnchorMs(ride(), Number.POSITIVE_INFINITY)).toBe(Date.parse('2026-08-19T11:00:00.000Z'));
    expect(sweepAnchorMs(ride(), null)).toBe(Date.parse('2026-08-19T11:00:00.000Z'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// O veredito
// ─────────────────────────────────────────────────────────────────────────────

describe('classifyStaleRide — quem entra na varredura', () => {
  test('o caso do defeito: cobrada, sem motorista, parada há 60 min', () => {
    const v = classifyStaleRide(ride(), { nowMs: NOW, minAgeMs: MIN_AGE_MS });
    expect(v.sweep).toBe(true);
    if (v.sweep) expect(v.ageMs).toBe(60 * 60 * 1000);
  });

  test('corrida ACEITA não é varrida, por mais velha que seja', () => {
    // A redundância com o filtro da consulta é deliberada: uma corrida pode ser
    // aceita entre a consulta e o estorno, e a releitura passa por aqui.
    for (const status of ['accepted', 'in_progress', 'completed', 'cancelled', 'scheduled']) {
      const v = classifyStaleRide(ride({ status }), { nowMs: NOW, minAgeMs: MIN_AGE_MS });
      expect(v.sweep).toBe(false);
      if (!v.sweep) expect(v.reason).toBe('not_requesting');
    }
  });

  test('corrida NÃO cobrada não tem o que estornar', () => {
    for (const paid of [false, null, undefined]) {
      const v = classifyStaleRide(ride({ paid }), { nowMs: NOW, minAgeMs: MIN_AGE_MS });
      expect(v.sweep).toBe(false);
      if (!v.sweep) expect(v.reason).toBe('not_paid');
    }
  });

  test('sem PaymentIntent não há estorno possível', () => {
    const v = classifyStaleRide(
      ride({ stripe_payment_intent_id: null }),
      { nowMs: NOW, minAgeMs: MIN_AGE_MS },
    );
    expect(v.sweep).toBe(false);
    if (!v.sweep) expect(v.reason).toBe('no_payment_intent');
  });

  test('corrida cobrada há 29 min ainda NÃO é varrida', () => {
    const v = classifyStaleRide(
      ride({ created_at: '2026-08-19T11:31:00.000Z' }),
      { nowMs: NOW, minAgeMs: MIN_AGE_MS },
    );
    expect(v.sweep).toBe(false);
    if (!v.sweep) expect(v.reason).toBe('too_recent');
  });

  test('exatamente na idade mínima já entra', () => {
    const v = classifyStaleRide(
      ride({ created_at: '2026-08-19T11:30:00.000Z' }),
      { nowMs: NOW, minAgeMs: MIN_AGE_MS },
    );
    expect(v.sweep).toBe(true);
  });

  test('CORRIDA AGENDADA recém-ativada NÃO é estornada', () => {
    // O acidente caro: a corrida foi criada há 9 dias, foi cobrada agora ao ser
    // ativada, e o motorista está a caminho. Ancorar em created_at a estornaria.
    const v = classifyStaleRide(
      ride({ created_at: '2026-08-10T09:00:00.000Z', scheduled_for: '2026-08-19T11:58:00.000Z' }),
      { nowMs: NOW, minAgeMs: MIN_AGE_MS },
    );
    expect(v.sweep).toBe(false);
    if (!v.sweep) expect(v.reason).toBe('too_recent');
  });

  test('corrida agendada cujo horário JÁ passou há muito continua varrível', () => {
    const v = classifyStaleRide(
      ride({ created_at: '2026-08-10T09:00:00.000Z', scheduled_for: '2026-08-19T10:00:00.000Z' }),
      { nowMs: NOW, minAgeMs: MIN_AGE_MS },
    );
    expect(v.sweep).toBe(true);
    if (v.sweep) expect(v.ageMs).toBe(2 * 60 * 60 * 1000);
  });

  test('o PaymentIntent RECÉM-criado protege mesmo com created_at antigo', () => {
    // A cobrança é o que realmente importa: se o cartão foi debitado há 5 min, o
    // passageiro não está abandonado há 30, por mais velha que a linha seja.
    const v = classifyStaleRide(
      ride({ created_at: '2026-08-19T09:00:00.000Z' }),
      {
        nowMs: NOW,
        minAgeMs: MIN_AGE_MS,
        chargeCreatedMs: Date.parse('2026-08-19T11:55:00.000Z'),
      },
    );
    expect(v.sweep).toBe(false);
    if (!v.sweep) expect(v.reason).toBe('too_recent');
  });

  test('sem âncora legível o veredito é NÃO varrer', () => {
    // Preferir não estornar é o erro reversível; estornar a viagem de alguém que
    // está embarcando não é.
    const v = classifyStaleRide(
      ride({ created_at: null, scheduled_for: null }),
      { nowMs: NOW, minAgeMs: MIN_AGE_MS },
    );
    expect(v.sweep).toBe(false);
    if (!v.sweep) expect(v.reason).toBe('too_recent');
  });

  test('a ordem dos "não" é estável (status vence idade)', () => {
    // Uma corrida concluída e velhíssima relata 'not_requesting', não
    // 'too_recent' — o diagnóstico precisa apontar a razão real.
    const v = classifyStaleRide(
      ride({ status: 'completed', created_at: '2026-08-01T00:00:00.000Z' }),
      { nowMs: NOW, minAgeMs: MIN_AGE_MS },
    );
    expect(v.sweep).toBe(false);
    if (!v.sweep) expect(v.reason).toBe('not_requesting');
  });

  test('idempotência da decisão: a corrida já estornada sai da varredura sozinha', () => {
    // Depois do estorno a corrida fica paid = false. Reclassificar o MESMO
    // objeto pós-estorno devolve 'not_paid': a passada seguinte não a estorna de
    // novo, mesmo que o `status` continue 'requesting'.
    const before = classifyStaleRide(ride(), { nowMs: NOW, minAgeMs: MIN_AGE_MS });
    const after = classifyStaleRide(ride({ paid: false }), { nowMs: NOW, minAgeMs: MIN_AGE_MS });
    expect(before.sweep).toBe(true);
    expect(after.sweep).toBe(false);
    if (!after.sweep) expect(after.reason).toBe('not_paid');
  });
});
