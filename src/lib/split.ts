export const DRIVER_SHARE = 0.80;   // 80% para o motorista
export const PLATFORM_SHARE = 0.20; // 20% para o app

export interface Split {
  driverAmount: number;
  platformFee: number;
}

export function calculateSplit(totalPrice: number): Split {
  const driverAmount = Math.round(totalPrice * DRIVER_SHARE * 100) / 100;
  const platformFee = Math.round((totalPrice - driverAmount) * 100) / 100;
  return { driverAmount, platformFee };
}
