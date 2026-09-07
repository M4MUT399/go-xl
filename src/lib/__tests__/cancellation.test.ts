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
  FREE_WINDOW_MIN,
} from '../cancellation';

const MIN = 60_000;
const AGORA = Date.parse('2026-09-07T15:00:00Z');
const emMinutos = (m: number) => new Date(AGORA + m * MIN).toISOString();

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
    const p = cancellationPolicy({ scheduled_for: emMinutos(minutos), price: 41.49 }, AGORA);
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
  it('exatamente 60 minutos antes → cobra', () => {
    expect(cancellationPolicy({ scheduled_for: emMinutos(60), price: 41.49 }, AGORA).free).toBe(false);
  });
});

describe('dentro da última hora, cobra a tarifa INTEGRAL', () => {
  it('59 minutos antes → cobra o valor cheio da corrida', () => {
    const p = cancellationPolicy({ scheduled_for: emMinutos(59), price: 41.49 }, AGORA);
    expect(p.free).toBe(false);
    if (!p.free) expect(p.chargeDollars).toBe(41.49);
  });

  it('já passou do horário → segue cobrando integral', () => {
    const p = cancellationPolicy({ scheduled_for: emMinutos(-20), price: 41.49 }, AGORA);
    expect(p.free).toBe(false);
    if (!p.free) expect(p.chargeDollars).toBe(41.49);
  });

  it('não inventa valor quando a tarifa não está gravada', () => {
    const p = cancellationPolicy({ scheduled_for: emMinutos(10), price: null }, AGORA);
    expect(p.free).toBe(false);
    if (!p.free) expect(p.chargeDollars).toBe(0);
  });
});

describe('horário ilegível é GRÁTIS — a direção segura do erro', () => {
  // Cobrar a tarifa cheia de alguém por causa de uma coluna nula seria
  // transformar defeito nosso em conta do passageiro.
  it.each([[null], [undefined], ['nao-e-data']])('scheduled_for = %s', (valor) => {
    const p = cancellationPolicy(
      { scheduled_for: valor as string | null | undefined, price: 41.49 },
      AGORA,
    );
    expect(p.free).toBe(true);
  });
});
