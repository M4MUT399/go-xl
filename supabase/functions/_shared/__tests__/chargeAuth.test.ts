// Testes da decisão de autorização da cobrança (_shared/chargeAuth.ts).
//
// HISTÓRICO — este arquivo já testou DUAS regras que foram descartadas:
//
//   1ª  `isAcceptingDriver && await isConfigFlagEnabled(admin,'dispatch_engine_v2')`.
//       A flag tem default false e nenhuma migration a liga, então o `&&`
//       curto-circuitava e a exigência NUNCA rodava — qualquer pessoa cadastrada
//       como motorista podia cobrar qualquer corrida aberta.
//
//   2ª  prova de oferta em `ride_push_offers`, gravada sobre a lista de ids que o
//       CLIENTE mandava ("todo mundo com is_online = true"). Autorizava uma
//       multidão (cada motorista online ganhava direito de cobrança off-session
//       no cartão daquele passageiro) e ao mesmo tempo RECUSAVA legítimos: se
//       ninguém estava online no instante do pedido, a corrida nascia sem prova
//       nenhuma e todo aceite posterior levava 403 para sempre.
//
// REGRA ATUAL: a pergunta não é mais "o telefone dele tocou?" (instantâneo
// passado, decidido por lista do cliente) e sim "este chamador pode assumir esta
// corrida AGORA?" — elegibilidade derivada pelo SERVIDOR no momento do aceite
// (conta Connect habilitada + `driver_can_go_online`). A exclusividade não vem
// mais da autorização: vem da RESERVA ATÔMICA (`requiresClaim`), um UPDATE
// condicional `where driver_id is null` que só casa para UM motorista.
//
// `driverEligible` só autoriza quando é exatamente `true`. `null` (não
// consultado) e `false` (consultado e reprovado) negam igual — a AUSÊNCIA de
// verificação nunca vira permissão.
//
// O que estes testes NÃO provam: que `driver_can_go_online()` existe no banco e
// devolve o que se espera, que `stripe_charges_enabled` é de fato inescrevível
// pelo motorista, nem que o UPDATE condicional da reserva é atômico. Nada disso
// é decisão pura — é Postgres, e não há Postgres aqui.
//
// Não-circularidade: as entradas são objetos de fato montados à mão e as
// asserções comparam contra literais. Nenhum teste chama a função duas vezes
// para conferir uma contra a outra.

import {
  decideChargeAuthorization,
  isAcceptingDriverCase,
  decideDriverGate,
  type ChargeAuthFacts,
  type GateFacts,
} from '../chargeAuth';

function facts(over: Partial<ChargeAuthFacts> = {}): ChargeAuthFacts {
  return {
    isPassenger: false,
    isRideDriver: false,
    isAdmin: false,
    isDriver: false,
    rideStatus: 'requesting',
    hasDriver: false,
    driverEligible: null,
    ...over,
  };
}

describe('as partes da corrida entram sem verificação de elegibilidade', () => {
  test('o passageiro dono da corrida cobra — e não reserva nada', () => {
    expect(decideChargeAuthorization(facts({ isPassenger: true }))).toEqual({
      allowed: true,
      reason: 'passenger',
      requiresClaim: false,
    });
  });

  test('o motorista JÁ DONO da corrida cobra — não reserva o que já é dele', () => {
    expect(
      decideChargeAuthorization(facts({ isRideDriver: true, hasDriver: true, rideStatus: 'accepted' })),
    ).toEqual({ allowed: true, reason: 'ride_driver', requiresClaim: false });
  });

  test('admin cobra, mesmo com elegibilidade reprovada', () => {
    // Deliberado: o admin é o operador de exceção (mesma política do
    // refund-ride) e é justamente quem precisa agir quando o caminho normal
    // travou. Se um dia isto for restringido, é aqui que se vê.
    expect(decideChargeAuthorization(facts({ isAdmin: true, driverEligible: false }))).toEqual({
      allowed: true,
      reason: 'admin',
      requiresClaim: false,
    });
  });

  test('passageiro tem precedência sobre tudo (ordem da decisão é estável)', () => {
    const d = decideChargeAuthorization(
      facts({ isPassenger: true, isRideDriver: true, isAdmin: true, isDriver: true }),
    );
    expect(d).toEqual({ allowed: true, reason: 'passenger', requiresClaim: false });
  });
});

