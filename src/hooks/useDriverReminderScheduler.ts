import { useEffect } from 'react';
import { AppState } from 'react-native';
import { supabase } from '../lib/supabase';
import { syncDriverReminders } from '../lib/driverReminders';

/**
 * Mantém os lembretes locais de agendamento do motorista sempre atualizados.
 *
 * Reagenda quando:
 *   - o hook monta (app aberto / login),
 *   - o app volta ao primeiro plano (cobre reabertura perto do horário),
 *   - qualquer corrida DELE muda no banco (aceita/liberada/cancelada) via realtime.
 *
 * No-op quando `driverId` é indefinido (passageiro ou ainda carregando o perfil),
 * então pode ser chamado incondicionalmente no topo do AppNavigator.
 */
export function useDriverReminderScheduler(driverId: string | undefined) {
  useEffect(() => {
    if (!driverId) return;

    let active = true;
    const run = () => {
      if (active) syncDriverReminders(driverId);
    };

    run(); // agenda ao entrar

    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') run();
    });

    // Realtime: mudanças nas corridas deste motorista → reagenda do zero.
    const channel = supabase
      .channel(`driver-reminders-${driverId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rides', filter: `driver_id=eq.${driverId}` },
        run
      )
      .subscribe();

    return () => {
      active = false;
      appStateSub.remove();
      supabase.removeChannel(channel);
    };
  }, [driverId]);
}
