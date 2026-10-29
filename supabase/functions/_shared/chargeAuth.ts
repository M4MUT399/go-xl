// DECISÃO PURA de "quem pode disparar a cobrança DESTA corrida" — sem I/O, sem
// globais do Deno (mesmo padrão de _shared/chargeCycle.ts e
// _shared/staleRideSweep.ts: roda igual na Edge Function e no Jest do app).
//
// ─────────────────────────────────────────────────────────────────────────────
// O BURACO QUE ISTO FECHA
// ─────────────────────────────────────────────────────────────────────────────
// `charge-ride` precisa deixar um motorista cobrar uma corrida que ainda NÃO é
// dele, porque `acceptRide` cobra ANTES de a corrida virar dele de propósito: se
// o cartão recusa, a corrida não é tomada.
//
// A carve-out que sustenta isso — "é motorista E a corrida está `requesting` sem
// dono" — é, sozinha, QUALQUER MOTORISTA COBRA QUALQUER CORRIDA ABERTA. Como
// qualquer pessoa se cadastra como motorista, isso é uma cobrança off-session no
// cartão salvo de um passageiro qualquer, disparável à vontade e em escala.
//
// ─────────────────────────────────────────────────────────────────────────────
// DUAS TENTATIVAS ANTERIORES, E POR QUE AS DUAS ESTAVAM ERRADAS
// ─────────────────────────────────────────────────────────────────────────────
// 1ª) exigir oferta viva em `ride_offers`, mas atrás de `dispatch_engine_v2`:
//
//        if (isAcceptingDriver && await isConfigFlagEnabled(admin, 'dispatch_engine_v2'))
//
//     A flag tem default `false` (src/lib/systemConfig.ts:172) e NENHUMA
//     migration a liga (0054:5). O `&&` curto-circuitava e a exigência nunca
//     rodava. Uma autorização que só vale quando uma flag desligada estiver
//     ligada não é uma autorização.
//
// 2ª) exigir prova em `ride_push_offers`, gravada pelo `send-ride-push` no
//     broadcast. A prova era escrita pelo servidor, sim — mas sobre a LISTA DE
//     IDS QUE O CLIENTE MANDOU, e essa lista era "todo mundo com
//     driver_locations.is_online = true". Duas consequências, ambas reais:
//
//       • autorizava uma MULTIDÃO: cada motorista online no instante do pedido
//         ganhava direito de cobrança off-session sobre o cartão daquele
//         passageiro por 2 h;
//       • e RECUSAVA legítimos: o conjunto ofertado (assinatura realtime, gated
//         só por `driverId`) e o conjunto provado (`is_online` naquele instante)
//         eram derivados de fontes diferentes e discordavam. Pior: corrida
//         pedida sem ninguém online nascia com ZERO prova, e o motorista que
//         entrasse um minuto depois via o card e era recusado com 403 para
//         SEMPRE — corrida morta até a varredura estornar aos 30 min.
//
//     O erro de fundo é o mesmo nos dois casos: derivar a autorização de um
//     INSTANTÂNEO tirado no momento do pedido, e por uma lista que veio do
//     cliente.
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE MUDA: ELEGIBILIDADE DERIVADA NO SERVIDOR, NA HORA DO ACEITE
// ─────────────────────────────────────────────────────────────────────────────
// A pergunta deixa de ser "esta corrida foi oferecida a este motorista lá
// atrás?" e passa a ser "este chamador PODE assumir esta corrida AGORA?":
//
//   • a corrida está `requesting` e sem `driver_id` (já era exigido);
//   • o chamador é `profiles.type = 'driver'`;
//   • a conta Connect dele está habilitada (`stripe_charges_enabled` E
//     `stripe_payouts_enabled`) — a MESMA barreira que a 0038/0059 impõem para
//     ele poder sequer ficar online, e que ele NÃO consegue escrever sozinho: a
//     0065:1290-1294 reverte qualquer escrita dessas colunas vinda do cliente.
//     Quem passa por aqui completou onboarding/KYC de verdade no Stripe;
//   • `driver_can_go_online(driver)` (0059/0060) não o reprova — verificação de
//     identidade, background check, disclosure e suspensão de tolerância zero.
//     A função é permissiva quando as flags de rollout estão desligadas, então
//     ela não recusa ninguém hoje; é o lugar certo para esses gates amanhã.
//
// E a EXCLUSIVIDADE não vem mais de uma tabela de prova: vem de uma RESERVA
// ATÔMICA (`update rides set driver_id = <chamador> where id = <corrida> and
// driver_id is null`) feita ANTES da ida ao Stripe, com compensação que a
// devolve se a cobrança não se concretizar — o mesmo par claim/undoClaim que a
// varredura já usa (_shared/refundFlow.ts:229-243). Quem perde a disputa não
// cobra nada, e a corrida não fica presa a quem não pagou.
//
// ─────────────────────────────────────────────────────────────────────────────
// O QUE ISTO **NÃO** É
// ─────────────────────────────────────────────────────────────────────────────
// Não é uma prova de que o servidor ofereceu a corrida áquele motorista — essa
// prova continua sendo gravada em `ride_push_offers` (0070) pelo
// `send-ride-push`, agora sobre a lista derivada NO SERVIDOR, mas como
// AUDITORIA: ela responde "para quem tocou o telefone?", e não decide mais
// cobrança nenhuma. Um motorista habilitado e não suspenso que veja a corrida
// pelo realtime pode aceitá-la mesmo que o push nunca tenha saído para ele.
// Essa é exatamente a recusa indevida que a rodada anterior introduziu.
//
// `is_online` de propósito NÃO entra nesta decisão: é um espelho mantido pelo
// CLIENTE (DriverRideContext.tsx:115-140), some quando o app é morto, e o
// próprio motorista pode escrevê-lo (a RLS de `driver_locations` é
// `auth.uid() = driver_id`) — ou seja, ele não barra atacante nenhum e recusa
// motorista legítimo com linha velha. Era a fonte do defeito acima.

