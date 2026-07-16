import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '../hooks/useAuth';
import { useLocation } from '../hooks/useLocation';
import { useDriverRide } from '../hooks/useRide';
import { useDutyIdleTracker } from '../hooks/useDutyIdleTracker';
import { useDutyMovementTracker } from '../hooks/useDutyMovementTracker';
import { useDriverPeriodTracker } from '../hooks/useDriverPeriodTracker';
import type { DriverPeriod } from '../lib/driverPeriodMachine';
import { supabase } from '../lib/supabase';
import type { Coordinates } from '../types';
import type { IdleSegment } from '../lib/drivingLimits';
import { updateCarActiveRide, updateCarRideOffer } from '../native/carRideBridge';

type UseDriverRideReturn = ReturnType<typeof useDriverRide>;

interface DriverRideContextValue extends UseDriverRideReturn {
  isOnline: boolean;
  /** true após carregar o valor persistido no AsyncStorage. */
  onlineLoaded: boolean;
  setIsOnline: (value: boolean) => void;
  location: Coordinates | null;
  /** Item 1: períodos parado do turno atual (alimenta o limite de direção). */
  dutyIdleSegments: IdleSegment[];
  /** Bloco 2: minutos de jornada pela máquina por movimento (0 se flag off). */
  dutyMovementMinutes: number;
  /** Bloco 2: true quando a contagem por movimento (v2) está habilitada. */
  dutyMovementEnabled: boolean;
  /** Bloco 1 (compliance TNC): período legal P0-P3 atual (ver driverPeriodMachine.ts). */
  driverPeriod: DriverPeriod;
  /** Bloco 1: true quando o tracking de período (`period_tracking_v1_enabled`) está habilitado. */
  driverPeriodEnabled: boolean;
}

const DriverRideContext = createContext<DriverRideContextValue | null>(null);

/**
 * Provider único, montado uma vez no topo da árvore do app do motorista
 * (ver AppNavigator.tsx) — sobrevive à navegação entre TODAS as telas
 * (Mapa, Agenda, Ganhos, Navegação, Perfil, etc.).
 *
 * Antes disso, `useDriverRide` (assinatura realtime + polling de novas
 * corridas) só era chamado dentro de `DriverHomeScreen`, e o overlay de
 * chamada (`IncomingRideCall`) só existia ali também. Como o
 * react-native-screens "congela"/desativa telas anteriores da pilha quando
 * uma nova é empilhada por cima, o `<Modal>` nativo da chamada não
 * conseguia aparecer se o motorista estivesse em qualquer outra tela — o
 * banner ficava "preso" atrás da tela ativa. Elevar o estado (e o overlay)
 * para fora de qualquer `Stack.Screen` resolve isso: a chamada de corrida
 * agora aparece não importa onde o motorista esteja no app.
 */
