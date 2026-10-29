// Testes da SEQUÊNCIA de dinheiro do estorno (_shared/refundFlow.ts).
//
// O que estes testes exercitam é justamente o que os testes de refundReversal.ts
// NÃO alcançam: aquele arquivo verifica a ARITMÉTICA (quanto reverter, o veredito
// final); aqui verificamos a ORDEM das chamadas e, principalmente, O QUE FICA
// ESCRITO quando a sequência sai pela metade.
//
// Não-circularidade: nenhum teste aqui chama uma função para conferir o retorno
// dela mesma. As portas são objetos de mentira que gravam o que receberam, e as
// asserções são sobre esse registro externo — a linha de conciliação, o alerta e
// o HTTP devolvido — não sobre valores que o próprio `runRefundFlow` calculou e
// devolveu para si.
//
// O que estes testes NÃO provam: que o Stripe devolve mesmo `status: 'failed'`
// num refund, que `transfers.createReversal` se comporta como o dublê, ou que o
// upsert em `stripe_reconciliation` grava. Isso só um Stripe de verdade e um
// Postgres de verdade provam. Aqui provamos a lógica de decisão da nossa função
// diante dessas respostas.

import {
  runRefundFlow,
  refundIdempotencyKey,
  reversalAheadOfRefund,
  type RefundAuditRow,
  type RefundPorts,
  type RefundFlowInput,
  type RefundShape,
  type DbWriteError,
} from '../refundFlow';

// ─────────────────────────────────────────────────────────────────────────────
// Dublês
// ─────────────────────────────────────────────────────────────────────────────

interface Spy {
  ports: RefundPorts;
  audits: RefundAuditRow[];
  alerts: { message: string; meta: Record<string, unknown> }[];
  reversals: { transferId: string; amountCents: number; rideId: string }[];
  refunds: { paymentIntentId: string; reversalId: string | null; idempotencyKey: string }[];
  unpaid: string[];
  /** Ordem global das chamadas, para provar que reverter vem ANTES de estornar. */
  calls: string[];
}

function makeSpy(opts: {
  reversal?: () => Promise<{ id: string }>;
  refund?: () => Promise<RefundShape>;
  markUnpaidError?: DbWriteError | null;
} = {}): Spy {
  const s: Spy = {
    audits: [],
    alerts: [],
    reversals: [],
    refunds: [],
    unpaid: [],
    calls: [],
    ports: undefined as unknown as RefundPorts,
  };

  s.ports = {
    async createReversal(input) {
      s.calls.push('reversal');
      s.reversals.push(input);
      return opts.reversal ? await opts.reversal() : { id: 'trr_fake' };
    },
    async createRefund(input) {
      s.calls.push('refund');
      s.refunds.push({
        paymentIntentId: input.paymentIntentId,
        reversalId: input.reversalId,
        idempotencyKey: input.idempotencyKey,
      });
      return opts.refund ? await opts.refund() : { id: 're_fake', status: 'succeeded', amount: 5000 };
    },
    async markUnpaid(rideId) {
      s.calls.push('markUnpaid');
      s.unpaid.push(rideId);
      return { error: opts.markUnpaidError ?? null };
    },
    async recordAudit(row) {
      s.calls.push(`audit:${row.code}`);
      s.audits.push(row);
    },
    async alertAdmins(message, meta) {
      s.calls.push('alert');
      s.alerts.push({ message, meta });
    },
  };

  return s;
}

