/**
 * Regra de cancelamento de corrida AGENDADA pelo passageiro, num lugar só.
 *
 * ── POR QUE ESTE ARQUIVO EXISTE ─────────────────────────────────────────────
 *
 * A regra morava inline na `ScheduledRidesScreen`, numa função de três linhas
 * usada só ali. O efeito é o que sempre acontece com regra sem casa: a OUTRA
 * tela por onde o passageiro chega no mesmo agendamento — `TripDetailsScreen`,
 * aberta pela aba de histórico com o filtro "Agendadas" — não tinha
 * cancelamento nenhum. Só "Falar com o suporte".
 *
 * Foi um caso real, relatado com print: agendamento para 08/09 às 8h30, aberto
 * pelo histórico, e nenhum caminho para cancelar naquela tela. O passageiro que
 * não soubesse do ícone 🗓️ na home concluiria que não dá para cancelar.
 *
 * ── A REGRA (pedido do produto) ─────────────────────────────────────────────
 *
 * Cancelar é SEMPRE possível. O que muda com o relógio é o preço:
 *
 *   • mais de 1 hora antes do horário marcado → grátis;
 *   • dentro da última hora                   → a tarifa é cobrada integralmente.
 *
 * A janela é do PRODUTO, não do servidor: quem a aplica é o app. O servidor
 * aceita o cancelamento em qualquer momento (`useRide.cancelScheduledRide` só
 * exige que a corrida não esteja concluída/cancelada). Isso está escrito aqui
 * para que ninguém leia `FREE_WINDOW_MIN` e conclua que o banco a impõe.
 *
 * ⚠️ E MAIS IMPORTANTE: a COBRANÇA da tarifa no cancelamento tardio hoje NÃO
 * ACONTECE. O app avisa que vai cobrar e depois só muda o status para
 * 'cancelled' — nenhuma ida ao `charge-ride`. Ou seja, a metade cara da regra é
 * anunciada e não executada, e quem paga essa conta é o motorista que já estava
 * a caminho. Ligar a cobrança é uma mudança de pagamento com consequência real
 * (dinheiro saindo do cartão num toque de botão) e precisa de decisão explícita
 * do dono — por isso está declarado aqui em vez de ser feito de passagem.
 */

/** Antecedência mínima, em minutos, para o cancelamento sair de graça. */
export const FREE_WINDOW_MIN = 60;

const MIN_MS = 60_000;

export type CancellationPolicy =
  | { free: true; minutesUntil: number }
  | { free: false; minutesUntil: number; chargeDollars: number };

/**
 * Quanto custa cancelar este agendamento AGORA?
 *
 * `nowMs` entra por parâmetro em vez de `Date.now()` por dentro: uma regra que
 * depende do relógio e o lê sozinha não tem como ser testada na borda, e a
 * borda — o minuto 60 — é justamente o que importa.
 *
 * Sem horário legível o cancelamento é GRÁTIS. É a direção segura do erro: um
 * agendamento sem `scheduled_for` é dado faltando, e cobrar a tarifa cheia de
 * alguém por causa de uma coluna nula seria transformar defeito nosso em conta
 * do passageiro.
 */
export function cancellationPolicy(
  ride: { scheduled_for?: string | null; price?: number | null },
  nowMs: number,
): CancellationPolicy {
  const alvo = ride.scheduled_for ? Date.parse(ride.scheduled_for) : NaN;
  if (!Number.isFinite(alvo)) return { free: true, minutesUntil: Infinity };

  const minutesUntil = (alvo - nowMs) / MIN_MS;
  if (minutesUntil > FREE_WINDOW_MIN) return { free: true, minutesUntil };

  return { free: false, minutesUntil, chargeDollars: Number(ride.price) || 0 };
}

/**
 * Este agendamento ainda pode ser cancelado pelo passageiro?
 *
 * Só o STATUS decide. Corrida já concluída ou já cancelada não tem o que
 * cancelar; passado o horário, ela continua cancelável — um agendamento que
 * ninguém veio atender é exatamente o que mais precisa de uma saída.
 */
export function canCancelSchedule(ride: { status?: string | null }): boolean {
  return ride.status === 'scheduled';
}