/** Fatos sobre o chamador e a corrida. Tudo já lido do banco pelo chamador. */
export interface ChargeAuthFacts {
  /** O chamador é o passageiro desta corrida (ativação de agendada). */
  isPassenger: boolean;
  /** A corrida já tem `driver_id` e é o chamador (rede de segurança da conclusão). */
  isRideDriver: boolean;
  /** `profiles.is_admin` do chamador (operador de exceção, como no refund-ride). */
  isAdmin: boolean;
  /** `profiles.type === 'driver'`. */
  isDriver: boolean;
  /** `rides.status`. */
  rideStatus: string | null;
  /** A corrida tem `driver_id`? */
  hasDriver: boolean;
  /**
   * O SERVIDOR verificou, AGORA, que este motorista pode assumir corrida?
   * (conta Connect habilitada + `driver_can_go_online`). `null` = não foi
   * consultado, porque nem chegou a ser o caso de um motorista aceitando.
   */
  driverEligible: boolean | null;
}

export type ChargeAuthDecision =
  | {
      allowed: true;
      reason: 'passenger' | 'ride_driver' | 'admin' | 'accepting_driver';
      /**
       * Só o motorista que está ACEITANDO precisa reservar a corrida antes de a
       * cobrança sair. As demais autorizações agem sobre corrida que já tem dono
       * (ou sobre o próprio cartão), então não há o que reservar.
       */
      requiresClaim: boolean;
    }
  | { allowed: false; code: 'not_a_party' | 'ride_not_open' | 'driver_not_eligible' };

/**
 * O chamador é um motorista tentando ACEITAR uma corrida ainda sem dono?
 *
 * Separado porque a Edge Function precisa saber disto ANTES de decidir: só neste
 * caso vale a pena ir ao banco levantar a elegibilidade.
 */
export function isAcceptingDriverCase(facts: {
  isPassenger: boolean;
  isRideDriver: boolean;
  isDriver: boolean;
  rideStatus: string | null;
  hasDriver: boolean;
}): boolean {
  if (facts.isPassenger || facts.isRideDriver) return false;
  return facts.isDriver && !facts.hasDriver && facts.rideStatus === 'requesting';
}

