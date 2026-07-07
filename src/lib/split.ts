// Divisão de receita por corrida (modelo "Separate Charges & Transfers").
//
// A plataforma cobra o passageiro e, semanalmente, repassa a fatia do motorista.
// A fatia do motorista NÃO é mais um valor global fixo: cada motorista tem sua
// própria `driver_share_percent`, decidida no onboarding (85% para os 100
// primeiros; 80% do 101º em diante) e gravada em profiles.driver_share_percent.
//
// Como no PEDIDO o motorista ainda é desconhecido (pool aberto), o split gravado
// na criação da corrida usa o padrão (DEFAULT_DRIVER_SHARE) e é RECALCULADO na
// aceitação com a fatia real do motorista que aceitou. Ver useRide.ts (acceptRide
// e os fluxos de agendamento).

/** Fatia padrão do motorista quando a específica ainda não é conhecida (pool aberto). */
export const DEFAULT_DRIVER_SHARE = 0.80;

/**
 * @deprecated Preferir a `driver_share_percent` por motorista. Mantido como
 * fallback de exibição (ex.: EarningsScreen estima ganhos de corridas antigas
 * sem driver_amount gravado).
 */
export const DRIVER_SHARE = DEFAULT_DRIVER_SHARE; // 80% para o motorista
export const PLATFORM_SHARE = 1 - DEFAULT_DRIVER_SHARE; // 20% para o app

export interface Split {
  driverAmount: number;
  platformFee: number;
}

/**
 * Calcula a divisão de uma tarifa.
 * @param totalPrice         valor sobre o qual incide o split (tarifa, sem pedágio/taxas).
 * @param driverSharePercent fatia do motorista (0..1). Default = DEFAULT_DRIVER_SHARE.
 */
export function calculateSplit(
  totalPrice: number,
  driverSharePercent: number = DEFAULT_DRIVER_SHARE,
): Split {
  // Guarda contra valores inválidos vindos do banco (NULL/negativo/>1).
  const share =
    Number.isFinite(driverSharePercent) && driverSharePercent > 0 && driverSharePercent <= 1
      ? driverSharePercent
      : DEFAULT_DRIVER_SHARE;
  const driverAmount = Math.round(totalPrice * share * 100) / 100;
  const platformFee = Math.round((totalPrice - driverAmount) * 100) / 100;
  return { driverAmount, platformFee };
}
