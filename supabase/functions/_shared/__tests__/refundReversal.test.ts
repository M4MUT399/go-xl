import {
  findRideTransfer,
  planDriverReversal,
  summarizeRefund,
  type TransferShape,
} from '../refundReversal';

// Todos os objetos abaixo são FORMAS de transfer do Stripe montadas à mão. Nada
// aqui executou a API do Stripe nem um banco: o que se testa é a DECISÃO (achar
// o transfer certo, quanto reverter, e se os livros fecham), que é a parte que
// mora neste módulo. Os valores esperados são literais escritos à mão.

const acct = 'acct_DRIVER';

function transfer(over: Partial<TransferShape> = {}): TransferShape {
  return {
    id: 'tr_1',
    amount: 4000,
    amount_reversed: 0,
    destination: acct,
    metadata: { ride_id: 'ride-1', payout_id: 'po-1' },
    ...over,
  };
}

describe('findRideTransfer — achar o transfer DAQUELA corrida', () => {
  const input = { rideId: 'ride-1', payoutId: 'po-1', accountId: acct, kind: 'fare' as const };

  test('acha pelo metadata.ride_id', () => {
    const t = transfer();
    expect(findRideTransfer([transfer({ id: 'tr_outro', metadata: { ride_id: 'ride-9' } }), t], input)).toBe(t);
  });

  test('lista vazia → null', () => {
    expect(findRideTransfer([], input)).toBeNull();
  });

  test('transfer sem metadata nenhum é ignorado', () => {
    expect(findRideTransfer([transfer({ metadata: null })], input)).toBeNull();
  });

  test('NÃO confunde o transfer da GORJETA com o da tarifa', () => {
    // Tarifa e gorjeta são transfers separados (0064). Reverter o da gorjeta
    // achando que é o da tarifa tiraria do motorista um dinheiro que não está
    // sendo estornado ao passageiro.
    const tip = transfer({ id: 'tr_tip', metadata: { ride_id: 'ride-1', kind: 'tip' } });
    expect(findRideTransfer([tip], input)).toBeNull();
    expect(findRideTransfer([tip], { ...input, kind: 'tip' })).toBe(tip);
  });

  test('procurando a gorjeta, não devolve o da tarifa', () => {
    expect(findRideTransfer([transfer()], { ...input, kind: 'tip' })).toBeNull();
  });

  test('destino diferente NUNCA casa — cinto de segurança contra reverter a conta errada', () => {
    expect(findRideTransfer([transfer({ destination: 'acct_OUTRO' })], input)).toBeNull();
    expect(findRideTransfer([transfer({ destination: null })], input)).toBeNull();
  });

  test('destination como objeto expandido é aceito', () => {
    const t = transfer({ destination: { id: acct } });
    expect(findRideTransfer([t], input)).toBe(t);
  });

  test('payout_id divergente descarta', () => {
    expect(findRideTransfer([transfer({ metadata: { ride_id: 'ride-1', payout_id: 'po-OUTRO' } })], input))
      .toBeNull();
  });

  test('transfer legado SEM payout_id no metadata ainda é encontrado', () => {
    // Os outros três filtros já identificam a linha; exigir o quarto faria a
    // busca falhar em transfers antigos.
    const t = transfer({ metadata: { ride_id: 'ride-1' } });
    expect(findRideTransfer([t], input)).toBe(t);
  });

  test('sem payoutId do nosso lado, o payout_id do transfer não é exigido', () => {
    const t = transfer({ metadata: { ride_id: 'ride-1', payout_id: 'po-qualquer' } });
    expect(findRideTransfer([t], { ...input, payoutId: null })).toBe(t);
  });

  test('devolve o PRIMEIRO que casa, e não o último', () => {
    const a = transfer({ id: 'tr_a' });
    const b = transfer({ id: 'tr_b' });
    expect(findRideTransfer([a, b], input)!.id).toBe('tr_a');
  });
});

