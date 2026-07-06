import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '../hooks/useAuth';
import { useLocation } from '../hooks/useLocation';
import { useDriverRide } from '../hooks/useRide';
import { supabase } from '../lib/supabase';
import type { Coordinates } from '../types';

type UseDriverRideReturn = ReturnType<typeof useDriverRide>;

interface DriverRideContextValue extends UseDriverRideReturn {
  isOnline: boolean;
  /** true após carregar o valor persistido no AsyncStorage. */
  onlineLoaded: boolean;
  setIsOnline: (value: boolean) => void;
  location: Coordinates | null;
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

  // watch: true → posição contínua enquanto online (banco atualiza a cada ≥15 m).
  const { location } = useLocation({ watch: isOnline });

  // Sincroniza localização + status online no banco (só após carregar o valor
  // persistido). Vive aqui — e não em DriverHomeScreen — para continuar
  // atualizando mesmo enquanto o motorista está em outra tela (Navegação,
  // Agenda, etc.), já que este Provider nunca é desmontado.
  useEffect(() => {
    if (!location || !profile?.id || !onlineLoaded) return;
    supabase.from('driver_locations').upsert({
      driver_id: profile.id,
      lat: location.lat,
      lng: location.lng,
      heading: location.heading ?? null,
      is_online: isOnline,
      updated_at: new Date().toISOString(),
    });
  }, [location, isOnline, profile?.id, onlineLoaded]);

  const ride = useDriverRide(profile?.id);

  const value: DriverRideContextValue = {
    ...ride,
    isOnline,
    onlineLoaded,
    setIsOnline,
    location,
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