describe('o motorista do leque: nega por padrão', () => {
  test('elegibilidade NÃO CONSULTADA (null) é recusa, não permissão', () => {
    // Este é o formato do defeito original: um caminho em que a verificação não
    // roda não pode terminar em "autorizado".
    expect(decideChargeAuthorization(facts({ isDriver: true, driverEligible: null }))).toEqual({
      allowed: false,
      code: 'driver_not_eligible',
    });
  });

  test('elegibilidade REPROVADA (false) é recusa', () => {
    expect(decideChargeAuthorization(facts({ isDriver: true, driverEligible: false }))).toEqual({
      allowed: false,
      code: 'driver_not_eligible',
    });
  });

  test('elegível entra — e é o ÚNICO caso que exige reserva atômica', () => {
    expect(decideChargeAuthorization(facts({ isDriver: true, driverEligible: true }))).toEqual({
      allowed: true,
      reason: 'accepting_driver',
      requiresClaim: true,
    });
  });

  test('ser elegível NÃO vale para corrida que já tem dono', () => {
    // Roubo de corrida alheia: o motorista pode estar perfeitamente habilitado,
    // mas outro aceitou primeiro. A recusa é `ride_not_open`, não
    // `driver_not_eligible` — o código distingue "você não pode" de "essa
    // corrida não está mais aberta".
    expect(
      decideChargeAuthorization(facts({ isDriver: true, driverEligible: true, hasDriver: true })),
    ).toEqual({ allowed: false, code: 'ride_not_open' });
  });

  test.each(['accepted', 'in_progress', 'completed', 'cancelled', null])(
    'ser elegível NÃO vale com status %s',
    (status) => {
      expect(
        decideChargeAuthorization(facts({ isDriver: true, driverEligible: true, rideStatus: status })),
      ).toEqual({ allowed: false, code: 'ride_not_open' });
    },
  );

  test('quem não é motorista nem parte é not_a_party, mesmo marcado elegível', () => {
    expect(decideChargeAuthorization(facts({ isDriver: false, driverEligible: true }))).toEqual({
      allowed: false,
      code: 'not_a_party',
    });
  });

  test('nenhuma autorização de terceiro existe sem reserva', () => {
    // Invariante que sustenta a exclusividade: se a decisão permite alguém que
    // NÃO é parte da corrida, ela obriga a reserva. Sem isto, N motoristas
    // elegíveis cobrariam o MESMO cartão pela MESMA corrida na janela de rede.
    const d = decideChargeAuthorization(facts({ isDriver: true, driverEligible: true }));
    expect(d.allowed).toBe(true);
    if (d.allowed) expect(d.requiresClaim).toBe(true);
  });
});