function input(over: Partial<RefundFlowInput> = {}): RefundFlowInput {
  return {
    rideId: 'ride_1',
    paymentIntentId: 'pi_abc',
    plan: { action: 'reverse', transferId: 'tr_1', amountCents: 4250 },
    driverId: 'drv_1',
    payoutId: null,
    driverAmount: 42.5,
    tipAmount: null,
    tipPayoutId: null,
    rideStatus: 'completed',
    tip: 'none',
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// O defeito P0-1: refund RESOLVE com status ruim depois da reversão
// ─────────────────────────────────────────────────────────────────────────────

describe('reversão saiu e o estorno não — os dois acidentes deixam rastro', () => {
  test('refund com status failed depois de reverter grava linha needs_attention', async () => {
    // Este é o buraco: antes, este ramo devolvia 400 seco. O motorista já tinha
    // sido debitado, o passageiro não recebeu nada e nada era escrito.
    const s = makeSpy({ refund: async () => ({ id: 're_bad', status: 'failed', amount: 5000 }) });

    const res = await runRefundFlow(s.ports, input());

    expect(res.ok).toBe(false);
    expect(res.status).toBe(400);

    const row = s.audits.find((a) => a.code === 'refund_failed_after_reversal');
    expect(row).toBeDefined();
    expect(row!.needsAttention).toBe(true);
    expect(row!.amountCents).toBe(4250);
    expect(row!.rideId).toBe('ride_1');
    expect(row!.raw.failure).toBe('bad_status');
    expect(row!.raw.refund_status).toBe('failed');
    expect(row!.raw.reversal_id).toBe('trr_fake');

    // E um humano é chamado.
    expect(s.alerts.some((a) => a.meta.type === 'refund_failed_after_reversal')).toBe(true);

    // O corpo do 400 precisa dizer que o motorista já foi debitado, senão quem
    // chamou não tem como saber.
    expect(res.body.code).toBe('refund_not_succeeded');
    expect(res.body.reversal).toEqual({
      reversed: true,
      reversal_id: 'trr_fake',
      unrecovered_cents: 4250,
    });

    // E o banco NÃO foi marcado como não-pago: nenhum dinheiro voltou.
    expect(s.unpaid).toEqual([]);
  });

  test.each(['canceled', 'requires_action', null, undefined])(
    'status %s também é tratado como estorno que não saiu',
    async (status) => {
      const s = makeSpy({
        refund: async () => ({ id: 're_x', status: status as string | null, amount: 1 }),
      });
      const res = await runRefundFlow(s.ports, input());
      expect(res.ok).toBe(false);
      expect(s.audits.some((a) => a.code === 'refund_failed_after_reversal')).toBe(true);
      expect(s.unpaid).toEqual([]);
    },
  );

  test('refund que LANÇA depois de reverter grava o mesmo código, com sufixo diferente', async () => {
    const s = makeSpy({
      refund: async () => {
        throw { raw: { message: 'charge_already_refunded' } };
      },
    });

    const res = await runRefundFlow(s.ports, input());

    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);

    const row = s.audits.find((a) => a.code === 'refund_failed_after_reversal');
    expect(row).toBeDefined();
    expect(row!.needsAttention).toBe(true);
    expect(row!.raw.failure).toBe('exception');
    // Os dois acidentes escrevem event_id distintos para não se sobrescreverem
    // no upsert idempotente.
    expect(row!.eventId).toBe('refund_fail_ride_1_trr_fake_threw');
  });

  test('os dois caminhos de falha usam event_id diferentes', async () => {
    const a = makeSpy({ refund: async () => ({ id: 're_1', status: 'failed' }) });
    await runRefundFlow(a.ports, input());
    const b = makeSpy({
      refund: async () => {
        throw new Error('boom');
      },
    });
    await runRefundFlow(b.ports, input());

    const ida = a.audits.find((r) => r.code === 'refund_failed_after_reversal')!.eventId;
    const idb = b.audits.find((r) => r.code === 'refund_failed_after_reversal')!.eventId;
    expect(ida).not.toBe(idb);
  });

  test('sem reversão feita, um estorno que falha não inventa pendência de motorista', async () => {
    // Se nada foi revertido, ninguém foi debitado indevidamente — não há o que
    // registrar como "reversão órfã".
    const s = makeSpy({ refund: async () => ({ id: 're_bad', status: 'failed' }) });

    const res = await runRefundFlow(
      s.ports,
      input({ plan: { action: 'skip', reason: 'nothing_transferred' } }),
    );

    expect(res.ok).toBe(false);
    expect(s.reversals).toEqual([]);
    expect(s.audits).toEqual([]);
    expect(s.alerts).toEqual([]);
  });

  test('reversão que falha NÃO derruba o estorno do passageiro', async () => {
    // `balance_insufficient` (motorista já sacou) é o caso real e esperado.
    const s = makeSpy({
      reversal: async () => {
        throw { raw: { message: 'balance_insufficient' } };
      },
    });

    const res = await runRefundFlow(s.ports, input());

    expect(res.ok).toBe(true);
    expect(s.unpaid).toEqual(['ride_1']);
    // Mas fica registrada como pendência, com o valor exposto.
    const row = s.audits.find((a) => a.eventId.startsWith('refund_re_'))!;
    expect(row.needsAttention).toBe(true);
    expect(row.raw.unrecovered_cents).toBe(4250);
    expect(row.raw.reversal_error).toBe('balance_insufficient');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ordem
// ─────────────────────────────────────────────────────────────────────────────

describe('ordem das chamadas', () => {
  test('reverte o transfer do motorista ANTES de estornar o passageiro', async () => {
    const s = makeSpy();
    await runRefundFlow(s.ports, input());
    // A PRESENÇA vem antes da ordem: `indexOf` devolve -1 para o que não
    // aconteceu, e -1 é menor que qualquer índice. Sem estas três linhas, um
    // fluxo que PULASSE a reversão do transfer passaria neste teste.
    expect(s.calls).toContain('reversal');
    expect(s.calls).toContain('refund');
    expect(s.calls).toContain('markUnpaid');
    expect(s.calls.indexOf('reversal')).toBeLessThan(s.calls.indexOf('refund'));
    expect(s.calls.indexOf('refund')).toBeLessThan(s.calls.indexOf('markUnpaid'));
  });

  test('a reversão é passada ao refund para constar na conciliação', async () => {
    const s = makeSpy();
    await runRefundFlow(s.ports, input());
    expect(s.refunds[0].reversalId).toBe('trr_fake');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P2-9: idempotência derivada do PaymentIntent
// ─────────────────────────────────────────────────────────────────────────────

describe('chave de idempotência do estorno', () => {
  test('vem do PaymentIntent, não da corrida', async () => {
    const s = makeSpy();
    await runRefundFlow(s.ports, input({ paymentIntentId: 'pi_ciclo2' }));
    expect(s.refunds[0].idempotencyKey).toBe('refund_pi_ciclo2');
    expect(s.refunds[0].idempotencyKey).not.toContain('ride_1');
  });

  test('a mesma corrida cobrada de novo produz chave diferente', () => {
    // Este é o ponto: com `refund_<rideId>` o segundo estorno receberia de volta
    // a resposta do primeiro e o fluxo gravaria paid = false sem um centavo ter
    // voltado.
    expect(refundIdempotencyKey('pi_ciclo1')).not.toBe(refundIdempotencyKey('pi_ciclo2'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Gravação de paid = false
// ─────────────────────────────────────────────────────────────────────────────

describe('paid = false', () => {
  test('erro ao gravar paid = false vira pendência, não erro para o chamador', async () => {
    // O dinheiro já voltou ao passageiro; falhar aqui não desfaz nada. O certo é
    // registrar e chamar um humano, porque a corrida segue elegível a repasse.
    const s = makeSpy({ markUnpaidError: { message: 'deadlock detected', code: '40P01' } });

    const res = await runRefundFlow(s.ports, input());

    expect(res.ok).toBe(true);
    const row = s.audits.find((a) => a.code === 'paid_flag_write_failed');
    expect(row).toBeDefined();
    expect(row!.needsAttention).toBe(true);
    expect(row!.raw.db_code).toBe('40P01');
    expect(s.alerts.some((a) => a.meta.type === 'refund_paid_flag_write_failed')).toBe(true);
  });

  test('caminho feliz fecha os livros e não alerta ninguém', async () => {
    const s = makeSpy();
    const res = await runRefundFlow(s.ports, input());
    expect(res.ok).toBe(true);
    expect(res.body.balanced).toBe(true);
    expect(s.unpaid).toEqual(['ride_1']);
    expect(s.alerts).toEqual([]);
    expect(s.audits).toHaveLength(1);
    expect(s.audits[0].needsAttention).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P1-4: gorjeta
// ─────────────────────────────────────────────────────────────────────────────

describe('gorjeta presa pelo estorno', () => {
  test('gorjeta cobrada e não repassada força pendência com código próprio', async () => {
    const s = makeSpy();
    const res = await runRefundFlow(
      s.ports,
      input({ tip: 'charged_not_transferred', tipAmount: 5, tipPayoutId: null }),
    );

    expect(res.ok).toBe(true);
    // Fecha a tarifa, mas os livros não estão limpos.
    expect(s.audits[0].needsAttention).toBe(true);
    expect(s.audits[0].raw.tip_code).toBe('tip_charged_never_transferable');
    expect(s.alerts.some((a) => a.meta.tipCode === 'tip_charged_never_transferable')).toBe(true);
  });

  test('gorjeta já repassada tem código distinto — a remediação humana é outra', async () => {
    const s = makeSpy();
    await runRefundFlow(s.ports, input({ tip: 'transferred', tipAmount: 5, tipPayoutId: 'po_1' }));
    expect(s.audits[0].raw.tip_code).toBe('tip_transferred_not_refunded');
    expect(s.audits[0].needsAttention).toBe(true);
  });

  test('sem gorjeta, nada de pendência de gorjeta', async () => {
    const s = makeSpy();
    await runRefundFlow(s.ports, input({ tip: 'none' }));
    expect(s.audits[0].raw.tip_code).toBe('tip_none');
    expect(s.audits[0].needsAttention).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D2 (parte 1): refund 'pending' DEPOIS de uma reversão executada
// ─────────────────────────────────────────────────────────────────────────────
// O buraco: `refundIsGoingThrough` aceita 'pending' como sucesso — o que está
// certo para o FLUXO — e o que se escrevia depois era `code: 'reversed'`,
// `needsAttention: false`, `balanced: true`. Nesse intervalo o motorista JÁ foi
// debitado e o passageiro AINDA NÃO recebeu, e os livros afirmavam que fechou.

describe('reversalAheadOfRefund — o predicado sozinho', () => {
  test('reversão executada + refund pendente = exposição aberta', () => {
    expect(reversalAheadOfRefund({ reversed: true, refundStatus: 'pending' })).toBe(true);
  });

  test('o caso COMUM (succeeded) não marca nada — é isto que evita fadiga de alerta', () => {
    expect(reversalAheadOfRefund({ reversed: true, refundStatus: 'succeeded' })).toBe(false);
  });

  test('sem reversão não há exposição do motorista a marcar', () => {
    // O dinheiro do motorista continua onde estava; um refund pendente aqui é
    // pendência de outra natureza (quem avisa é o webhook).
    expect(reversalAheadOfRefund({ reversed: false, refundStatus: 'pending' })).toBe(false);
    expect(reversalAheadOfRefund({ reversed: false, refundStatus: 'succeeded' })).toBe(false);
  });

  test('status ausente/nulo não vira exposição', () => {
    expect(reversalAheadOfRefund({ reversed: true, refundStatus: null })).toBe(false);
    expect(reversalAheadOfRefund({ reversed: true })).toBe(false);
  });
});

describe('refund pendente depois da reversão deixa PENDÊNCIA ABERTA nos livros', () => {
  test('grava needs_attention e NÃO declara balanced', async () => {
    const s = makeSpy({ refund: async () => ({ id: 're_pend', status: 'pending', amount: 5000 }) });

    const res = await runRefundFlow(s.ports, input());

    // O fluxo NÃO falha — um refund pendente não pode derrubar o cancelamento.
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);

    const row = s.audits.find((a) => a.eventId === 'refund_re_pend');
    expect(row).toBeDefined();
    // Antes: false. O motorista foi debitado em 4250 contra um estorno que ainda
    // pode falhar no emissor do cartão.
    expect(row!.needsAttention).toBe(true);
    expect(row!.raw.pending_refund_exposure_cents).toBe(4250);
    expect(row!.reason).toContain('PENDÊNCIA ABERTA');

    // Antes: true. Dizer que fechou era afirmar um fechamento que ainda não existe.
    expect((res.body as { balanced: boolean }).balanced).toBe(false);
    expect((res.body as { pending_refund_exposure_cents: number }).pending_refund_exposure_cents).toBe(4250);
    expect((res.body as { refund_status: string | null }).refund_status).toBe('pending');
  });

  test('DELIBERADO: a exposição pendente sozinha não acorda ninguém por push', async () => {
    // A linha needs_attention é a fila que um humano trabalha. Um push por cada
    // refund pendente — que costuma liquidar sozinho — viraria ruído, e o ruído
    // é o que faz o alerta de verdade (refund.failed) passar despercebido.
    const s = makeSpy({ refund: async () => ({ id: 're_pend2', status: 'pending', amount: 5000 }) });
    await runRefundFlow(s.ports, input());
    expect(s.alerts).toHaveLength(0);
  });

  test('sem reversão, um refund pendente NÃO abre exposição de motorista', async () => {
    const s = makeSpy({ refund: async () => ({ id: 're_pend3', status: 'pending', amount: 5000 }) });

    const res = await runRefundFlow(
      s.ports,
      input({ plan: { action: 'skip', reason: 'nothing_transferred' } }),
    );

    const row = s.audits.find((a) => a.eventId === 'refund_re_pend3');
    expect(row!.raw.pending_refund_exposure_cents).toBe(0);
    expect(row!.reason).not.toContain('PENDÊNCIA ABERTA');
    expect((res.body as { balanced: boolean }).balanced).toBe(true);
  });

  test('o caminho comum (succeeded + reversão) continua fechando limpo', async () => {
    // Regressão: a correção não pode transformar o caso normal em pendência.
    const s = makeSpy();
    const res = await runRefundFlow(s.ports, input());
    const row = s.audits.find((a) => a.eventId === 'refund_re_fake');
    expect(row!.needsAttention).toBe(false);
    expect(row!.raw.pending_refund_exposure_cents).toBe(0);
    expect((res.body as { balanced: boolean }).balanced).toBe(true);
    expect(s.alerts).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// RESERVAR ANTES DE GASTAR — portas `claim` / `compensateClaim`
// ─────────────────────────────────────────────────────────────────────────────
// O defeito: a varredura relia a corrida, decidia estornar e só DEPOIS chamava
// `markUnpaid`. Entre a releitura e o `refunds.create` cabia um aceite de
// motorista — o estorno saía sobre uma corrida em andamento, e o `markUnpaid`
// (filtrado por `paid = true`) ainda dava certo, deixando a viagem de graça e o
// motorista sem repasse (que exige `paid = true`).
//
// A correção inverte a ordem: quem vai gastar RESERVA antes, com um update
// condicional que ou pega a linha ou não pega. Perdeu a reserva, não gasta.
//
// O que estes testes provam: a ORDEM das chamadas e o que fica escrito quando a
// sequência quebra no meio. O que NÃO provam: que o `update ... where status =
// 'requesting' and paid = true` do Postgres é de fato atômico sob concorrência —
// isso é garantia do banco, e não há banco aqui.

interface ClaimSpy extends Spy {
  claims: string[];
  compensations: { rideId: string; detail: string }[];
}

function makeClaimSpy(opts: {
  claimed?: boolean;
  claimDetail?: string | null;
  refund?: () => Promise<RefundShape>;
  reversal?: () => Promise<{ id: string }>;
} = {}): ClaimSpy {
  const base = makeSpy({ refund: opts.refund, reversal: opts.reversal });
  const s = base as ClaimSpy;
  s.claims = [];
  s.compensations = [];

  s.ports = {
    ...base.ports,
    async claim(rideId: string) {
      s.calls.push('claim');
      s.claims.push(rideId);
      return {
        claimed: opts.claimed ?? true,
        detail: opts.claimDetail ?? null,
      };
    },
    async compensateClaim(rideId: string, detail: string) {
      s.calls.push('compensateClaim');
      s.compensations.push({ rideId, detail });
    },
  };

  return s;
}

describe('a reserva vem ANTES de qualquer chamada ao Stripe', () => {
  test('reserva pega: claim é a PRIMEIRA chamada, antes de reverter e estornar', async () => {
    const s = makeClaimSpy();
    const res = await runRefundFlow(s.ports, input());

    expect(res.ok).toBe(true);
    expect(s.claims).toEqual(['ride_1']);
    expect(s.calls[0]).toBe('claim');
    expect(s.calls.indexOf('claim')).toBeLessThan(s.calls.indexOf('reversal'));
    expect(s.calls.indexOf('claim')).toBeLessThan(s.calls.indexOf('refund'));
    expect(s.compensations).toEqual([]);
  });

  test('reserva pega dispensa markUnpaid — a mesma escrita já foi feita', async () => {
    // Chamar `markUnpaid` depois seria filtrar por `paid = true` numa linha que
    // a própria reserva já pôs em `paid = false`: erro fantasma garantido.
    const s = makeClaimSpy();
    await runRefundFlow(s.ports, input());
    expect(s.unpaid).toEqual([]);
    expect(s.calls).not.toContain('markUnpaid');
  });

  test('reserva PERDIDA: 409 claim_lost e NENHUMA ida ao Stripe', async () => {
    // Alguém aceitou a corrida entre a releitura e agora. Nada se move.
    const s = makeClaimSpy({ claimed: false, claimDetail: 'a corrida saiu de requesting' });
    const res = await runRefundFlow(s.ports, input());

    expect(res.ok).toBe(false);
    expect(res.status).toBe(409);
    expect((res.body as { code: string }).code).toBe('claim_lost');
    expect((res.body as { detail: string | null }).detail).toBe('a corrida saiu de requesting');

    expect(s.refunds).toEqual([]);
    expect(s.reversals).toEqual([]);
    expect(s.unpaid).toEqual([]);
    expect(s.calls).toEqual(['claim']);
  });

  test('sem porta de reserva o caminho antigo segue intacto (refund-ride)', async () => {
    // Regressão: `refund-ride` não passa `claim` e continua marcando via
    // `markUnpaid`.
    const s = makeSpy();
    const res = await runRefundFlow(s.ports, input());
    expect(res.ok).toBe(true);
    expect(s.unpaid).toEqual(['ride_1']);
    expect(s.calls).toContain('markUnpaid');
  });
});

describe('o Stripe falhou depois da reserva — a reserva é desfeita', () => {
  test('refunds.create LANÇOU: compensa a reserva e diz por quê', async () => {
    const s = makeClaimSpy({
      refund: async () => {
        throw new Error('rede caiu');
      },
    });
    const res = await runRefundFlow(s.ports, input());

    expect(res.ok).toBe(false);
    expect(s.compensations).toHaveLength(1);
    expect(s.compensations[0].rideId).toBe('ride_1');
    expect(s.compensations[0].detail).toContain('rede caiu');

    // A compensação acontece ANTES de registrar a órfã, para que a linha de
    // conciliação já descreva o estado final.
    expect(s.calls.indexOf('compensateClaim')).toBeGreaterThan(s.calls.indexOf('refund'));
    expect(s.calls.indexOf('compensateClaim')).toBeLessThan(
      s.calls.findIndex((c) => c.startsWith('audit:')),
    );
  });

  test('refund com status ruim: compensa a reserva', async () => {
    const s = makeClaimSpy({
      refund: async () => ({ id: 're_bad', status: 'failed', amount: 5000 }),
    });
    const res = await runRefundFlow(s.ports, input());

    expect(res.ok).toBe(false);
    expect(s.compensations).toHaveLength(1);
    expect(s.compensations[0].rideId).toBe('ride_1');
    // E o acidente continua sendo registrado como antes.
    expect(s.audits.some((a) => a.code === 'refund_failed_after_reversal')).toBe(true);
  });

  test('reversão que falha NÃO desfaz a reserva — o estorno ainda vai sair', async () => {
    // `balance_insufficient` é caso esperado: vira pendência, não aborta o
    // estorno ao passageiro. Desfazer a reserva aqui devolveria a corrida ao
    // leque com o dinheiro já estornado.
    const s = makeClaimSpy({
      reversal: async () => {
        throw new Error('balance_insufficient');
      },
    });
    const res = await runRefundFlow(s.ports, input());

    expect(res.ok).toBe(true);
    expect(s.compensations).toEqual([]);
    expect(s.refunds).toHaveLength(1);
  });

  test('o estorno bem-sucedido não compensa nada', async () => {
    const s = makeClaimSpy();
    const res = await runRefundFlow(s.ports, input());
    expect(res.ok).toBe(true);
    expect(s.compensations).toEqual([]);
  });
});
