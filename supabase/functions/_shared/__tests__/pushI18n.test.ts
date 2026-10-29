// Push no idioma de QUEM RECEBE.
//
// O defeito que motivou isto: passageiro americano recebendo "Corrida
// finalizada!" porque todo texto de push estava cravado em português. Estes
// testes travam três coisas: (1) a normalização de `profiles.language` é a mesma
// do e-mail de recibo, com fallback em inglês; (2) todo template existe nos três
// idiomas e o inglês/espanhol não vazam português; (3) a data do agendamento sai
// no fuso de Orlando e no formato do idioma, não em pt-BR/UTC.

import { receiptLang } from '../rideReceipt';
import {
  pushLang, pushLocale, pushMoney, pushWhen, type PushLang, type PushText,
  pushNewRideDirect, pushNewRideScheduledDirect, pushNewRideBroadcast,
  pushRideAccepted, pushScheduleConfirmed, pushScheduleRejected, pushRideCompleted,
  pushDriverReleased, pushRideCancelledByPassenger, pushScheduleExpired,
  pushRideExpiredNoDriver, pushRideRefundedNoDriver,
} from '../pushI18n';

const LANGS: PushLang[] = ['en', 'es', 'pt'];

/** Todos os templates, com insumo representativo. */
const TEMPLATES: Record<string, (l: PushLang) => PushText> = {
  newRideDirect: (l) => pushNewRideDirect(l, 'MCO Terminal B', 41.5),
  newRideScheduledDirect: (l) => pushNewRideScheduledDirect(l, '10/31 at 3:30 PM', 'MCO Terminal B', 41.5),
  newRideBroadcast: (l) => pushNewRideBroadcast(l, 'MCO Terminal B', 41.5),
  rideAcceptedPaidEta: (l) => pushRideAccepted(l, 41.5, 7),
  rideAcceptedNoPrice: (l) => pushRideAccepted(l, null, null),
  scheduleConfirmed: pushScheduleConfirmed,
  scheduleRejected: pushScheduleRejected,
  rideCompletedPaid: (l) => pushRideCompleted(l, 41.5),
  rideCompletedNoPrice: (l) => pushRideCompleted(l, null),
  driverReleased: pushDriverReleased,
  rideCancelledByPassenger: pushRideCancelledByPassenger,
  scheduleExpired: pushScheduleExpired,
  rideExpiredNoDriver: pushRideExpiredNoDriver,
  rideRefundedNoDriver: (l) => pushRideRefundedNoDriver(l, 4153),
};

// Palavras que só aparecem no texto em português — se surgirem no inglês ou no
// espanhol, um template caiu no idioma errado.
const PT_ONLY = /\b(corrida|motorista|agendamento|você|seu|sua|cobrado|estornamos|passageiro)\b/i;

describe('pushLang', () => {
  it.each([
    ['en', 'en'], ['es', 'es'], ['pt', 'pt'],
    ['pt-BR', 'pt'], ['es-US', 'es'], ['EN', 'en'], [' Pt ', 'pt'],
    ['fr', 'en'], ['', 'en'], [null, 'en'], [undefined, 'en'], [42, 'en'],
  ])('%p → %p', (input, expected) => {
    expect(pushLang(input)).toBe(expected);
  });

  it('é a mesma normalização do e-mail de recibo', () => {
    for (const v of ['en', 'es', 'pt', 'pt-BR', 'fr', '', null, undefined]) {
      expect(pushLang(v)).toBe(receiptLang(v));
    }
  });
});