export function DriverRideProvider({ children }: { children: ReactNode }) {
  const { profile } = useAuth();
  const [isOnline, setIsOnlineState] = useState(false);
  const [onlineLoaded, setOnlineLoaded] = useState(false);

  // Carrega o status online salvo ao montar (persiste entre sessões).
  useEffect(() => {
    AsyncStorage.getItem('driver_is_online').then((val) => {
      if (val === 'true') setIsOnlineState(true);
      setOnlineLoaded(true);
    });
  }, []);

  const setIsOnline = useCallback((val: boolean) => {
    setIsOnlineState(val);
    AsyncStorage.setItem('driver_is_online', val ? 'true' : 'false');
  }, []);

  // GPS SEMPRE monitorado (watch: true), inclusive OFFLINE — o mapa do motorista
  // continua acompanhando o deslocamento mesmo com o status offline (o motorista
  // pediu esse comportamento). O que muda com online/offline não é a leitura do
  // GPS, e sim se a posição é PUBLICADA no servidor (ver os dois efeitos abaixo)
  // e se a jornada acumula (a máquina por movimento só conta online).
  const { location } = useLocation({ watch: true });
  // Espelho da última posição — usado pelo efeito de status (que não deve
  // re-disparar a cada fix de GPS, só quando o online/offline muda).
  const locationRef = useRef<Coordinates | null>(location);
  locationRef.current = location;

  // Item 1: acompanha a ociosidade (veículo parado) do turno atual a partir da
  // velocidade do GPS. Vive aqui — global — para captar também o movimento
  // durante a corrida (tela de Navegação), não só o da Home.
  const dutyIdleSegments = useDutyIdleTracker(isOnline, location?.speed);

  // Bloco 2: contagem de jornada pela máquina de estados por MOVIMENTO
  // (persistida por timestamps epoch, sobrevive a kill/reboot; emite transições
  // à trilha de auditoria). Roda em paralelo ao v1, mas é no-op enquanto a flag
  // `duty_movement_v2_enabled` estiver desligada (padrão) — não altera a regra
  // de descanso atual até o rollout por jurisdição.
  const { enabled: dutyMovementEnabled, workedMinutes: dutyMovementMinutes } = useDutyMovementTracker(
    profile?.id,
    isOnline,
    location?.speed,
  );

  // Bloco 1 (compliance TNC F.S. 627.748): máquina de períodos P0-P3, dirigida
  // por eventos de SERVIDOR (driver_locations/rides via realtime), não pelo
  // `isOnline`/`ride` locais — ver comentário em useDriverPeriodTracker.ts.
  // No-op enquanto `period_tracking_v1_enabled` estiver desligada (padrão).
  const { enabled: driverPeriodEnabled, period: driverPeriod } = useDriverPeriodTracker(
    profile?.id,
    profile?.jurisdiction,
    location,
  );

  // Publica a POSIÇÃO ao vivo no banco APENAS quando ONLINE — é o que o
  // passageiro vê em tempo real. Offline, o GPS continua rodando localmente
  // (mapa/jornada), mas a posição NÃO é rastreada no servidor (privacidade do
  // motorista fora de serviço). Vive aqui — e não em DriverHomeScreen — para
  // continuar publicando mesmo em outra tela (Navegação, Agenda, etc.), já que
  // este Provider nunca é desmontado.
  useEffect(() => {
    if (!location || !profile?.id || !onlineLoaded || !isOnline) return;
    supabase.from('driver_locations').upsert({
      driver_id: profile.id,
      lat: location.lat,
      lng: location.lng,
      heading: location.heading ?? null,
      is_online: true,
      updated_at: new Date().toISOString(),
    });
  }, [location, isOnline, profile?.id, onlineLoaded]);

  // Escreve a TRANSIÇÃO de status (online↔offline) no servidor sempre que ela
  // muda — inclusive ao ficar OFFLINE (para o passageiro deixar de ver o
  // motorista e o tracker de período registrar WENT_OFFLINE). Dispara só na
  // mudança de `isOnline` (usa `locationRef` para não re-rodar a cada fix).
  useEffect(() => {
    if (!profile?.id || !onlineLoaded) return;
    const loc = locationRef.current;
    supabase.from('driver_locations').upsert({
      driver_id: profile.id,
      is_online: isOnline,
      updated_at: new Date().toISOString(),
      ...(loc ? { lat: loc.lat, lng: loc.lng, heading: loc.heading ?? null } : {}),
    });
  }, [isOnline, profile?.id, onlineLoaded]);

  const ride = useDriverRide(profile?.id, profile?.jurisdiction);

  // ── Ponte com Android Auto (ver src/native/carRideBridge.ts) ────────────────
  // Empurra a chamada pendente e a corrida ativa para a tela do carro sempre
  // que mudam. No-op em iOS/Web (o módulo nativo só existe no Android) — ver
  // comentário em carRideBridge.ts. A ação de aceitar/recusar disparada pelos
  // botões do carro é OUVIDA em GlobalDriverRideOverlay.tsx, não aqui: aquele
  // componente já concentra handleAccept/handleReject (alerta, navegação,
  // etc.) e não faz sentido duplicar essa lógica.
  useEffect(() => {
    updateCarRideOffer(ride.pendingRide);
  }, [ride.pendingRide]);

  useEffect(() => {
    updateCarActiveRide(ride.activeRide);
  }, [ride.activeRide]);

  const value: DriverRideContextValue = {
    ...ride,
    isOnline,
    onlineLoaded,
    setIsOnline,
    location,
    dutyIdleSegments,
    dutyMovementMinutes,
    dutyMovementEnabled,
    driverPeriod,
    driverPeriodEnabled,
  };

  return <DriverRideContext.Provider value={value}>{children}</DriverRideContext.Provider>;
}

export function useDriverRideContext(): DriverRideContextValue {
  const ctx = useContext(DriverRideContext);
  if (!ctx) {
    throw new Error('useDriverRideContext deve ser usado dentro de <DriverRideProvider>.');
  }
  return ctx;
}
