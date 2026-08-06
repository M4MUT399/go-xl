// Ponte JS -> Android Auto (item "ponte de dados" do backlog, escopo MVP
// "status + aceitar/recusar" — ver plugins/withAndroidAuto.js e
// plugins/android-auto-src/com/goxl/app/carapp/CarRideBridgeModule.kt).
//
// Só existe módulo nativo no Android — no iOS (CarPlay, ainda bloqueado no
// pedido de entitlement da Apple) e na Web, `NativeModules.CarRideBridge` é
// undefined, então toda função aqui vira no-op automaticamente. Nenhuma
// tela do app precisa checar `Platform.OS` antes de chamar isto.

import { NativeEventEmitter, NativeModules, Platform } from 'react-native';
import type { Ride } from '../types';

interface CarRideBridgeNativeModule {
  updateOffer(payload: { id: string; originAddress: string; destinationAddress: string; priceLabel: string } | null): void;
  updateActiveRide(payload: { id: string; status: string; originAddress: string; destinationAddress: string } | null): void;
  clearAll(): void;
}

const nativeModule: CarRideBridgeNativeModule | undefined =
  Platform.OS === 'android' ? (NativeModules.CarRideBridge as CarRideBridgeNativeModule | undefined) : undefined;

function formatPrice(price?: number): string {
  if (price == null) return '—';
  return `$${price.toFixed(2)}`;
}

/** Chamar sempre que `pendingRide` (chamada imediata) mudar. `null` limpa a tela do carro. */
export function updateCarRideOffer(ride: Ride | null): void {
  if (!nativeModule) return;
  try {
    if (!ride) {
      nativeModule.updateOffer(null);
      return;
    }
    nativeModule.updateOffer({
      id: ride.id,
      originAddress: ride.origin_address ?? ride.origin?.address ?? '',
      destinationAddress: ride.destination_address ?? ride.destination?.address ?? '',
      priceLabel: formatPrice(ride.price),
    });
  } catch {
    // Nunca deixa uma falha na integração com Android Auto quebrar o fluxo
    // principal do app — é uma tela auxiliar, não crítica.
  }
}

/** Chamar sempre que `activeRide` (corrida aceita/em andamento) mudar. `null` limpa a tela do carro. */
export function updateCarActiveRide(ride: Ride | null): void {
  if (!nativeModule) return;
  try {
    if (!ride) {
      nativeModule.updateActiveRide(null);
      return;
    }
    nativeModule.updateActiveRide({
      id: ride.id,
      status: ride.status,
      originAddress: ride.origin_address ?? ride.origin?.address ?? '',
      destinationAddress: ride.destination_address ?? ride.destination?.address ?? '',
    });
  } catch {
    // idem
  }
}

export type CarRideAction = 'accept' | 'reject';

/**
 * Escuta ações disparadas pelos botões Aceitar/Recusar na tela do Android
 * Auto (ver MainCarScreen.kt -> CarRideStateStore.dispatchAction). O
 * listener recebe `rideId` para o chamador confirmar que ainda é a MESMA
 * oferta antes de agir — evita ação tardia sobre uma oferta já
 * expirada/trocada no meio-tempo.
 *
 * Retorna uma função de cleanup — sempre chamar no unmount do efeito.
 */
export function addCarRideActionListener(
  callback: (action: CarRideAction, rideId: string) => void
): () => void {
  if (Platform.OS !== 'android' || !NativeModules.CarRideBridge) {
    return () => {};
  }
  const emitter = new NativeEventEmitter(NativeModules.CarRideBridge);
  const subscription = emitter.addListener(
    'GoXlCarRideAction',
    (event: { action: CarRideAction; rideId: string }) => {
      callback(event.action, event.rideId);
    }
  );
  return () => subscription.remove();
}