describe('templates', () => {
  it.each(Object.keys(TEMPLATES))('%s existe nos três idiomas, com título e corpo', (name) => {
    const texts = LANGS.map((l) => TEMPLATES[name](l));
    for (const t of texts) {
      expect(t.title.trim()).not.toBe('');
      expect(t.body.trim()).not.toBe('');
    }
    // Os três idiomas não podem ser o mesmo texto.
    expect(new Set(texts.map((t) => t.title + t.body)).size).toBe(3);
  });

  it.each(Object.keys(TEMPLATES))('%s em en/es não vaza português', (name) => {
    for (const l of ['en', 'es'] as PushLang[]) {
      const t = TEMPLATES[name](l);
      expect(`${t.title} ${t.body}`).not.toMatch(PT_ONLY);
    }
  });

  it('o emoji do título é o mesmo nos três idiomas', () => {
    for (const make of Object.values(TEMPLATES)) {
      const firstChars = LANGS.map((l) => Array.from(make(l).title)[0]);
      if (/\p{L}/u.test(firstChars[2])) continue; // template sem emoji (rideExpiredNoDriver)
      expect(new Set(firstChars).size).toBe(1);
    }
  });

  it('valor e destino entram no corpo em todos os idiomas', () => {
    for (const l of LANGS) {
      const t = pushNewRideBroadcast(l, 'MCO Terminal B', 41.5);
      expect(t.body).toContain('MCO Terminal B');
      expect(t.body).toContain('$41.50');
    }
  });

  it('corrida aceita: cobrança + ETA em inglês', () => {
    expect(pushRideAccepted('en', 41.5, 7)).toEqual({
      title: '💳 Payment confirmed — Driver on the way!',
      body: '$41.50 charged to your card. Arriving in 7 min.',
    });
    expect(pushRideAccepted('en', null, null).body).toBe('Your Executive XL is confirmed. Your driver is on the way!');
  });

  it('português continua idêntico ao texto anterior', () => {
    expect(pushRideCompleted('pt', 41.5)).toEqual({
      title: '🏁 Corrida finalizada!',
      body: 'Valor: $41.50. Avalie o motorista e deixe uma gorjeta! 🌟',
    });
    expect(pushRideAccepted('pt', 41.5, 7).body).toBe('$41.50 cobrado do seu cartão. Chegando em 7 min.');
  });

  it('estorno converte centavos', () => {
    expect(pushRideRefundedNoDriver('en', 4153).body).toContain('$41.53');
    expect(pushRideRefundedNoDriver('es', 4153).body).toContain('$41.53');
  });

  it('destino nulo não vira "null"', () => {
    expect(pushNewRideDirect('en', null, 10).body).not.toContain('null');
  });
});

describe('pushWhen / pushLocale / pushMoney', () => {
  // 31/10/2026 19:30 UTC = 15:30 em Orlando (EDT, UTC-4).
  const ISO = '2026-10-31T19:30:00Z';

  it('locales', () => {
    expect(pushLocale('en')).toBe('en-US');
    expect(pushLocale('es')).toBe('es-US');
    expect(pushLocale('pt')).toBe('pt-BR');
  });

  it('inglês: mês/dia e 12 h, no fuso de Orlando', () => {
    expect(pushWhen(ISO, 'en')).toMatch(/^10\/31 at 3:30\sPM$/u);
  });

  it('português: dia/mês e 24 h, no fuso de Orlando', () => {
    expect(pushWhen(ISO, 'pt')).toBe('31/10 às 15:30');
  });

  it('espanhol: dia/mês, no fuso de Orlando', () => {
    const s = pushWhen(ISO, 'es');
    expect(s).toMatch(/^31\/10 a las /);
    expect(s).toMatch(/3:30/);
  });

  it('meia-noite UTC ainda é o dia anterior em Orlando', () => {
    expect(pushWhen('2026-11-01T02:00:00Z', 'pt')).toBe('31/10 às 22:00');
  });

  it('data ausente ou inválida devolve vazio', () => {
    expect(pushWhen(null, 'en')).toBe('');
    expect(pushWhen('not a date', 'en')).toBe('');
  });

  it('dinheiro', () => {
    expect(pushMoney(41.5)).toBe('$41.50');
    expect(pushMoney(null)).toBe('$0.00');
  });
});
