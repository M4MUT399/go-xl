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
 * Cancelar é SEMPRE possível. O que muda é o preço, e ele depende de DUAS
 * coisas — o relógio e a existência de um motorista comprometido:
 *
 *   • mais de 1 hora antes do horário marcado → grátis;
 *   • dentro da última hora, COM motorista já confirmado → tarifa integral;
 *   • dentro da última hora, SEM motorista confirmado    → grátis.
 *
 * O motorista entra na regra porque a multa é COMPENSAÇÃO, não receita. É o que
 * a própria tela promete ao passageiro: `scheduled.policyChargedBody1` diz "um
 * motorista já confirmou esta corrida" e `policyChargedBody3`, "como
 * compensação". Cobrar quando ninguém aceitou o agendamento seria receita da
 * plataforma sem ninguém para compensar, com um texto na tela afirmando o
 * contrário — o caminho mais curto para uma disputa de cartão.
 *
 * ── O SINAL DE "CONFIRMADO" É `accepted_at`, NÃO `driver_id` ───────────────
 *
 * Os dois não são a mesma coisa, e usar o errado cobraria gente à toa: um
 * agendamento travado por QR NASCE com `driver_id` preenchido e `accepted_at`
 * nulo — o motorista foi pré-vinculado pelo código dele, mas ainda não viu nem
 * aceitou. É por isso que o lado do motorista procura exatamente por
 * `.is('accepted_at', null)` para achar o que falta confirmar, e por que
 * `rejectScheduledRide` devolve o `driver_id` para nulo.
 *
 * `accepted_at` é o instante em que alguém se comprometeu a buscar. Antes dele
 * não há ninguém para compensar.
 *
 * A janela é do PRODUTO, não do servidor: quem a aplica é o app. O servidor
 * aceita o cancelamento em qualquer momento (`useRide.cancelScheduledRide` só
 * exige que a corrida não esteja concluída/cancelada). Isso está escrito aqui
 * para que ninguém leia `FREE_WINDOW_MIN` e conclua que o banco a impõe.
 *
 * A COBRANÇA em si mora em `useRide.cancelScheduledRideWithPolicy`, que cancela
 * ANTES de cobrar de propósito — o porquê está escrito lá.
 */

/** Antecedência mínima, em minutos, para o cancelamento sair de graça. */
export const FREE_WINDOW_MIN = 60;

const MIN_MS = 60_000;

export type CancellationPolicy =
  | { free: true; minutesUntil: number }
  | { free: false; minutesUntil: number; chargeDollars: number };

/** O mínimo que a regra precisa enxergar de uma corrida. */
export interface CancellableRide {
  scheduled_for?: string | null;
  price?: number | null;
  /** Instante em que um motorista ACEITOU. Nulo = ninguém se comprometeu ainda. */
  accepted_at?: string | null;
}

/**
 * Existe um motorista COMPROMETIDO com este agendamento?
 *
 * Só `accepted_at` responde. Ver o cabeçalho: `driver_id` sozinho inclui o
 * agendamento travado por QR, em que o motorista foi pré-vinculado e ainda não
 * aceitou nada.
 */
export function hasConfirmedDriver(ride: CancellableRide): boolean {
  return !!ride.accepted_at;
}

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
  ride: CancellableRide,
  nowMs: number,
): CancellationPolicy {
  const alvo = ride.scheduled_for ? Date.parse(ride.scheduled_for) : NaN;
  if (!Number.isFinite(alvo)) return { free: true, minutesUntil: Infinity };

  const minutesUntil = (alvo - nowMs) / MIN_MS;
  if (minutesUntil > FREE_WINDOW_MIN) return { free: true, minutesUntil };

  // Dentro da última hora, mas ninguém aceitou: não há quem compensar, e a tela
  // estaria dizendo "um motorista já confirmou" para justificar a cobrança.
  if (!hasConfirmedDriver(ride)) return { free: true, minutesUntil };

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
