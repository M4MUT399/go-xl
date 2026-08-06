/**
 * Estado efêmero de corrida expressa (QR → novo passageiro).
 * Guardado em memória entre a tela ExpressRegisterScreen e o AppNavigator.
 * Consumido uma única vez — após consumir, zera automaticamente.
 */

let _driverId:   string | null = null;
let _driverName: string | null = null;

export function setPendingExpressRide(driverId: string, driverName: string) {
  _driverId   = driverId;
  _driverName = driverName;
}

export function consumePendingExpressRide(): { driverId: string; driverName: string } | null {
  if (!_driverId) return null;
  const result = { driverId: _driverId, driverName: _driverName ?? '' };
  _driverId   = null;
  _driverName = null;
  return result;
}
