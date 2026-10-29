/**
 * Regras da gorjeta retroativa.
 *
 * O que estes testes precisam provar, e por quê:
 *
 *   · a corrida do caso real — CONCLUÍDA e NÃO PAGA — aceita gorjeta. É o
 *     ponto inteiro do conserto; se um teste algum dia passar a exigir
 *     `paid = true`, o motorista volta a perder a gorjeta por um defeito da
 *     plataforma;
 *   · a borda do prazo é exercitada nos dois lados do instante, não "muito
 *     dentro" e "muito fora" — uma regra de janela testada só longe da borda
 *     não prova nada sobre a borda;
 *   · vírgula decimal é lida como decimal. `parseFloat('7,50')` devolve 7, e
 *     isso cobraria $7 de quem quis dar $7,50 — em pt-BR e es-419 é o formato
 *     que a pessoa digita.
 */

import {
  TIP_MAX_DOLLARS,
  TIP_MIN_DOLLARS,
  TIP_PRESETS,
  TIP_WINDOW_DAYS,
  isTipAmountValid,
  parseTipInput,
  tipEligibility,
  toTipCents,
} from '../tip';
import { RideRecord } from '../../types';

const DIA = 24 * 60 * 60 * 1000;
const CONCLUIDA_EM = Date.parse('2026-08-20T16:30:00.000Z');

type Alvo = Pick<RideRecord, 'status' | 'tip_amount' | 'completed_at' | 'created_at'>;

const corrida = (over: Partial<Alvo> = {}): Alvo => ({
  status: 'completed',
  tip_amount: undefined,
  completed_at: new Date(CONCLUIDA_EM).toISOString(),
  created_at: new Date(CONCLUIDA_EM - 20 * 60 * 1000).toISOString(),
  ...over,
});

describe('tipEligibility', () => {
  it('aceita gorjeta numa corrida concluída e ainda sem gorjeta', () => {
    const r = tipEligibility(corrida(), CONCLUIDA_EM + DIA);
    expect(r.canTip).toBe(true);
  });

  it('aceita mesmo com a TARIFA não cobrada — é o caso que originou o conserto', () => {
    // `paid` nem entra na regra. Este teste existe para que a ausência dele
    // seja deliberada e visível, não um esquecimento que alguém "conserta"
    // depois acrescentando a checagem.
    const r = tipEligibility({ ...corrida(), ...({ paid: false } as object) }, CONCLUIDA_EM + DIA);
    expect(r.canTip).toBe(true);
  });

  it.each(['cancelled', 'requesting', 'accepted', 'in_progress', 'scheduled'] as const)(
    'recusa corrida com status %s',
    (status) => {
      const r = tipEligibility(corrida({ status: status as RideRecord['status'] }), CONCLUIDA_EM);
      expect(r).toEqual({ canTip: false, reason: 'not_completed' });
    },
  );

  it('recusa quando já existe gorjeta', () => {
    const r = tipEligibility(corrida({ tip_amount: 10 }), CONCLUIDA_EM);
    expect(r).toEqual({ canTip: false, reason: 'already_tipped' });
  });

  it('trata gorjeta zero ou negativa como ausência de gorjeta', () => {
    expect(tipEligibility(corrida({ tip_amount: 0 }), CONCLUIDA_EM).canTip).toBe(true);
    expect(tipEligibility(corrida({ tip_amount: -1 }), CONCLUIDA_EM).canTip).toBe(true);
  });

  describe('a borda do prazo', () => {
    const prazo = CONCLUIDA_EM + TIP_WINDOW_DAYS * DIA;

    it('aceita UM MILISSEGUNDO antes de vencer', () => {
      expect(tipEligibility(corrida(), prazo - 1).canTip).toBe(true);
    });

    it('aceita EXATAMENTE no instante do vencimento', () => {
      expect(tipEligibility(corrida(), prazo).canTip).toBe(true);
    });

    it('recusa UM MILISSEGUNDO depois', () => {
      expect(tipEligibility(corrida(), prazo + 1)).toEqual({
        canTip: false,
        reason: 'window_closed',
      });
    });

    it('devolve o instante do prazo, para a tela poder dizê-lo', () => {
      const r = tipEligibility(corrida(), CONCLUIDA_EM);
      expect(r.canTip && r.deadlineMs).toBe(prazo);
    });
  });

  describe('o prazo em dias ABSOLUTOS', () => {
    /*
     * Os testes de borda acima derivam o instante de `TIP_WINDOW_DAYS`, então
     * acompanham qualquer valor que a constante assuma — inclusive um absurdo.
     * Foi um mutante que SOBREVIVEU à primeira versão desta suíte: trocar o
     * prazo por 99999 dias não reprovou nada, e a regra de produto tinha
     * deixado de existir sem um único teste vermelho. É teste circular, o
     * defeito que o item 6 da auditoria existe para eliminar.
     *
     * Estes dois números são fixos de propósito. Mudar o prazo passa a exigir
     * mudar um teste — que é o ponto: uma regra de negócio não deveria poder
     * mudar em silêncio.
     */
    it('30 dias depois, não aceita mais', () => {
      expect(tipEligibility(corrida(), CONCLUIDA_EM + 30 * DIA).canTip).toBe(false);
    });

    it('1 dia depois, ainda aceita', () => {
      expect(tipEligibility(corrida(), CONCLUIDA_EM + DIA).canTip).toBe(true);
    });
  });

  it('usa created_at quando completed_at falta, em vez de recusar', () => {
    // Recusar por dado faltando transformaria uma coluna nula em dinheiro que
    // o motorista não recebe.
    const semConclusao = corrida({ completed_at: undefined });
    const marco = Date.parse(semConclusao.created_at);
    expect(tipEligibility(semConclusao, marco + DIA).canTip).toBe(true);
    expect(tipEligibility(semConclusao, marco + (TIP_WINDOW_DAYS + 1) * DIA).canTip).toBe(false);
  });

  it('recusa quando não há marco de tempo algum', () => {
    const r = tipEligibility(
      { status: 'completed', tip_amount: undefined, completed_at: undefined, created_at: '' },
      CONCLUIDA_EM,
    );
    expect(r).toEqual({ canTip: false, reason: 'window_closed' });
  });

  it('recusa data ilegível em vez de virar NaN e aceitar tudo', () => {
    const r = tipEligibility(corrida({ completed_at: 'ontem à tarde' }), CONCLUIDA_EM);
    expect(r).toEqual({ canTip: false, reason: 'window_closed' });
  });

  it('a ordem das recusas não esconde a mais informativa', () => {
    // Corrida cancelada E já gorjetada E fora do prazo: o motivo útil para a
    // tela é o status, que é o que o passageiro consegue entender.
    const r = tipEligibility(
      corrida({ status: 'cancelled', tip_amount: 5 }),
      CONCLUIDA_EM + 999 * DIA,
    );
    expect(r).toEqual({ canTip: false, reason: 'not_completed' });
  });
});