describe('isAcceptingDriverCase — quando vale a pena consultar a elegibilidade', () => {
  test('motorista sem vínculo, corrida aberta: sim', () => {
    expect(
      isAcceptingDriverCase({
        isPassenger: false,
        isRideDriver: false,
        isDriver: true,
        rideStatus: 'requesting',
        hasDriver: false,
      }),
    ).toBe(true);
  });

  test('as partes da corrida não disparam consulta (economia de ida ao banco)', () => {
    expect(
      isAcceptingDriverCase({
        isPassenger: true,
        isRideDriver: false,
        isDriver: true,
        rideStatus: 'requesting',
        hasDriver: false,
      }),
    ).toBe(false);
    expect(
      isAcceptingDriverCase({
        isPassenger: false,
        isRideDriver: true,
        isDriver: true,
        rideStatus: 'requesting',
        hasDriver: true,
      }),
    ).toBe(false);
  });

  test('corrida fechada não dispara consulta', () => {
    expect(
      isAcceptingDriverCase({
        isPassenger: false,
        isRideDriver: false,
        isDriver: true,
        rideStatus: 'accepted',
        hasDriver: false,
      }),
    ).toBe(false);
    expect(
      isAcceptingDriverCase({
        isPassenger: false,
        isRideDriver: false,
        isDriver: true,
        rideStatus: 'requesting',
        hasDriver: true,
      }),
    ).toBe(false);
  });

  test('não-motorista não dispara consulta — e continua negado na decisão', () => {
    const f = {
      isPassenger: false,
      isRideDriver: false,
      isDriver: false,
      rideStatus: 'requesting',
      hasDriver: false,
    };
    expect(isAcceptingDriverCase(f)).toBe(false);
    // O par das duas funções não abre brecha: não consultar deixa
    // `driverEligible: null`, e a decisão nega antes disso com `not_a_party`.
    expect(decideChargeAuthorization({ ...f, isAdmin: false, driverEligible: null })).toEqual({
      allowed: false,
      code: 'not_a_party',
    });
  });

  test('o par fecha: todo caso que NÃO dispara consulta também não é autorizado como aceitante', () => {
    // Sem isto, a economia de ida ao banco poderia virar um buraco: um caso que
    // deixa de consultar mas mesmo assim recebe `accepting_driver`.
    const cases: ChargeAuthFacts[] = [
      facts({ isDriver: true, hasDriver: true }),
      facts({ isDriver: true, rideStatus: 'accepted' }),
      facts({ isDriver: true, rideStatus: null }),
      facts({ isDriver: false }),
    ];
    for (const f of cases) {
      expect(isAcceptingDriverCase(f)).toBe(false);
      // driverEligible fica `null` porque a consulta não roda.
      const d = decideChargeAuthorization({ ...f, driverEligible: null });
      expect(d.allowed).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// decideDriverGate — o ramo degradado (RPC `driver_can_go_online` fora do ar)
// ─────────────────────────────────────────────────────────────────────────────
// A versão anterior fazia UMA coisa quando a RPC errava: seguir em frente. Isso
// resolvia o problema certo (soluço de banco não pode matar corrida) e criava
// outro: motorista suspenso por tolerância zero passava enquanto a RPC estivesse
// fora. Aqui a tabela-verdade inteira fica presa em teste, incluindo os dois
// casos em que o degradado NÃO pode ser mais severo que a RPC seria.

function gate(over: Partial<GateFacts> = {}): GateFacts {
  return {
    rpcFailed: false,
    canGoOnline: true,
    suspensionGateEnabled: null,
    hasLiveSuspension: null,
    ...over,
  };
}

describe('decideDriverGate — caminho normal', () => {
  test('RPC liberou → elegível, sem degradação', () => {
    expect(decideDriverGate(gate({ canGoOnline: true }))).toEqual({ eligible: true, degraded: false });
  });

  test('RPC reprovou → recusa por gate', () => {
    expect(decideDriverGate(gate({ canGoOnline: false }))).toEqual({
      eligible: false, degraded: false, cause: 'gate',
    });
  });

  test('RPC respondeu algo que não é boolean → trata como liberado, não como reprovado', () => {
    // `canGoOnline: null` sem erro significa "respondeu, mas não um booleano".
    // Só `false` recusa: a RPC é declaradamente permissiva enquanto as flags de
    // rollout estão desligadas, e inventar recusa aqui mataria corrida legítima.
    expect(decideDriverGate(gate({ canGoOnline: null }))).toEqual({ eligible: true, degraded: false });
  });
});

describe('decideDriverGate — RPC fora do ar', () => {
  test('suspensão viva confirmada na tabela → RECUSA, mesmo com a RPC fora', () => {
    const d = decideDriverGate(gate({
      rpcFailed: true, suspensionGateEnabled: true, hasLiveSuspension: true,
    }));
    expect(d).toEqual({ eligible: false, degraded: true, cause: 'suspension' });
  });

  test('sem suspensão viva → segue, marcado como degradado', () => {
    expect(decideDriverGate(gate({
      rpcFailed: true, suspensionGateEnabled: true, hasLiveSuspension: false,
    }))).toEqual({ eligible: true, degraded: true });
  });

  test('nem o SELECT de suspensão respondeu → segue (banco fora não pode matar corrida)', () => {
    expect(decideDriverGate(gate({
      rpcFailed: true, suspensionGateEnabled: true, hasLiveSuspension: null,
    }))).toEqual({ eligible: true, degraded: true });
  });

  test('flag de suspensão DESLIGADA → segue, mesmo se houvesse suspensão na tabela', () => {
    // A RPC também não bloquearia: o `exists` dela está dentro do
    // `if v_suspension_enabled is true`. O degradado não pode ser mais severo
    // que o caminho normal — senão o fallback vira uma regra nova, escondida,
    // que só aparece quando o banco tosse.
    expect(decideDriverGate(gate({
      rpcFailed: true, suspensionGateEnabled: false, hasLiveSuspension: true,
    }))).toEqual({ eligible: true, degraded: true });
  });

  test('flag ilegível → segue (mesmo motivo: não inventar severidade)', () => {
    expect(decideDriverGate(gate({
      rpcFailed: true, suspensionGateEnabled: null, hasLiveSuspension: true,
    }))).toEqual({ eligible: true, degraded: true });
  });

  test('canGoOnline residual não influencia quando a RPC falhou', () => {
    // Se `rpcFailed`, o valor de `canGoOnline` é lixo — não pode nem liberar
    // nem recusar por si só.
    const suspenso = { rpcFailed: true, suspensionGateEnabled: true, hasLiveSuspension: true };
    expect(decideDriverGate(gate({ ...suspenso, canGoOnline: true })))
      .toEqual(decideDriverGate(gate({ ...suspenso, canGoOnline: false })));
  });
});
