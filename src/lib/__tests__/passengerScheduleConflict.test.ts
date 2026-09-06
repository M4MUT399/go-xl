// Testes da regra de agendamento DO PASSAGEIRO (`passengerScheduleConflict`).
//
// O defeito relatado: passageiro que já tinha um agendamento não conseguia
// marcar outro. A regra do produto é o contrário — pode ter quantos quiser,
// desde que não batam no mesmo horário. Por isso o teste que mais importa aqui
// não é o do conflito: é o que prova que agendamentos em horários DIFERENTES
// passam. Uma regra que recusa tudo também passaria em "detecta sobreposição".
//
// Não confundir com `scheduleConflict.test.ts`: aquele exercita a regra do
// MOTORISTA, que soma deslocamento e 20 min de folga porque é o mesmo carro
// atendendo as duas corridas. Aplicada ao passageiro ela recusaria coisa
// legítima — ver o comentário de bloco em `scheduleConflict.ts`.

import {
  passengerScheduleConflict,
  MIN_RIDE_WINDOW_MIN,
  type PassengerRideLike,
} from '../scheduleConflict';

const BASE = new Date('2026-09-10T12:00:00Z').getTime();
const iso = (offsetMin: number) => new Date(BASE + offsetMin * 60_000).toISOString();

function corrida(id: string, offsetMin: number, durationMin: number | null = 30): PassengerRideLike {
  return { id, scheduled_for: iso(offsetMin), duration_min: durationMin };
}

describe('passengerScheduleConflict — o que PRECISA passar', () => {
  it('deixa marcar quando não há agendamento nenhum', () => {
    expect(passengerScheduleConflict(corrida('nova', 0), []).conflict).toBe(false);
  });

  // O caso do defeito: já existe um agendamento, e o novo é em outro horário.
  it('deixa marcar um segundo agendamento em horário livre', () => {
    const existente = corrida('a', 0, 30); // 12:00 → 12:30
    const nova = corrida('nova', 120, 30); // 14:00 → 14:30
    expect(passengerScheduleConflict(nova, [existente]).conflict).toBe(false);
  });

  it('deixa marcar o TERCEIRO e o QUARTO, todos em horários livres', () => {
    const agenda = [corrida('a', 0), corrida('b', 120), corrida('c', 240)];
    expect(passengerScheduleConflict(corrida('nova', 360), agenda).conflict).toBe(false);
  });

  it('deixa marcar ANTES de um agendamento já existente', () => {
    const existente = corrida('a', 120, 30);
    expect(passengerScheduleConflict(corrida('nova', 0, 30), [existente]).conflict).toBe(false);
  });

  // Encostar não é sobrepor: uma termina 12:30, a outra começa 12:30.
  it('deixa marcar coladinho no fim da anterior', () => {
    const existente = corrida('a', 0, 30);
    expect(passengerScheduleConflict(corrida('nova', 30, 30), [existente]).conflict).toBe(false);
  });

  it('ignora agendamento existente sem horário legível em vez de recusar', () => {
    const quebrado: PassengerRideLike = { id: 'x', scheduled_for: 'nao-e-data', duration_min: 30 };
    const semHorario: PassengerRideLike = { id: 'y', scheduled_for: null, duration_min: 30 };
    expect(passengerScheduleConflict(corrida('nova', 0), [quebrado, semHorario]).conflict).toBe(false);
  });

  it('não conflita consigo mesma numa reavaliação', () => {
    const mesma = corrida('a', 0, 30);
    expect(passengerScheduleConflict(mesma, [mesma]).conflict).toBe(false);
  });
});

describe('passengerScheduleConflict — o que PRECISA barrar', () => {
  it('barra o mesmo horário exato', () => {
    const r = passengerScheduleConflict(corrida('nova', 0, 30), [corrida('a', 0, 30)]);
    expect(r.conflict).toBe(true);
    expect(r.withRideId).toBe('a');
    expect(r.withScheduledFor).toBe(iso(0));
  });

  it('barra quando a nova começa no meio da anterior', () => {
    // 12:00→12:45 já marcada; nova às 12:20.
    expect(passengerScheduleConflict(corrida('nova', 20, 30), [corrida('a', 0, 45)]).conflict).toBe(true);
  });

  it('barra quando a nova ENGOLE a anterior', () => {
    // nova 12:00→13:00 sobre uma marcada 12:10→12:20.
    expect(passengerScheduleConflict(corrida('nova', 0, 60), [corrida('a', 10, 10)]).conflict).toBe(true);
  });

  it('nomeia a corrida conflitante, e não outra da agenda', () => {
    const agenda = [corrida('cedo', -300, 30), corrida('bate', 10, 30), corrida('tarde', 300, 30)];
    expect(passengerScheduleConflict(corrida('nova', 0, 30), agenda).withRideId).toBe('bate');
  });
});

describe('duração ausente', () => {
  // Sem janela mínima, dois agendamentos para 12:00 e 12:01 seriam dois
  // instantes que não se cruzam — o passageiro sairia marcado em dois carros.
  it('usa a janela mínima quando a duração não é conhecida', () => {
    const semDuracao = corrida('a', 0, null);
    const logoDepois = corrida('nova', MIN_RIDE_WINDOW_MIN - 1, null);
    expect(passengerScheduleConflict(logoDepois, [semDuracao]).conflict).toBe(true);
  });

  it('e a janela mínima não estica além do que deveria', () => {
    const semDuracao = corrida('a', 0, null);
    const depoisDaJanela = corrida('nova', MIN_RIDE_WINDOW_MIN, null);
    expect(passengerScheduleConflict(depoisDaJanela, [semDuracao]).conflict).toBe(false);
  });

  it('trata duração zero ou negativa como ausente', () => {
    expect(passengerScheduleConflict(corrida('nova', 5, 0), [corrida('a', 0, 0)]).conflict).toBe(true);
    expect(passengerScheduleConflict(corrida('nova', 5, -10), [corrida('a', 0, -10)]).conflict).toBe(true);
  });
});

describe('candidato sem horário legível', () => {
  it('não inventa conflito — quem barra data inválida é a tela', () => {
    const r = passengerScheduleConflict({ scheduled_for: null }, [corrida('a', 0)]);
    expect(r.conflict).toBe(false);
  });
});
