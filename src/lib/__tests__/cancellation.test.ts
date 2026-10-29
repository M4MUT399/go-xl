// Testes da regra de cancelamento de agendamento (`src/lib/cancellation.ts`).
//
// A regra tem duas metades e elas erram para lados opostos, então o teste é
// escrito nessa ordem: primeiro que CANCELAR É SEMPRE POSSÍVEL (o defeito
// relatado foi justamente não haver saída), depois que a cobrança só aparece
// dentro da última hora. Uma implementação que dissesse "grátis sempre"
// passaria no primeiro grupo sozinha; é o segundo que impede isso, e vice-versa.

import {
  cancellationPolicy,
  canCancelSchedule,
  hasConfirmedDriver,
  FREE_WINDOW_MIN,
} from '../cancellation';

const MIN = 60_000;
const AGORA = Date.parse('2026-09-07T15:00:00Z');
const emMinutos = (m: number) => new Date(AGORA + m * MIN).toISOString();

/** Agendamento com motorista JÁ COMPROMETIDO — é o único que pode gerar multa. */
const confirmada = (minutos: number, price: number | null = 41.49) => ({
  scheduled_for: emMinutos(minutos),
  price,
  accepted_at: '2026-09-06T10:00:00Z',
});

describe('cancelar é sempre possível enquanto o agendamento está de pé', () => {
  it.each([
    ['dias antes', 3 * 24 * 60],
    ['amanhã', 21 * 60],
    ['daqui a duas horas', 120],
    ['no limite da janela grátis', FREE_WINDOW_MIN + 1],
    ['dentro da última hora', 30],
    ['no horário', 0],
    ['atrasado', -45],
  ])('%s', (_nome, minutos) => {
    expect(canCancelSchedule({ status: 'scheduled' })).toBe(true);
    // A política responde para qualquer horário — nunca "não dá para cancelar".
    const p = cancellationPolicy(confirmada(minutos), AGORA);
    expect(typeof p.free).toBe('boolean');
  });

  it.each(['completed', 'cancelled', 'in_progress', 'requesting', 'accepted'])(
    'status %s não é cancelável por esta via',
    (status) => {
      expect(canCancelSchedule({ status })).toBe(false);
    },
  );
});

describe('grátis com mais de 1 hora de antecedência', () => {
  it('agendamento do print: 21h antes → grátis', () => {
    const p = cancellationPolicy({ scheduled_for: emMinutos(21 * 60), price: 41.49 }, AGORA);
    expect(p.free).toBe(true);
  });

  it('61 minutos antes → grátis', () => {
    expect(cancellationPolicy({ scheduled_for: emMinutos(61), price: 41.49 }, AGORA).free).toBe(true);
  });

  // A borda exata: 60 minutos NÃO é "mais de uma hora".
  it('exatamente 60 minutos antes, com motorista confirmado → cobra', () => {
    expect(cancellationPolicy(confirmada(60), AGORA).free).toBe(false);
  });
});

describe('dentro da última hora, cobra a tarifa INTEGRAL', () => {
  it('59 minutos antes → cobra o valor cheio da corrida', () => {
    const p = cancellationPolicy(confirmada(59), AGORA);
    expect(p.free).toBe(false);
    if (!p.free) expect(p.chargeDollars).toBe(41.49);
  });

  it('já passou do horário → segue cobrando integral', () => {
    const p = cancellationPolicy(confirmada(-20), AGORA);
    expect(p.free).toBe(false);
    if (!p.free) expect(p.chargeDollars).toBe(41.49);
  });

  it('não inventa valor quando a tarifa não está gravada', () => {
    const p = cancellationPolicy(confirmada(10, null), AGORA);
    expect(p.free).toBe(false);
    if (!p.free) expect(p.chargeDollars).toBe(0);
  });
});

describe('horário ilegível é GRÁTIS — a direção segura do erro', () => {
  // Cobrar a tarifa cheia de alguém por causa de uma coluna nula seria
  // transformar defeito nosso em conta do passageiro.
  it.each([[null], [undefined], ['nao-e-data']])('scheduled_for = %s', (valor) => {
    const p = cancellationPolicy(
      { scheduled_for: valor as string | null | undefined, price: 41.49, accepted_at: '2026-09-06T10:00:00Z' },
      AGORA,
    );
    expect(p.free).toBe(true);
  });
});

describe('a multa só existe com motorista COMPROMETIDO', () => {
  // A multa é compensação, não receita: sem alguém que aceitou buscar, não há
  // quem compensar — e a tela estaria dizendo "um motorista já confirmou esta
  // corrida" para justificar a cobrança.
  it('dentro da última hora e ninguém aceitou → grátis', () => {
    const p = cancellationPolicy({ scheduled_for: emMinutos(30), price: 41.49, accepted_at: null }, AGORA);
    expect(p.free).toBe(true);
  });

  it('dentro da última hora e motorista aceitou → cobra', () => {
    expect(cancellationPolicy(confirmada(30), AGORA).free).toBe(false);
  });

  // A distinção que custaria dinheiro se fosse feita por `driver_id`: um
  // agendamento travado por QR nasce COM motorista e SEM aceite. Cobrar aí seria
  // multar o passageiro por um compromisso que ninguém assumiu.
  it('QR pré-vinculado (tem driver_id, não tem accepted_at) → grátis', () => {
    const qr = {
      scheduled_for: emMinutos(30),
      price: 41.49,
      driver_id: 'motorista-do-qr',
      accepted_at: null,
    };
    expect(cancellationPolicy(qr, AGORA).free).toBe(true);
    expect(hasConfirmedDriver(qr)).toBe(false);
  });

  it('hasConfirmedDriver olha accepted_at, e só ele', () => {
    expect(hasConfirmedDriver({ accepted_at: '2026-09-06T10:00:00Z' })).toBe(true);
    expect(hasConfirmedDriver({ accepted_at: null })).toBe(false);
    expect(hasConfirmedDriver({})).toBe(false);
  });
});
