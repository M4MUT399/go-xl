import {
  DRIVER_FIX_MAX_AGE_MS,
  cortePorFrescorIso,
  fixEstaFresco,
} from '../driverFreshness';

/**
 * A JANELA É REQUISITO, NÃO GOSTO.
 *
 * Ela existe porque `is_online` é um espelho que ninguém apaga quando o app
 * morre. Em 02/09/2026, das 8 linhas de `driver_locations` em produção, 7
 * diziam `true` e 6 estavam paradas havia entre 8 e 55 dias.
 *
 * Dois riscos opostos, e os testes cobrem os dois lados:
 *   • curta demais derruba motorista VIVO parado (fila do MCO, iOS ignorando
 *     `timeInterval`) — e isso custa a corrida;
 *   • longa demais toca o telefone de fantasma — e isso custa incômodo.
 *
 * O relógio é injetado em todos os casos: teste de tempo que depende de
 * `Date.now()` real falha sozinho de madrugada.
 */

const AGORA = Date.parse('2026-09-02T12:00:00.000Z');

describe('a janela', () => {
  it('são 10 minutos', () => {
    expect(DRIVER_FIX_MAX_AGE_MS).toBe(10 * 60 * 1000);
  });

  // Se este casar com outro número, o mapa do passageiro (nearby_online_drivers,
  // 0069:646) e o despacho passam a discordar sobre quem existe.
  it('o corte é exatamente agora menos a janela, em ISO', () => {
    expect(cortePorFrescorIso(AGORA)).toBe('2026-09-02T11:50:00.000Z');
  });
});

describe('fixEstaFresco espelha o .gt do PostgREST', () => {
  it('aceita um fix de um minuto atrás', () => {
    expect(fixEstaFresco('2026-09-02T11:59:00.000Z', AGORA)).toBe(true);
  });

  it('recusa um fix de onze minutos atrás', () => {
    expect(fixEstaFresco('2026-09-02T11:49:00.000Z', AGORA)).toBe(false);
  });

  // `gt` é ESTRITO. Um fix exatamente na borda NÃO passa — e o helper precisa
  // concordar com a query, senão o teste diz uma coisa e o banco faz outra.
  it('recusa o fix exatamente na borda dos 10 minutos', () => {
    expect(fixEstaFresco(cortePorFrescorIso(AGORA), AGORA)).toBe(false);
  });

  it('aceita um milissegundo depois da borda', () => {
    expect(fixEstaFresco('2026-09-02T11:50:00.001Z', AGORA)).toBe(true);
  });
});

describe('entrada podre não vira motorista presente', () => {
  // Linha sem carimbo legível é fantasma. O lado seguro do erro é não tocar o
  // telefone de quem não está lá.
  it.each([null, undefined, '', 'ontem', '2026-13-45T99:99:99Z'])(
    'recusa %p',
    (v) => {
      expect(fixEstaFresco(v as string | null | undefined, AGORA)).toBe(false);
    },
  );
});

describe('os fantasmas reais de 02/09/2026', () => {
  // Estes são os carimbos que o relatório de produção devolveu. Nenhum deles
  // pode entrar no leque de push.
  const fantasmas = [
    '2026-08-25T20:07:32.262Z', // Fabricio   — 8 dias
    '2026-07-16T18:20:40.256Z', // Teste 2    — 48 dias
    '2026-07-15T19:16:51.965Z', // Cristiane  — 49 dias
    '2026-07-09T22:49:18.635Z', // Edson Teste — 55 dias
  ];
  const vivos = [
    '2026-09-02T19:29:49.788Z', // Interplace
    '2026-09-02T19:29:16.094Z', // Edson
  ];
  const depois = Date.parse('2026-09-02T19:32:00.000Z');

  it.each(fantasmas)('exclui o fix de %s', (t) => {
    expect(fixEstaFresco(t, depois)).toBe(false);
  });

  it.each(vivos)('mantém o fix de %s', (t) => {
    expect(fixEstaFresco(t, depois)).toBe(true);
  });
});

describe('leque do push: raio de 50 milhas e janela de 12 h (26/10/2026)', () => {
  const { dentroDoRaio, cortePushIso, DISPATCH_RADIUS_KM } = jest.requireActual('../driverFreshness');
  const mco = { lat: 28.4312, lng: -81.3081 };

  it('o raio é 50 milhas', () => {
    expect(DISPATCH_RADIUS_KM).toBeCloseTo(80.467, 2);
  });

  it('motorista em Kissimmee (~25 km) entra; em Tampa (~130 km) fica de fora', () => {
    expect(dentroDoRaio(mco, { lat: 28.2920, lng: -81.4076 })).toBe(true);
    expect(dentroDoRaio(mco, { lat: 27.9506, lng: -82.4572 })).toBe(false);
  });

  it('sem coordenada de um dos lados, o motorista fica no leque', () => {
    expect(dentroDoRaio({ lat: null, lng: null }, { lat: 27.9, lng: -82.4 })).toBe(true);
    expect(dentroDoRaio(mco, { lat: null, lng: null })).toBe(true);
    expect(dentroDoRaio(null, { lat: 27.9, lng: -82.4 })).toBe(true);
  });

  it('a janela do push é de 12 h', () => {
    const agora = Date.parse('2026-10-26T12:00:00Z');
    expect(cortePushIso(agora)).toBe('2026-10-26T00:00:00.000Z');
  });
});
