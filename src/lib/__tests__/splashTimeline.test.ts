import {
  avaliarAbertura,
  duracaoTotalMs,
  PISO_MS,
  TETO_MS,
  SAIDA_MS,
} from '../splashTimeline';

/**
 * A abertura de marca é a tela de maior alcance do app: todo mundo passa por
 * ela, sempre, e antes de conseguir fazer qualquer outra coisa. O defeito que
 * importa aqui não é estético — é a abertura NÃO SAIR e o app virar uma tela
 * de logo bonita e inútil.
 *
 * Por isso o teto é testado por vários caminhos, inclusive os que parecem
 * redundantes: é ele que garante que todo mundo entra.
 */

describe('o piso — não cortar a marca pela metade', () => {
  it('app pronto no primeiro quadro NÃO sai imediatamente', () => {
    expect(avaliarAbertura(0, true).sair).toBe(false);
  });

  it('app pronto continua segurado a um milissegundo do piso', () => {
    expect(avaliarAbertura(PISO_MS - 1, true).sair).toBe(false);
  });

  it('no quadro exato do piso, com o app pronto, sai', () => {
    expect(avaliarAbertura(PISO_MS, true)).toEqual({ sair: true, motivo: 'pronto' });
  });

  it('sem o app pronto, o piso não basta', () => {
    expect(avaliarAbertura(PISO_MS, false).sair).toBe(false);
    expect(avaliarAbertura(PISO_MS + 2000, false).sair).toBe(false);
  });
});

describe('o teto — a garantia de que sempre se entra no app', () => {
  it('sai no teto mesmo com o app NUNCA pronto', () => {
    expect(avaliarAbertura(TETO_MS, false)).toEqual({ sair: true, motivo: 'teto' });
  });

  it('depois do teto continua mandando sair', () => {
    expect(avaliarAbertura(TETO_MS + 5000, false).sair).toBe(true);
  });

  // Este é o caso que um `if (antecipar)` mal colocado quebraria: alguém
  // desliga a antecipação e, sem querer, desliga também a saída.
  it('o teto vale mesmo com a antecipação DESLIGADA', () => {
    expect(avaliarAbertura(TETO_MS, false, false)).toEqual({ sair: true, motivo: 'teto' });
    expect(avaliarAbertura(TETO_MS, true, false).sair).toBe(true);
  });
});

describe('antecipar desligado — os 8 s inteiros, sempre', () => {
  it('ignora o app pronto durante toda a animação', () => {
    for (const t of [0, PISO_MS, PISO_MS + 1, 5000, TETO_MS - 1]) {
      expect(avaliarAbertura(t, true, false).sair).toBe(false);
    }
  });
});

describe('o motivo da saída', () => {
  it('é nulo enquanto não sai', () => {
    expect(avaliarAbertura(1000, false).motivo).toBeNull();
  });

  it('distingue quem terminou de quem estourou', () => {
    expect(avaliarAbertura(PISO_MS + 100, true).motivo).toBe('pronto');
    expect(avaliarAbertura(TETO_MS, false).motivo).toBe('teto');
  });

  // No instante do teto com o app pronto, os dois caminhos servem. O teto
  // ganha porque é o que de fato encerra — e reportar 'pronto' aqui esconderia
  // uma inicialização que passou de 8 segundos.
  it('no empate exato, o teto prevalece', () => {
    expect(avaliarAbertura(TETO_MS, true).motivo).toBe('teto');
  });
});

describe('quanto o usuário espera, no total', () => {
  it('abertura morna: o piso manda, não o carregamento', () => {
    expect(duracaoTotalMs(200)).toBe(PISO_MS + SAIDA_MS);
    expect(duracaoTotalMs(0)).toBe(PISO_MS + SAIDA_MS);
  });

  it('carregamento no meio: quem manda é ele', () => {
    expect(duracaoTotalMs(5000)).toBe(5000 + SAIDA_MS);
  });

  it('carregamento lento é limitado pelo teto', () => {
    expect(duracaoTotalMs(30000)).toBe(TETO_MS + SAIDA_MS);
  });

  it('com antecipar desligado é sempre a peça inteira', () => {
    expect(duracaoTotalMs(200, false)).toBe(TETO_MS + SAIDA_MS);
    expect(duracaoTotalMs(30000, false)).toBe(TETO_MS + SAIDA_MS);
  });

  // O número que decide a discussão "a abertura está longa?".
  it('numa abertura morna são 4,55 s, e não 8', () => {
    expect(duracaoTotalMs(500)).toBe(4550);
  });
});

describe('as constantes têm de fazer sentido entre si', () => {
  it('o piso cabe dentro do teto', () => {
    expect(PISO_MS).toBeGreaterThan(0);
    expect(PISO_MS).toBeLessThan(TETO_MS);
  });

  it('a saída não é maior que a própria animação', () => {
    expect(SAIDA_MS).toBeLessThan(TETO_MS - PISO_MS);
  });
});
