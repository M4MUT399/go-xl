import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { getConfig, getConfigDefault } from '../lib/systemConfig';
import {
  shouldPromptDriverConfirmation,
  canConfirmDriver,
  type BoardingConfirmationInput,
} from '../lib/driverBoardingConfirmation';
import type { Ride } from '../types';

export type UseDriverBoardingConfirmationState = {
  /** A jurisdição pede/exige a confirmação (config `driver_confirmation_required`). */
  confirmationRequired: boolean;
  /** Deve mostrar o prompt de confirmação agora (regra pura, ver driverBoardingConfirmation.ts). */
  shouldPrompt: boolean;
  confirming: boolean;
  /** Chama a RPC `confirm_driver_before_boarding` e devolve sucesso/falha. */
  confirm: () => Promise<boolean>;
};

/**
 * useDriverBoardingConfirmation -- Bloco 4 (compliance TNC F.S. 627.748):
 * decide se o app do PASSAGEIRO deve pedir a confirmacao de foto+placa do
 * motorista antes do embarque, e expoe a acao de confirmar (RPC
 * `confirm_driver_before_boarding`, migration 0060 -- carimba
 * `rides.passenger_confirmed_driver_at` no servidor). A REGRA mora inteira em
 * `shouldPromptDriverConfirmation`/`canConfirmDriver`
 * (src/lib/driverBoardingConfirmation.ts) -- este hook so busca o flag de
 * config e chama a RPC. NAO bloqueia nada no servidor (ver "DECISAO DE
 * DESIGN" na migration 0060 e no topo do modulo puro) -- e so o prompt.
 *
 * `hasVehicleAssigned` e recebido a parte (nao lido de `ride.vehicle`) porque
 * as telas de passageiro hoje resolvem o veiculo via hook dedicado
 * (`useDriverVehicle(ride.driver_id)`, nao um join embutido em `Ride`).
 */
export function useDriverBoardingConfirmation(
  ride: Ride,
  hasVehicleAssigned: boolean,
  jurisdiction: string = 'global'
): UseDriverBoardingConfirmationState {
  const [confirmationRequired, setConfirmationRequired] = useState<boolean>(
    getConfigDefault('driver_confirmation_required')
  );
  const [confirming, setConfirming] = useState(false);
  // Espelha o carimbo do servidor localmente para refletir a confirmacao sem
  // esperar o proximo refetch da linha de `rides` (mesmo espirito de
  // `refreshDisclosureAcceptance` no hook do Bloco 3).
  const [confirmedAt, setConfirmedAt] = useState<string | undefined>(ride.passenger_confirmed_driver_at);

  useEffect(() => { setConfirmedAt(ride.passenger_confirmed_driver_at); }, [ride.passenger_confirmed_driver_at]);

  useEffect(() => {
    let alive = true;
    getConfig('driver_confirmation_required', jurisdiction)
      .then((v) => { if (alive) setConfirmationRequired(v); })
      .catch(() => {});
    return () => { alive = false; };
  }, [jurisdiction]);

  const input: BoardingConfirmationInput = {
    rideStatus: ride.status,
    hasDriverAssigned: !!ride.driver_id,
    hasVehicleAssigned,
    alreadyConfirmed: !!confirmedAt,
    confirmationRequired,
  };

  const shouldPrompt = shouldPromptDriverConfirmation(input);

  const confirm = useCallback(async (): Promise<boolean> => {
    const check = canConfirmDriver(input);
    if (!check.ok) return false;
    setConfirming(true);
    const { error } = await supabase.rpc('confirm_driver_before_boarding', { p_ride_id: ride.id });
    setConfirming(false);
    if (error) return false;
    setConfirmedAt(new Date().toISOString());
    return true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ride.id, input.rideStatus, input.hasDriverAssigned, input.hasVehicleAssigned, input.alreadyConfirmed]);

  return { confirmationRequired, shouldPrompt, confirming, confirm };
}