describe('planDriverReversal — o que fazer com a parte do motorista', () => {
  test('sem payout_id → nada foi repassado (caso feliz e mais comum)', () => {
    // O dinheiro do motorista ainda está na plataforma; paid = false já tira a
    // corrida da fila de repasse.
    expect(planDriverReversal({ payoutId: null, accountId: acct, transfer: transfer() }))
      .toEqual({ action: 'skip', reason: 'nothing_transferred' });
  });

  test('com payout_id mas sem conta conectada → estado inconsistente, não silencioso', () => {
    expect(planDriverReversal({ payoutId: 'po-1', accountId: null }))
      .toEqual({ action: 'skip', reason: 'no_driver_account' });
  });

  test('com payout_id e conta, mas transfer não localizado → não inventa reversão', () => {
    expect(planDriverReversal({ payoutId: 'po-1', accountId: acct, transfer: null }))
      .toEqual({ action: 'skip', reason: 'transfer_not_found' });
  });

  test('reverte o que AINDA NÃO foi revertido, não o driver_amount', () => {
    expect(planDriverReversal({ payoutId: 'po-1', accountId: acct, transfer: transfer({ amount: 4000 }) }))
      .toEqual({ action: 'reverse', transferId: 'tr_1', amountCents: 4000 });
  });

  test('reversão PARCIAL anterior → reverte só o resto (repetível sem reverter duas vezes)', () => {
    expect(planDriverReversal({
      payoutId: 'po-1', accountId: acct,
      transfer: transfer({ amount: 4000, amount_reversed: 1500 }),
    })).toEqual({ action: 'reverse', transferId: 'tr_1', amountCents: 2500 });
  });

  test('já totalmente revertido → already_reversed (retentativa é segura)', () => {
    expect(planDriverReversal({
      payoutId: 'po-1', accountId: acct,
      transfer: transfer({ amount: 4000, amount_reversed: 4000 }),
    })).toEqual({ action: 'skip', reason: 'already_reversed', transferId: 'tr_1' });
  });

  test('amount_reversed ausente conta como zero', () => {
    expect(planDriverReversal({
      payoutId: 'po-1', accountId: acct,
      transfer: transfer({ amount: 700, amount_reversed: null }),
    })).toEqual({ action: 'reverse', transferId: 'tr_1', amountCents: 700 });
  });

  test('a ordem das checagens é payout → conta → transfer', () => {
    // Sem payout_id, faltar conta e transfer é irrelevante: não há o que reverter.
    expect(planDriverReversal({ payoutId: null, accountId: null, transfer: null }))
      .toEqual({ action: 'skip', reason: 'nothing_transferred' });
  });
});

