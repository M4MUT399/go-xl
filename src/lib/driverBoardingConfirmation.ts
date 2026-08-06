// driverBoardingConfirmation — regra pura de quando pedir (e permitir) que o
// PASSAGEIRO confirme foto do motorista + placa do veículo antes de embarcar
// (Bloco 4, compliance TNC F.S. 627.748).
//
// DECISÃO DE DESIGN — prompt forte, não bloqueio rígido do embarque: o gatilho
// real de `rides.boarded_at` é a transição de status para 'in_progress',
// disparada pelo MOTORISTA (botão "Cheguei" em DriverNavigateScreen, ver
// migration 0056: trigger `stamp_ride_period_timestamps`). Fazer a confirmação
// do passageiro BLOQUEAR essa transição no servidor exigiria condicionar uma
// trigger já em produção (usada por toda corrida, nos 3 blocos anteriores) ao
// estado de uma tabela nova — risco alto de travar corridas legítimas se o
// passageiro tiver o app fechado/sem internet no momento exato do embarque.
// Em vez disso: a tela do passageiro mostra a confirmação de forma proeminente
// assim que o motorista + veículo são conhecidos (status 'accepted' ou
// 'driver_en_route'), registra o aceite (auditoria/compliance), e — se o
// motorista tentar avançar para 'in_progress' SEM confirmação registrada — o
// app do motorista mostra um aviso extra (não travamento) via
// `boardingWarning`. Documentado para revisão: se o requisito estatutário
// precisar de um bloqueio rígido, isso muda a regra em `stamp_ride_period_timestamps`.

export type BoardingConfirmationInput = {
  /** Subconjunto de RideStatus relevante — evita acoplar este módulo a src/types. */
  rideStatus: 'scheduled' | 'requesting' | 'accepted' | 'driver_en_route' | 'in_progress' | 'completed' | 'cancelled';
  hasDriverAssigned: boolean;
  hasVehicleAssigned: boolean;
  alreadyConfirmed: boolean;
  /** Config `driver_confirmation_required` resolvida pra jurisdição. */
  confirmationRequired: boolean;
};

const CONFIRMABLE_STATUSES: ReadonlySet<BoardingConfirmationInput['rideStatus']> = new Set([
  'accepted',
  'driver_en_route',
]);

/**
 * shouldPromptDriverConfirmation — a tela do passageiro deve mostrar a
 * confirmação de foto+placa agora? Só faz sentido quando já se sabe QUEM é o
 * motorista/veículo (pós-aceite), antes do embarque, e só uma vez por corrida.
 */
export function shouldPromptDriverConfirmation(input: BoardingConfirmationInput): boolean {
  if (!input.confirmationRequired) return false;
  if (input.alreadyConfirmed) return false;
  if (!input.hasDriverAssigned || !input.hasVehicleAssigned) return false;
  return CONFIRMABLE_STATUSES.has(input.rideStatus);
}

export type ConfirmDriverCheck = {
  ok: boolean;
  error?: 'already_confirmed' | 'no_driver_assigned' | 'ride_not_active';
};

/**
 * canConfirmDriver — guarda usada pelo hook/RPC antes de gravar
 * `rides.passenger_confirmed_driver_at`: idempotente (não deixa confirmar
 * duas vezes) e exige corrida em estado ativo com motorista+veículo já
 * atribuídos.
 */
export function canConfirmDriver(input: BoardingConfirmationInput): ConfirmDriverCheck {
  if (input.alreadyConfirmed) return { ok: false, error: 'already_confirmed' };
  if (!input.hasDriverAssigned || !input.hasVehicleAssigned) return { ok: false, error: 'no_driver_assigned' };
  if (!CONFIRMABLE_STATUSES.has(input.rideStatus) && input.rideStatus !== 'in_progress') {
    // Ver "DECISÃO DE DESIGN": aceitar confirmação tardia (já em 'in_progress')
    // é tolerado — o passageiro pode ter demorado a tocar o botão — mas nunca
    // depois de completed/cancelled/scheduled/requesting.
    return { ok: false, error: 'ride_not_active' };
  }
  return { ok: true };
}

export type BoardingWarning = 'none' | 'unconfirmed';

/**
 * boardingWarning — o app do MOTORISTA deve mostrar um aviso extra antes de
 * avançar para 'in_progress' (embarque) porque o passageiro ainda não
 * confirmou a identidade? Não bloqueia (ver "DECISÃO DE DESIGN" no topo) — só
 * informa, para o motorista poder pedir ao passageiro que confirme na tela
 * dele antes de seguir.
 */
export function boardingWarning(input: BoardingConfirmationInput): BoardingWarning {
  if (!input.confirmationRequired) return 'none';
  if (input.alreadyConfirmed) return 'none';
  return 'unconfirmed';
}
