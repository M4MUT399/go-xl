import React, { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useAuth } from '../../hooks/useAuth';
import { useDriverRideContext } from '../../contexts/DriverRideContext';
import { getConfig, getConfigDefault } from '../../lib/systemConfig';
import { logRideOfferEvent } from '../../lib/rideOfferEvents';
import { navigationRef } from '../../navigation/AppNavigator';
import { IncomingRideCall } from './IncomingRideCall';

/**
 * Overlay global da chamada de corrida do motorista.
 *
 * Montado UMA VEZ, como irmão do `NavigationContainer` (ver AppNavigator.tsx),
 * dentro do mesmo `<DriverRideProvider>` — nunca dentro de uma `Stack.Screen`.
 *
 * Motivo: o `<Modal>` nativo usado por `IncomingRideCall` só consegue aparecer
 * se a view que o "possui" estiver na tela ATIVA/em primeiro plano. Como o
 * react-native-screens congela telas anteriores da pilha ao empilhar uma nova,
 * um Modal aberto a partir de uma tela que ficou para trás (ex: DriverHomeScreen
 * enquanto o motorista está em DriverScheduledRides ou DriverNavigate) nunca
 * conseguia se apresentar. Vivendo aqui fora da pilha, o overlay está sempre
 * "no topo" — o banner de chamada aparece não importa em qual tela o
 * motorista esteja.
 */
export function GlobalDriverRideOverlay() {
  const { profile } = useAuth();
  const { pendingRide, setPendingRide, acceptRide, isOnline, location } = useDriverRideContext();
  const [accepting, setAccepting] = useState(false);
  const [callTimeout, setCallTimeout] = useState<number>(getConfigDefault('ride_offer_timeout_seconds'));
  const loggedReceivedRef = useRef<string | null>(null);

  // Carrega o timeout configurável da chamada de corrida (fallback local seguro).
  useEffect(() => {
    getConfig('ride_offer_timeout_seconds').then(setCallTimeout).catch(() => {});
  }, []);

  // Registra 'received' assim que uma nova chamada aparece para este motorista.
  useEffect(() => {
    const id = pendingRide?.id;
    if (id && loggedReceivedRef.current !== id) {
      loggedReceivedRef.current = id;
      logRideOfferEvent(id, profile?.id, 'received');
    }
    if (!id) loggedReceivedRef.current = null;
  }, [pendingRide?.id, profile?.id]);

  if (!pendingRide || !(isOnline || !!pendingRide.driver_id)) return null;

  async function handleAccept() {
    if (!pendingRide) return;
    setAccepting(true);
    const ride = await acceptRide(pendingRide.id, location ? { lat: location.lat, lng: location.lng } : null);
    setAccepting(false);
    if (ride === 'payment_error') {
      Alert.alert('Pagamento recusado', 'O cartão do passageiro foi recusado. A corrida não pôde ser aceita.');
      setPendingRide(null);
    } else if (ride) {
      // Passa a localização atual do motorista como origem inicial da rota —
      // assim o mapa em DriverNavigateScreen já traça o caminho até o
      // passageiro NA HORA, sem esperar um novo fix de GPS daquela tela.
      if (navigationRef.isReady()) {
        navigationRef.navigate('DriverNavigate', {
          ride,
          initialDriverLocation: location ? { lat: location.lat, lng: location.lng } : undefined,
        });
      }
    } else {
      Alert.alert('Ops', 'Corrida já foi aceita por outro motorista.');
      setPendingRide(null);
    }
  }

  function handleReject() {
    if (pendingRide) logRideOfferEvent(pendingRide.id, profile?.id, 'rejected');
    setPendingRide(null);
  }

  function handleExpire() {
    if (pendingRide) logRideOfferEvent(pendingRide.id, profile?.id, 'expired');
    setPendingRide(null);
  }

  return (
    <IncomingRideCall
      ride={pendingRide}
      driverLocation={location ? { lat: location.lat, lng: location.lng } : null}
      timeoutSeconds={callTimeout}
      accepting={accepting}
      isQrLocked={!!pendingRide.driver_id}
      onAccept={handleAccept}
      onReject={handleReject}
      onExpire={handleExpire}
    />
  );
}
