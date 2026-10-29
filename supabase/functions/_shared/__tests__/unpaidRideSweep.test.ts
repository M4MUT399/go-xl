// Testes da decisão da varredura de concluídas não cobradas
// (`_shared/unpaidRideSweep.ts`).
//
// O que estes testes protegem, e por que nesta ordem: a varredura MOVE DINHEIRO
// do cartão de terceiros sem ninguém pedindo naquele instante. Então o conjunto
// que mais importa não é "cobra o que deve" — é "NÃO cobra o que não deve". Um
// classificador que devolvesse `charge: false` para tudo passaria trivialmente
// no primeiro grupo; é o segundo que impede isso.
//
// O que estes testes NÃO provam: que o Stripe aceita a cobrança, que o índice
// parcial da 0084 é usado pelo planner, ou que o pg_cron dispara. Isso só um
// Stripe de verdade e um Postgres de verdade provam.

import {
  classifyUnpaidRide,
  type UnpaidRideCandidate,
  type UnpaidSweepOptions,
} from '../unpaidRideSweep';

const MIN = 60_000;
const DIA = 24 * 60 * MIN;
const AGORA = Date.parse('2026-09-06T12:00:00Z');

const OPCOES: UnpaidSweepOptions = {
  nowMs: AGORA,
  minAgeMs: 20 * MIN,
  maxAgeMs: 7 * DIA,
};

/** Corrida cobrável por padrão; cada teste estraga UMA coisa. */
function corrida(over: Partial<UnpaidRideCandidate> = {}): UnpaidRideCandidate {
  return {
    id: 'corrida-1',
    status: 'completed',
    paid: false,
    price: 45.46,
    driver_id: 'motorista-1',
    completed_at: new Date(AGORA - 2 * 60 * MIN).toISOString(),
    stripe_payment_intent_id: null,
    ...over,
  };
}

describe('cobra o que deve', () => {
  // É a corrida real de 05/09/2026: $45,46, agendada, concluída, sem cobrança.
  it('cobra a corrida concluída, com motorista, sem intent e dentro da janela', () => {
    const v = classifyUnpaidRide(corrida(), OPCOES);
    expect(v.charge).toBe(true);
    if (v.charge) expect(v.amountCents).toBe(4546);
  });

  it('converte o preço para centavos inteiros', () => {
    const v = classifyUnpaidRide(corrida({ price: 30.175 }), OPCOES);
    expect(v.charge && v.amountCents).toBe(3018);
  });

  it('cobra no limite exato da carência', () => {
    const v = classifyUnpaidRide(
      corrida({ completed_at: new Date(AGORA - 20 * MIN).toISOString() }),
      OPCOES,
    );
    expect(v.charge).toBe(true);
  });

  it('cobra no limite exato do teto de idade', () => {
    const v = classifyUnpaidRide(
      corrida({ completed_at: new Date(AGORA - 7 * DIA).toISOString() }),
      OPCOES,
    );
    expect(v.charge).toBe(true);
  });
});

describe('NÃO cobra o que não deve', () => {
  it.each([
    ['cancelada', { status: 'cancelled' }, 'not_completed'],
    ['em andamento', { status: 'in_progress' }, 'not_completed'],
    ['agendada', { status: 'scheduled' }, 'not_completed'],
    ['já paga', { paid: true }, 'already_paid'],
    ['sem motorista', { driver_id: null }, 'no_driver'],
    ['preço nulo', { price: null }, 'invalid_amount'],
    ['preço abaixo do mínimo do Stripe', { price: 0.3 }, 'invalid_amount'],
  ])('%s → %s', (_nome, over, motivo) => {
    const v = classifyUnpaidRide(corrida(over as Partial<UnpaidRideCandidate>), OPCOES);
    expect(v.charge).toBe(false);
    if (!v.charge) expect(v.reason).toBe(motivo);
  });

  // O caso mais caro de errar: `paid = false` COM intent gravado pode ser
  // estorno (decisão a respeitar), webhook que não gravou a flag (já pago) ou
  // intent de outra conta. Nenhum se resolve criando uma SEGUNDA cobrança.
  it('nunca cria segunda cobrança quando já existe PaymentIntent', () => {
    const v = classifyUnpaidRide(corrida({ stripe_payment_intent_id: 'pi_ja_existe' }), OPCOES);
    expect(v.charge).toBe(false);
    if (!v.charge) {
      expect(v.reason).toBe('has_intent');
      expect(v.needsAttention).toBe(true);
    }
  });

  it('não corre contra a rede de segurança do app dentro da carência', () => {
    const v = classifyUnpaidRide(
      corrida({ completed_at: new Date(AGORA - 5 * MIN).toISOString() }),
      OPCOES,
    );
    expect(v.charge).toBe(false);
    if (!v.charge) {
      expect(v.reason).toBe('too_recent');
      // Corrida recente não é problema — é só cedo. Não enche o relatório.
      expect(v.needsAttention).toBe(false);
    }
  });

  // Sem teto, o primeiro ciclo depois do deploy sairia cobrando cartões semanas
  // depois da viagem. Uma cobrança que ninguém reconhece vira disputa.
  it('para de cobrar sozinha passado o teto de idade, e pede atenção', () => {
    const v = classifyUnpaidRide(
      corrida({ completed_at: new Date(AGORA - 8 * DIA).toISOString() }),
      OPCOES,
    );
    expect(v.charge).toBe(false);
    if (!v.charge) {
      expect(v.reason).toBe('too_old');
      expect(v.needsAttention).toBe(true);
    }
  });

  it.each([[null], [undefined], ['nao-e-data']])(
    'sem completed_at legível (%s) não cobra — não há como medir idade',
    (valor) => {
      const v = classifyUnpaidRide(
        corrida({ completed_at: valor as string | null | undefined }),
        OPCOES,
      );
      expect(v.charge).toBe(false);
      if (!v.charge) {
        expect(v.reason).toBe('too_recent');
        expect(v.needsAttention).toBe(true);
      }
    },
  );
});

describe('ordem das recusas', () => {
  // Uma corrida cancelada E já paga tem que sair por `not_completed`: o motivo
  // registrado no relatório precisa ser o primeiro fato que a desqualifica, não
  // um qualquer entre os que se aplicam.
  it('o status vem antes de tudo', () => {
    const v = classifyUnpaidRide(corrida({ status: 'cancelled', paid: true, driver_id: null }), OPCOES);
    expect(v.charge === false && v.reason).toBe('not_completed');
  });

  // Já paga não pede atenção nem quando tem intent: é o estado saudável.
  it('já paga sai antes de has_intent e não pede atenção', () => {
    const v = classifyUnpaidRide(corrida({ paid: true, stripe_payment_intent_id: 'pi_x' }), OPCOES);
    expect(v.charge).toBe(false);
    if (!v.charge) {
      expect(v.reason).toBe('already_paid');
      expect(v.needsAttention).toBe(false);
    }
  });

  // A corrida de teste de 13/07 que sobrou no banco: paid = false, intent de
  // outra conta Stripe, e antiga. Tem que sair por `has_intent`.
  it('intent presente vence o teto de idade', () => {
    const v = classifyUnpaidRide(
      corrida({ stripe_payment_intent_id: 'pi_de_outra_conta', completed_at: new Date(AGORA - 60 * DIA).toISOString() }),
      OPCOES,
    );
    expect(v.charge === false && v.reason).toBe('has_intent');
  });
});