describe('summarizeRefund — os livros fecham? e, se não, quanto falta', () => {
  test('nunca repassado → fecha, sem pendência', () => {
    const r = summarizeRefund({ plan: { action: 'skip', reason: 'nothing_transferred' }, reversed: false });
    expect(r.balanced).toBe(true);
    expect(r.needsAttention).toBe(false);
    expect(r.code).toBe('no_payout_yet');
    expect(r.unrecoveredCents).toBe(0);
  });

  test('reversão concluída → fecha, sem pendência, com o valor na frase', () => {
    const r = summarizeRefund({
      plan: { action: 'reverse', transferId: 'tr_1', amountCents: 4000 },
      reversed: true,
    });
    expect(r.balanced).toBe(true);
    expect(r.needsAttention).toBe(false);
    expect(r.code).toBe('reversed');
    expect(r.unrecoveredCents).toBe(0);
    expect(r.reason).toContain('4000');
    expect(r.reason).toContain('tr_1');
  });

  test('já revertido antes → fecha (retentativa de um estorno parcial)', () => {
    const r = summarizeRefund({
      plan: { action: 'skip', reason: 'already_reversed', transferId: 'tr_1' },
      reversed: false,
    });
    expect(r.balanced).toBe(true);
    expect(r.needsAttention).toBe(false);
    expect(r.code).toBe('already_reversed');
  });

  test('reversão FALHOU → não fecha, vira pendência, com o prejuízo em centavos', () => {
    // O caso típico: saldo insuficiente na conta conectada porque o motorista já
    // sacou. O estorno do passageiro segue — ele não pode ficar refém do saldo do
    // motorista — mas NUNCA em silêncio.
    const r = summarizeRefund({
      plan: { action: 'reverse', transferId: 'tr_1', amountCents: 4000 },
      reversed: false,
      reversalError: 'balance_insufficient',
    });
    expect(r.balanced).toBe(false);
    expect(r.needsAttention).toBe(true);
    expect(r.code).toBe('reversal_failed');
    expect(r.unrecoveredCents).toBe(4000);
    expect(r.reason).toContain('balance_insufficient');
  });

  test('reversão falhou sem motivo informado → ainda pendência, com texto explícito', () => {
    const r = summarizeRefund({
      plan: { action: 'reverse', transferId: 'tr_1', amountCents: 1 },
      reversed: false,
    });
    expect(r.code).toBe('reversal_failed');
    expect(r.reason).toContain('motivo não informado');
  });

  test('transfer não localizado com payout_id preenchido → pendência humana', () => {
    const r = summarizeRefund({ plan: { action: 'skip', reason: 'transfer_not_found' }, reversed: false });
    expect(r.balanced).toBe(false);
    expect(r.needsAttention).toBe(true);
    expect(r.code).toBe('transfer_not_found');
  });

  test('payout_id sem conta conectada → pendência humana', () => {
    const r = summarizeRefund({ plan: { action: 'skip', reason: 'no_driver_account' }, reversed: false });
    expect(r.balanced).toBe(false);
    expect(r.needsAttention).toBe(true);
    expect(r.code).toBe('no_driver_account');
  });

  test('INVARIANTE: nenhum caminho fecha os livros com dinheiro irrecuperado', () => {
    const casos = [
      summarizeRefund({ plan: { action: 'skip', reason: 'nothing_transferred' }, reversed: false }),
      summarizeRefund({ plan: { action: 'skip', reason: 'transfer_not_found' }, reversed: false }),
      summarizeRefund({ plan: { action: 'skip', reason: 'no_driver_account' }, reversed: false }),
      summarizeRefund({ plan: { action: 'skip', reason: 'already_reversed', transferId: 't' }, reversed: false }),
      summarizeRefund({ plan: { action: 'reverse', transferId: 't', amountCents: 10 }, reversed: true }),
      summarizeRefund({ plan: { action: 'reverse', transferId: 't', amountCents: 10 }, reversed: false }),
    ];
    for (const c of casos) {
      if (c.unrecoveredCents > 0) expect(c.balanced).toBe(false);
      if (!c.balanced) expect(c.needsAttention).toBe(true);
    }
  });

  test('gorjeta já repassada e não estornada força pendência mesmo no caminho feliz', () => {
    // refund-ride estorna a TARIFA. Se a gorjeta já saiu para o motorista, um
    // humano precisa decidir se ela também volta — o código não inventa política.
    const r = summarizeRefund({
      plan: { action: 'reverse', transferId: 'tr_1', amountCents: 4000 },
      reversed: true,
      tip: 'transferred',
    });
    expect(r.balanced).toBe(true);
    expect(r.needsAttention).toBe(true);
    expect(r.tipCode).toBe('tip_transferred_not_refunded');
    expect(r.reason).toContain('gorjeta');
  });

  test('gorjeta cobrada e ainda não repassada é sinalizada com código próprio', () => {
    // Caso distinto do anterior: aqui a gorjeta ainda NÃO saiu, e gravar
    // paid = false a torna permanentemente inelegível a repasse. Os dois casos
    // precisam de códigos diferentes porque a remediação humana é diferente.
    const r = summarizeRefund({
      plan: { action: 'reverse', transferId: 'tr_1', amountCents: 4000 },
      reversed: true,
      tip: 'charged_not_transferred',
    });
    expect(r.needsAttention).toBe(true);
    expect(r.tipCode).toBe('tip_charged_never_transferable');
    expect(r.tipCode).not.toBe('tip_transferred_not_refunded');
    expect(r.reason).toContain('gorjeta');
  });

  test('gorjeta pendente não apaga uma pendência que já existia', () => {
    const r = summarizeRefund({
      plan: { action: 'reverse', transferId: 'tr_1', amountCents: 4000 },
      reversed: false,
      reversalError: 'balance_insufficient',
      tip: 'transferred',
    });
    expect(r.needsAttention).toBe(true);
    expect(r.unrecoveredCents).toBe(4000);
    expect(r.reason).toContain('balance_insufficient');
    expect(r.reason).toContain('gorjeta');
  });

  test('sem gorjeta pendente, a frase não menciona gorjeta', () => {
    const r = summarizeRefund({ plan: { action: 'skip', reason: 'nothing_transferred' }, reversed: false });
    expect(r.reason).not.toContain('gorjeta');
    expect(r.tipCode).toBe('tip_none');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D5: "reservada" NÃO é "transferida"
// ─────────────────────────────────────────────────────────────────────────────
// `claimPendingTips` (_shared/tipPayout.ts:47 — arquivo do dono, apenas lido)
// grava `tip_payout_id` ANTES de `settleTips` chamar o Stripe. Derivar
// 'transferred' só da presença da coluna fazia a nota operacional AFIRMAR que "a
// gorjeta já foi repassada ao motorista" durante toda a execução do repasse — e
// para sempre, se ele morresse no meio, até `unstickStalePayouts` soltar a
// reserva. Um operador decide dinheiro lendo essa frase.

describe('gorjeta reservada mas com repasse não concluído', () => {
  test('tem código PRÓPRIO, distinto de repassada e de nunca repassada', () => {
    const r = summarizeRefund({
      plan: { action: 'reverse', transferId: 'tr_1', amountCents: 4000 },
      reversed: true,
      tip: 'charged_payout_pending',
    });
    expect(r.tipCode).toBe('tip_payout_pending');
    expect(r.tipCode).not.toBe('tip_transferred_not_refunded');
    expect(r.tipCode).not.toBe('tip_charged_never_transferable');
  });

  test('a nota NÃO afirma que a gorjeta chegou ao motorista', () => {
    // Este é o defeito em uma frase: o texto anterior era o de 'transferred'.
    const pending = summarizeRefund({
      plan: { action: 'reverse', transferId: 'tr_1', amountCents: 4000 },
      reversed: true,
      tip: 'charged_payout_pending',
    });
    const transferred = summarizeRefund({
      plan: { action: 'reverse', transferId: 'tr_1', amountCents: 4000 },
      reversed: true,
      tip: 'transferred',
    });

    expect(pending.reason).not.toBe(transferred.reason);
    expect(pending.reason).not.toContain('já foi repassada ao motorista');
    expect(pending.reason).toContain('NÃO se pode afirmar');
    expect(pending.reason).toContain('gorjeta');
  });

  test('continua sendo pendência humana (não vira silêncio)', () => {
    const r = summarizeRefund({
      plan: { action: 'reverse', transferId: 'tr_1', amountCents: 4000 },
      reversed: true,
      tip: 'charged_payout_pending',
    });
    expect(r.needsAttention).toBe(true);
    // A gorjeta não fala sobre a tarifa: a tarifa fechou.
    expect(r.balanced).toBe(true);
    expect(r.unrecoveredCents).toBe(0);
  });

  test('não apaga uma pendência da tarifa que já existia', () => {
    const r = summarizeRefund({
      plan: { action: 'reverse', transferId: 'tr_1', amountCents: 4000 },
      reversed: false,
      reversalError: 'balance_insufficient',
      tip: 'charged_payout_pending',
    });
    expect(r.needsAttention).toBe(true);
    expect(r.balanced).toBe(false);
    expect(r.unrecoveredCents).toBe(4000);
    expect(r.reason).toContain('balance_insufficient');
    expect(r.tipCode).toBe('tip_payout_pending');
  });

  test('as quatro situações de gorjeta produzem quatro códigos distintos', () => {
    const codes = (['none', 'transferred', 'charged_payout_pending', 'charged_not_transferred'] as const)
      .map((tip) => summarizeRefund({
        plan: { action: 'skip', reason: 'nothing_transferred' },
        reversed: false,
        tip,
      }).tipCode);
    expect(new Set(codes).size).toBe(4);
    expect(codes).toEqual([
      'tip_none',
      'tip_transferred_not_refunded',
      'tip_payout_pending',
      'tip_charged_never_transferable',
    ]);
  });
});
