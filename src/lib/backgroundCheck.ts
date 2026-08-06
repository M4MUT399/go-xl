// backgroundCheck — verificação de antecedentes do motorista (P7).
//
// PRINCÍPIO DE PRIVACIDADE (regra dura do projeto):
//   • NUNCA armazenar SSN puro (nem qualquer PII sensível) no banco do GoXL.
//   • O PII é coletado DIRETAMENTE pelo provider (ex.: fluxo hospedado do
//     Stripe Identity). O app NUNCA recebe nem repassa o SSN. Guardamos apenas
//     um TOKEN de referência do provider (`providerRef`) + o status resultante.
//   • Por isso a interface abaixo NÃO tem parâmetro de SSN/PII. `initiate` só
//     recebe o id do motorista e devolve a referência tokenizada da sessão.
//
// Provider abstrato, configurável por jurisdição (system_config):
//   • MockBackgroundCheckProvider — determinístico, para testes/rollout.
//   • StripeIdentityProvider — stub; a integração real cria a sessão via Edge
//     Function (server-side, com a secret key) e recebe o resultado por webhook.
import { getConfig } from './systemConfig';

/** Estados possíveis de um background check. */
export type CheckStatus =
  | 'not_started' // nunca iniciado
  | 'pending'     // aguardando o provider concluir
  | 'clear'       // aprovado
  | 'consider'    // requer revisão manual (achou algo)
  | 'failed';     // reprovado/erro definitivo

export type BackgroundCheckProviderName = 'mock' | 'stripe_identity';

/** Registro persistido (sem PII): só referência tokenizada + status. */
export type BackgroundCheckRecord = {
  provider: string;
  /** Token de referência do provider — NÃO é PII. */
  providerRef: string;
  status: CheckStatus;
  /** ISO. Quando o check foi concluído (clear/consider/failed). */
  checkedAt: string | null;
  /** ISO. A partir de quando o check aprovado expira e precisa renovar. */
  expiresAt: string | null;
};

/** Resultado de iniciar um check — o que persistimos após `initiate`. */
export type InitiateResult = {
  providerRef: string;
  status: CheckStatus;
};

export interface BackgroundCheckProvider {
  readonly name: BackgroundCheckProviderName;
  /**
   * Inicia uma sessão de verificação para o motorista. NÃO recebe PII: o
   * provider coleta os dados sensíveis diretamente do usuário no seu fluxo.
   * Devolve a referência tokenizada + status inicial.
   */
  initiate(driverId: string): Promise<InitiateResult>;
}

/**
 * MockBackgroundCheckProvider — determinístico. Gera uma referência estável a
 * partir do driverId e devolve 'pending' (simula um check assíncrono). Útil
 * para testes e para exercitar o fluxo sem provider real.
 */
export class MockBackgroundCheckProvider implements BackgroundCheckProvider {
  readonly name = 'mock' as const;
  async initiate(driverId: string): Promise<InitiateResult> {
    return { providerRef: `mock_${driverId}`, status: 'pending' };
  }
}

/**
 * StripeIdentityProvider — stub. A integração real:
 *   1) chama uma Edge Function que cria uma VerificationSession no Stripe;
 *   2) devolve o client_secret/URL para o app abrir o fluxo hospedado;
 *   3) recebe o veredito por webhook e atualiza o status no banco.
 * Enquanto não implementado, lança para não ser selecionado em produção sem o
 * trabalho de integração.
 */
export class StripeIdentityProvider implements BackgroundCheckProvider {
  readonly name = 'stripe_identity' as const;
  async initiate(_driverId: string): Promise<InitiateResult> {
    throw new Error('StripeIdentityProvider ainda não implementado');
  }
}

/** Cria o provider a partir do nome configurado. Default: mock. */
export function makeBackgroundCheckProvider(name: string): BackgroundCheckProvider {
  switch (name) {
    case 'stripe_identity':
      return new StripeIdentityProvider();
    case 'mock':
    default:
      return new MockBackgroundCheckProvider();
  }
}

/**
 * isCheckValid — o motorista tem um check válido? (puro, testável)
 * Válido = status 'clear' E (sem expiração OU ainda não expirou).
 */
export function isCheckValid(
  record: BackgroundCheckRecord | null | undefined,
  now: Date = new Date()
): boolean {
  if (!record || record.status !== 'clear') return false;
  if (!record.expiresAt) return true;
  const exp = new Date(record.expiresAt).getTime();
  if (Number.isNaN(exp)) return false;
  return exp > now.getTime();
}

/**
 * canDriverGoOnline — decide se o gate de background check permite ficar online.
 * Se a feature está desligada (`required=false`), sempre permite → preserva o
 * comportamento atual. Se ligada, exige um check válido.
 */
export function canDriverGoOnline(
  required: boolean,
  record: BackgroundCheckRecord | null | undefined,
  now: Date = new Date()
): boolean {
  if (!required) return true;
  return isCheckValid(record, now);
}

/** Dias inteiros até expirar (>=0). Null se não houver expiração/registro. */
export function daysUntilExpiry(
  record: BackgroundCheckRecord | null | undefined,
  now: Date = new Date()
): number | null {
  if (!record?.expiresAt) return null;
  const exp = new Date(record.expiresAt).getTime();
  if (Number.isNaN(exp)) return null;
  const diffMs = exp - now.getTime();
  return Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)));
}

/**
 * startBackgroundCheck — resolve o provider configurado e inicia a verificação.
 * Devolve a referência tokenizada + status para o app persistir. Em erro,
 * devolve status 'failed' sem lançar (o chamador decide como mostrar).
 */
export async function startBackgroundCheck(
  driverId: string,
  jurisdiction: string = 'global'
): Promise<InitiateResult> {
  try {
    const name = await getConfig('background_check_provider', jurisdiction);
    const provider = makeBackgroundCheckProvider(String(name));
    return await provider.initiate(driverId);
  } catch {
    return { providerRef: '', status: 'failed' };
  }
}
