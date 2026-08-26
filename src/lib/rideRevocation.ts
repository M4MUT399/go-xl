// rideRevocation — regra PURA que decide o que um motorista deve fazer ao
// receber um evento de "revogação de oferta de corrida" (Tarefas 3 e 4).
//
// Mecanismo único: quando uma oferta deixa de ser válida — porque outro
// motorista aceitou ('taken'), o passageiro cancelou ('cancelled') ou o
// agendamento venceu ('expired') — o servidor/cliente emite UM evento
// `ride_offer_revoked` no canal compartilhado `ride-offers`. Cada motorista
// avalia esse evento contra o próprio estado e decide, de forma determinística:
//   • limpar o card de chamada pendente (parando o som na hora);
//   • limpar o card de agendamento pendente;
//   • encerrar a corrida ATIVA (só no caso de cancelamento pelo passageiro de
//     uma corrida que este motorista já havia aceitado).
//
// Isolado de React/Supabase de propósito: pura e testável sem mocks — o hook
// useDriverRide apenas aplica os efeitos que esta função descreve.

/** Motivo pelo qual uma oferta de corrida foi revogada (Tarefas 3 e 4). */
export type RideRevokeReason = 'taken' | 'cancelled' | 'expired';

/** Estado relevante do motorista no momento em que o evento chega. */
export type DriverOfferState = {
  /** ID deste motorista — usado para ignorar o eco do próprio aceite. */
  driverId: string;
  /** Corrida imediata em oferta (card + som de chamada), se houver. */
  pendingRideId: string | null;
  /** Corrida agendada em oferta (popup), se houver. */
  pendingScheduledRideId: string | null;
  /** Corrida que este motorista já aceitou e está conduzindo, se houver. */
  activeRideId: string | null;
};

/** Evento recebido no canal `ride-offers`. */
export type RevocationEvent = {
  rideId?: string;
  /** Motorista que aceitou (só em 'taken') — para não se auto-limpar. */
  by?: string;
  reason: RideRevokeReason;
};

/** Efeitos que o hook deve aplicar. Tudo `false` = evento irrelevante. */
export type RevocationActions = {
  /** Remover o card/som da corrida imediata pendente. */
  clearPendingRide: boolean;
  /** Remover o card da corrida agendada pendente. */
  clearPendingScheduledRide: boolean;
  /** Encerrar a corrida ativa (cancelamento pelo passageiro após aceite). */
  endActiveRide: boolean;
  /** Registrar auditoria 'taken_by_other' para a corrida imediata. */
  logTakenByOther: boolean;
};

const NO_ACTION: RevocationActions = {
  clearPendingRide: false,
  clearPendingScheduledRide: false,
  endActiveRide: false,
  logTakenByOther: false,
};

/**
 * Decide, de forma determinística, o que fazer com um evento de revogação.
 *
 * Regras:
 *   • Sem rideId → ignora.
 *   • reason 'taken' emitido POR este próprio motorista → ignora (é o eco do
 *     seu aceite; ele não deve limpar a própria corrida recém-aceita).
 *   • Se a corrida revogada é a imediata pendente → limpa o card (para o som) e
 *     marca para auditar 'taken_by_other'.
 *   • Se é a agendada pendente → limpa o popup.
 *   • Se reason 'cancelled' e a corrida revogada é a ATIVA deste motorista →
 *     encerra a corrida ativa (passageiro cancelou depois do aceite).
 */
export function resolveRevocation(
  event: RevocationEvent,
  state: DriverOfferState
): RevocationActions {
  const { rideId, by, reason } = event;
  if (!rideId) return NO_ACTION;
  // O eco do próprio aceite não deve limpar nada deste motorista.
  if (reason === 'taken' && by === state.driverId) return NO_ACTION;

  const clearPendingRide = rideId === state.pendingRideId;
  const clearPendingScheduledRide = rideId === state.pendingScheduledRideId;
  const endActiveRide = reason === 'cancelled' && rideId === state.activeRideId;

  return {
    clearPendingRide,
    clearPendingScheduledRide,
    endActiveRide,
    logTakenByOther: clearPendingRide,
  };
}

/** Como o som/vibração desta oferta deve ser encerrado. */
export type OfferAlertReason = 'taken' | 'expired' | 'revoked';

export type OfferSilenceInput = {
  reason: RideRevokeReason;
  /** Flag de múltiplas ofertas simultâneas ligada. */
  multiOffer: boolean;
  /** Com multiOffer, a oferta revogada está na fila (cabeça OU cauda). */
  offerInQueue: boolean;
  /** `clearPendingRide` de `resolveRevocation` — só enxerga a CABEÇA. */
  clearPendingRide: boolean;
  /** Esta revogação (rideId+reason) já foi processada nesta sessão. */
  alreadyHandled: boolean;
};

export type OfferSilenceDecision = {
  /** Parar som/vibração/watchdog, fechar o card e dispensar a notificação. */
  silenceThisOffer: boolean;
  /** Motivo a passar para o gerenciador de alerta. */
  alertReason: OfferAlertReason;
  /** Auditar 'taken_by_other' — só na PRIMEIRA vez. */
  logTakenByOther: boolean;
};

/**
 * Decide se ESTA oferta deve ser silenciada, e com que motivo.
 *
 * Vivia embutido no callback de broadcast do `useRide`, onde não havia como
 * testá-lo sem montar o hook inteiro com Realtime falso — e um teste desses
 * prova o mock, não a regra.
 *
 * Duas regras que não são óbvias e por isso existem aqui:
 *
 *   • `resolveRevocation` só compara com `pendingRideId`, que é a CABEÇA da
 *     fila. Com múltiplas ofertas simultâneas a revogada pode estar na CAUDA:
 *     nesse modo quem manda é a presença na fila, não a cabeça. Usar só a
 *     cabeça deixaria uma oferta já dada a outro motorista tocando na cauda.
 *
 *   • `broadcastRideRevoked` emite DOIS eventos no aceite (`ride_offer_revoked`
 *     e o `ride_taken` legado). Silenciar duas vezes é inofensivo — é
 *     idempotente — mas AUDITAR duas vezes contaria a mesma perda de corrida
 *     em dobro. Por isso o dedupe vale para o log e não para o silenciamento:
 *     se o segundo evento chegar depois de um card ter voltado, ele ainda deve
 *     conseguir calar o som.
 */
export function decideOfferSilence(input: OfferSilenceInput): OfferSilenceDecision {
  const { reason, multiOffer, offerInQueue, clearPendingRide, alreadyHandled } = input;

  const silenceThisOffer = multiOffer ? offerInQueue : clearPendingRide;

  return {
    silenceThisOffer,
    alertReason: reason === 'taken' ? 'taken' : reason === 'expired' ? 'expired' : 'revoked',
    logTakenByOther: silenceThisOffer && !alreadyHandled,
  };
}
