/**
 * Onboarding — helpers de estado do passageiro.
 *
 * Dois fluxos de entrada, decididos pelo produto:
 *
 *  A) Download normal (App Store / Play): cadastro (nome/e-mail/telefone)
 *     PRIMEIRO. O cartão é exigido só quando o passageiro chama a 1ª corrida.
 *
 *  B) Via QR do motorista (Expresso): CARTÃO primeiro, para a 1ª corrida sair
 *     rápido. A conta é criada com um nome provisório e SEM telefone; o cadastro
 *     completo (nome/e-mail/telefone) é cobrado quando o passageiro agenda ou
 *     pede a 2ª viagem.
 *
 * Marcador de "cadastro incompleto": telefone vazio. Todo cadastro normal exige
 * telefone, então a ausência dele identifica com segurança as contas expressas
 * ainda não completadas — sem precisar de coluna nova no banco (migration).
 */
import type { Profile } from '../types';

/** Nome provisório das contas expressas antes do cadastro completo. */
export const EXPRESS_PLACEHOLDER_NAME = 'Passageiro GoXL';

/** true quando o passageiro tem um cartão salvo (pode ser cobrado). */
export function hasPaymentCard(profile: Profile | null | undefined): boolean {
  return !!profile?.stripe_payment_method_id;
}

/** true quando o cadastro está completo (tem telefone real informado). */
export function isProfileComplete(profile: Profile | null | undefined): boolean {
  return !!profile?.phone && profile.phone.trim().length > 0;
}