/**
 * Decide. A ORDEM importa e é a de sempre: partes da corrida primeiro, admin
 * depois, e o motorista-aceitando por último — porque é o único que precisa de
 * verificação externa e de reserva.
 *
 * O admin passa ANTES da elegibilidade de propósito: ele é o operador de exceção
 * do repositório inteiro (mesma política do refund-ride) e é justamente quem
 * precisa conseguir agir quando o caminho normal travou.
 */
export function decideChargeAuthorization(facts: ChargeAuthFacts): ChargeAuthDecision {
  if (facts.isPassenger)  return { allowed: true, reason: 'passenger',   requiresClaim: false };
  if (facts.isRideDriver) return { allowed: true, reason: 'ride_driver', requiresClaim: false };
  if (facts.isAdmin)      return { allowed: true, reason: 'admin',       requiresClaim: false };

  if (!facts.isDriver) return { allowed: false, code: 'not_a_party' };

  // Motorista que não é o desta corrida: a corrida precisa estar no leque.
  if (facts.hasDriver || facts.rideStatus !== 'requesting') {
    return { allowed: false, code: 'ride_not_open' };
  }

  // NEGA POR PADRÃO. `null` (nem consultado) e `false` (consultado e reprovado)
  // dão o mesmo resultado — a ausência de verificação nunca vira permissão.
  if (facts.driverEligible !== true) return { allowed: false, code: 'driver_not_eligible' };

  return { allowed: true, reason: 'accepting_driver', requiresClaim: true };
}

/** O que a checagem de `driver_can_go_online` concluiu, incluindo o caminho
 *  degradado em que a RPC não respondeu. */
export type GateOutcome =
  /** RPC respondeu e liberou. */
  | { eligible: true; degraded: false }
  /** RPC não respondeu, mas confirmamos que não há suspensão viva. */
  | { eligible: true; degraded: true }
  /** RPC respondeu e reprovou. */
  | { eligible: false; degraded: false; cause: 'gate' }
  /** RPC não respondeu, e a leitura direta achou suspensão viva. */
  | { eligible: false; degraded: true; cause: 'suspension' };

export interface GateFacts {
  /** A RPC `driver_can_go_online` devolveu erro de transporte? */
  rpcFailed: boolean;
  /** Retorno da RPC quando ela respondeu. Irrelevante se `rpcFailed`. */
  canGoOnline: boolean | null;
  /**
   * `safety_suspension_gate_v1_enabled` na jurisdição do motorista. `null` =
   * não deu para ler (a leitura da flag também falhou).
   */
  suspensionGateEnabled: boolean | null;
  /**
   * Existe suspensão sem `lifted_at` para este motorista? `null` = não deu para
   * ler a tabela.
   */
  hasLiveSuspension: boolean | null;
}

/**
 * Elegibilidade do motorista que aceita, INCLUINDO o caminho degradado.
 *
 * O ponto todo está no ramo `rpcFailed`. Falhar fechado ali mata corrida por
 * soluço de banco; falhar aberto deixa passar motorista suspenso por agressão.
 * Nenhum dos dois serve, então perguntamos a pergunta CARA (suspensão) direto
 * na tabela e deixamos as baratas (disclosure, background, verificação) para o
 * gate do Stripe, que continua valendo do lado do chamador.
 *
 * `hasLiveSuspension === null` — nem o SELECT trivial respondeu — libera, e é
 * deliberado: nesse ponto o banco está fora, e recusar seria exatamente o
 * fail-closed que este desenho existe para evitar. Fica marcado `degraded` para
 * o chamador registrar.
 */
export function decideDriverGate(facts: GateFacts): GateOutcome {
  if (!facts.rpcFailed) {
    return facts.canGoOnline === false
      ? { eligible: false, degraded: false, cause: 'gate' }
      : { eligible: true, degraded: false };
  }

  // Flag desligada (ou ilegível) → a própria RPC não bloquearia por suspensão,
  // então o caminho degradado não pode ser MAIS severo do que ela seria.
  if (facts.suspensionGateEnabled !== true) return { eligible: true, degraded: true };

  return facts.hasLiveSuspension === true
    ? { eligible: false, degraded: true, cause: 'suspension' }
    : { eligible: true, degraded: true };
}
