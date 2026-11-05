// connectOrphan — reconhecer uma conta Connect que esta plataforma não alcança,
// e decidir quando a conta nova pode assumir o lugar dela (migration 0094).
//
// "Órfã" é decisão de dinheiro: o resultado cria outra conta de recebimento. Por
// isso só contam erros específicos da Stripe — qualquer outra falha (rede, 500,
// chave sem permissão) é "não sei" e não mexe em nada. A mesma lista e a mesma
// trava de supabase/scripts/clear_orphan_connect.ts.

const ORPHAN_MESSAGE =
  /does not have access to account|No such account|not connected to your platform/i;

/** O erro da Stripe diz, sem ambiguidade, que a conta não é alcançável? */
export function isOrphanAccountError(e: unknown): boolean {
  const err = e as { raw?: { message?: string }; message?: string } | null | undefined;
  const msg = err?.raw?.message ?? err?.message ?? '';
  return ORPHAN_MESSAGE.test(msg);
}

/**
 * A chave consegue distinguir "não é minha" de "não posso ler"? Só uma chave de
 * produção que lista contas consegue: com uma de teste, toda conta real parece
 * inexistente; com uma restrita, toda conta parece sem acesso.
 */
export async function keyCanJudgeOrphans(
  secretKey: string,
  listAccounts: () => Promise<unknown>,
): Promise<boolean> {
  if (!/^(sk|rk)_live_/.test(secretKey)) return false;
  try {
    await listAccounts();
    return true;
  } catch {
    return false;
  }
}

/** A conta nova já pode receber sem tirar o motorista do ar? */
export function canPromote(account: { charges_enabled?: boolean; payouts_enabled?: boolean }): boolean {
  return account.charges_enabled === true && account.payouts_enabled === true;
}

/** O motorista já concluiu o cadastro, a ponto de existir painel para abrir? */
export function canOpenDashboard(account: { details_submitted?: boolean }): boolean {
  return account.details_submitted === true;
}
