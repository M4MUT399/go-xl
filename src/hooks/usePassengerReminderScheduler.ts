import { useEffect } from 'react';
import { AppState } from 'react-native';
import { supabase } from '../lib/supabase';
import { syncPassengerReminders } from '../lib/passengerReminders';

/**
 * Mantém os lembretes locais de agendamento do PASSAGEIRO sempre atualizados.
 * Espelha useDriverReminderScheduler, mas para as corridas que o passageiro
 * agendou (passenger_id = ele).
 *
 * Reagenda quando:
 *   - o hook monta (app aberto / login),
 *   - o app volta ao primeiro plano (cobre reabertura perto do horário),
 *   - qualquer corrida DELE muda no banco (agendada/confirmada/cancelada) via realtime.
 *
 * No-op quando `passengerId` é indefinido (motorista ou ainda carregando o perfil),
 * então pode ser chamado incondicionalmente no topo do AppNavigator.
 */
export function usePassengerReminderScheduler(passengerId: string | undefined) {
  useEffect(() => {
    if (!passengerId) return;

    let active = true;
    const run = () => {
      if (active) syncPassengerReminders(passengerId);
    };

    run(); // agenda ao entrar

    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') run();
    });

    // Realtime: mudanças nas corridas deste passageiro → reagenda do zero.
    const channel = supabase
      .channel(`passenger-reminders-${passengerId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'rides', filter: `passenger_id=eq.${passengerId}` },
        run
      )
      .subscribe();

    return () => {
      active = false;
      appStateSub.remove();
      supabase.removeChannel(channel);
    };
  }, [passengerId]);
}
