// splashTimeline — quando a abertura de marca sai da frente.
//
// A parte visual mora em `src/components/BrandSplash.tsx`. Aqui fica a única
// decisão que tem consequência: EM QUE INSTANTE a tela se despede. Ela é pura
// de propósito — é a regra que pode prender o usuário na porta do app, e regra
// assim se testa sem montar componente.
//
// ── O CONFLITO ──────────────────────────────────────────────────────────────
//
// A animação foi desenhada para 8 s. Mas a tela existe ENQUANTO O APP CARREGA,
// e numa abertura morna o app fica pronto em menos de um segundo. Segurar o
// usuário por mais sete segundos para exibir uma animação não é premium: é
// pedágio.
//
// Por outro lado, sair no instante em que o app fica pronto cortaria a marca
// pela metade — o passageiro veria um lampejo dourado e nada mais.
//
// A regra que concilia os dois:
//
//   · nunca sair antes de o lockup estar INTEIRO na tela (PISO);
//   · a partir daí, sair assim que o app estiver pronto;
//   · e sair de todo jeito no TETO, mesmo que o app não tenha ficado pronto —
//     splash não é lugar de esperar rede.
//
// ── POR QUE O TETO NÃO É NEGOCIÁVEL ────────────────────────────────────────
//
// Se `pronto` nunca virar true (falha de auth, rede pendurada, exceção no
// AuthContext), sem o teto a abertura fica para sempre e o app vira uma tela
// de logo bonita e inútil. O teto é o que garante que TODO caminho chega na
// aplicação.

/** Fim da entrada: o lockup completo, com a assinatura já assentada. */
export const PISO_MS = 3450;

/** A animação inteira, como desenhada e aprovada. */
export const TETO_MS = 8000;

/** Duração da saída (sobe 10 px e some). Some ao total percebido. */
export const SAIDA_MS = 1100;

export type EstadoAbertura = {
  /** Começar a saída agora. */
  sair: boolean;
  /**
   * Por que está saindo — só para log/métrica. `null` enquanto não sai.
   *   'pronto' → o app ficou pronto e o piso já tinha passado
   *   'teto'   → estourou o tempo máximo; o app pode não estar pronto
   */
  motivo: 'pronto' | 'teto' | null;
};

/**
 * Decide, a cada quadro, se a abertura deve começar a sair.
 *
 * @param decorridoMs desde que a abertura montou
 * @param pronto      o app terminou de resolver o que precisava (auth)
 * @param antecipar   se false, ignora `pronto` e sempre roda os 8 s inteiros
 */
export function avaliarAbertura(
  decorridoMs: number,
  pronto: boolean,
  antecipar: boolean = true,
): EstadoAbertura {
  // O teto vem primeiro: ele vale mesmo com `antecipar` desligado e mesmo que
  // `pronto` nunca chegue. É a garantia de que sempre se entra no app.
  if (decorridoMs >= TETO_MS) return { sair: true, motivo: 'teto' };

  if (!antecipar) return { sair: false, motivo: null };

  // `>=` e não `>`: no quadro exato do piso, com o app pronto, já pode sair.
  if (pronto && decorridoMs >= PISO_MS) return { sair: true, motivo: 'pronto' };

  return { sair: false, motivo: null };
}

/**
 * Quanto tempo a abertura vai ocupar no total, dado o instante em que o app
 * ficou pronto. Existe para responder "quanto o usuário espera?" sem cronômetro
 * na mão — e é o número que se discute quando alguém achar a abertura longa.
 */
export function duracaoTotalMs(
  prontoEmMs: number,
  antecipar: boolean = true,
): number {
  if (!antecipar) return TETO_MS + SAIDA_MS;
  // Sem piso, um app pronto em 200 ms cortaria a marca no meio da entrada.
  const inicioDaSaida = Math.min(Math.max(prontoEmMs, PISO_MS), TETO_MS);
  return inicioDaSaida + SAIDA_MS;
}