describe('parseTipInput', () => {
  it('lê ponto decimal', () => {
    expect(parseTipInput('7.50')).toBe(7.5);
  });

  it('lê VÍRGULA decimal — pt-BR e es-419 digitam assim', () => {
    expect(parseTipInput('7,50')).toBe(7.5);
  });

  it('ignora espaços em volta', () => {
    expect(parseTipInput('  12  ')).toBe(12);
  });

  it.each(['', '   ', 'abc', '-'])('devolve null para %p', (texto) => {
    expect(parseTipInput(texto)).toBeNull();
  });
});

describe('isTipAmountValid', () => {
  it('aceita o mínimo exato da tip-ride', () => {
    expect(isTipAmountValid(TIP_MIN_DOLLARS)).toBe(true);
  });

  it('recusa um centavo abaixo do mínimo', () => {
    expect(isTipAmountValid(TIP_MIN_DOLLARS - 0.01)).toBe(false);
  });

  it('aceita o teto exato', () => {
    expect(isTipAmountValid(TIP_MAX_DOLLARS)).toBe(true);
  });

  it('recusa acima do teto', () => {
    expect(isTipAmountValid(TIP_MAX_DOLLARS + 0.01)).toBe(false);
  });

  it.each([NaN, Infinity, -5, 0])('recusa %p', (v) => {
    expect(isTipAmountValid(v)).toBe(false);
  });
});

describe('toTipCents', () => {
  it('converte para centavos inteiros', () => {
    expect(toTipCents(7.5)).toBe(750);
  });

  it('arredonda o erro binário em vez de mandar fração ao Stripe', () => {
    // 0.1 + 0.2 = 0.30000000000000004; sem o round isto viraria 30.000000000000004
    expect(toTipCents(0.1 + 0.2)).toBe(30);
    expect(Number.isInteger(toTipCents(19.99))).toBe(true);
  });
});

describe('os presets cabem nas regras', () => {
  it('todo preset é um valor que a tip-ride aceita', () => {
    for (const p of TIP_PRESETS) {
      expect(isTipAmountValid(p)).toBe(true);
    }
  });
});
