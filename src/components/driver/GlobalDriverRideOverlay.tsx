import React, { useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useAuth } from '../../hooks/useAuth';
import { useDriverRideContext } from '../../contexts/DriverRideContext';
import { getConfig, getConfigDefault } from '../../lib/systemConfig';
import { logRideOfferEvent } from '../../lib/rideOfferEvents';
import { dismissRideNotifications } from '../../lib/notifications';
import { offerAlertManager } from '../../lib/offerAlertManager';
import { navigationRef } from '../../navigation/AppNavigator';
import { supabase } from '../../lib/supabase';
import { IncomingRideCall } from './IncomingRideCall';
import { useTranslation } from '../../i18n';

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
  const { t } = useTranslation();
  const {
    pendingRide, setPendingRide, acceptRide, isOnline, location,
    resumableRide, clearResumableRide,
  } = useDriverRideContext();
  const [accepting, setAccepting] = useState(false);
  const [callTimeout, setCallTimeout] = useState<number>(getConfigDefault('ride_offer_timeout_seconds'));
  const loggedReceivedRef = useRef<string | null>(null);
  const resumeHandledIdRef = useRef<string | null>(null);

  // ─── Retomada de corrida ativa após relançamento do app ────────────────────
  // Se o motorista tinha uma corrida accepted/driver_en_route/in_progress e o
  // app foi morto/crashou (ver useDriverRide), `resumableRide` chega
  // preenchido no fetch inicial. Sem isto, DriverNavigateScreen nunca é
  // remontada sozinha e a corrida fica "presa" — passageiro esperando e
  // motorista sem tela de navegação ativa. Tenta navegar assim que o
  // navigationRef estiver pronto, com retry (mesma lógica de espera usada no
  // ActiveRideScreen para overlays nativos bloqueando a navegação).
  useEffect(() => {
    if (!resumableRide) return;
    if (resumeHandledIdRef.current === resumableRide.id) return;
    let stopped = false;
    function attemptResume() {
      if (stopped || !resumableRide) return;
      if (!navigationRef.isReady()) return;
      resumeHandledIdRef.current = resumableRide.id;
      stopped = true;
      navigationRef.navigate('DriverNavigate', {
        ride: resumableRide,
        initialDriverLocation: location ? { lat: location.lat, lng: location.lng } : undefined,
      });
      clearResumableRide();
    }
    attemptResume();
    const retry = setInterval(attemptResume, 800);
    return () => {
      stopped = true;
      clearInterval(retry);
    };
  }, [resumableRide, location, clearResumableRide]);

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
    const pendingId = pendingRide.id;
    // TERMINAL(accepted): silêncio IMEDIATO no toque em ACEITAR — antes de
    // qualquer trabalho lento (cobrança do cartão pode levar ~20s). Lapida o id.
    offerAlertManager.stopAll(pendingId, 'accepted');
    setAccepting(true);
    const ride = await acceptRide(pendingId, location ? { lat: location.lat, lng: location.lng } : null);
    setAccepting(false);
    // Independente do desfecho, a oferta deixou de estar pendente para ESTE
    // motorista — tira a notificação da bandeja dele também.
    dismissRideNotifications(pendingId);
    if (ride === 'payment_error') {
      Alert.alert(t('rideOverlay.paymentDeclinedTitle'), t('rideOverlay.paymentDeclinedMessage'));
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
      Alert.alert(t('rideOverlay.alreadyTakenTitle'), t('rideOverlay.alreadyTakenMessage'));
      setPendingRide(null);
    }
  }

  function handleReject() {
    if (pendingRide) {
      // TERMINAL(declined): PARA O SOM ANTES de qualquer chamada de rede — não
      // espera o backend para silenciar. Lapida o id (re-oferta não re-toca).
      offerAlertManager.stopAll(pendingRide.id, 'declined');
      logRideOfferEvent(pendingRide.id, profile?.id, 'rejected');
      releaseQrLockedRide(pendingRide);
      dismissRideNotifications(pendingRide.id);
    }
    setPendingRide(null);
  }

  function handleExpire() {
    if (pendingRide) {
      // TERMINAL(expired): esgotou o tempo da chamada.
      offerAlertManager.stopAll(pendingRide.id, 'expired');
      logRideOfferEvent(pendingRide.id, profile?.id, 'expired');
      releaseQrLockedRide(pendingRide);
      dismissRideNotifications(pendingRide.id);
    }
    setPendingRide(null);
  }

  /**
   * Corrida travada por QR (driver_id pré-fixado ao motorista dono do QR, ver
   * requestRide/notifySpecificDriver) é exclusiva dele — por design, nenhum
   * outro motorista vê o card (ver useDriverRide: filtro `!ride.driver_id ||
   * ride.driver_id === driverId`). Sem isso, ao recusar/deixar expirar, o
   * driver_id nunca era liberado: o polling de 4s (`driver_id=eq.<este
   * motorista>` + `status=requesting`) reencontrava a MESMA corrida no ciclo
   * seguinte e reabria o card indefinidamente, e o passageiro ficava preso
   * numa corrida que nenhum motorista jamais aceitaria.
   *
   * Cancela a corrida para o passageiro (reaproveitando o mesmo fluxo/alerta
   * de "nenhum motorista disponível" que FindingDriverScreen já trata) em vez
   * de devolver ao pool aberto — o QR foi escaneado pensando NESTE motorista
   * específico, então um "não" dele não deve virar chamada geral.
   */
  function releaseQrLockedRide(ride: { id: string; driver_id?: string | null }) {
    if (!ride.driver_id) return; // corrida do pool aberto — nada a liberar
    supabase
      .from('rides')
      .update({ status: 'cancelled' })
      .eq('id', ride.id)
      .eq('driver_id', ride.driver_id)
      .eq('status', 'requesting')
      .then(() => {});
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
