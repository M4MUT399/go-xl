export const KM_TO_MILES = 0.621371;

export function formatCurrency(value: number | string | undefined | null): string {
  const n = Number(value) || 0;
  return `$${n.toFixed(2)}`;
}

export function kmToMiles(km: number | string | undefined | null): number {
  return (Number(km) || 0) * KM_TO_MILES;
}

export function formatDistance(km: number | string | undefined | null): string {
  return `${kmToMiles(km).toFixed(1)} mi`;
}
