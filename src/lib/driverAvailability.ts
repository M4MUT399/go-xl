// driverAvailability — pergunta ao servidor se há motorista disponível perto do
// embarque, antes de o passageiro entrar na tela de busca (migration 0093).
//
// `null` = não deu para saber (rede, limite de taxa, build nova com servidor
// antigo, resposta lenta). Nesse caso o pedido segue normalmente: esta consulta
// serve para avisar, e uma falha dela nunca pode impedir alguém de pedir corrida.

import { supabase } from './supabase';

const TIMEOUT_MS = 4000;

export async function driverAvailableNear(
  pickup: { lat: number; lng: number },
  timeoutMs: number = TIMEOUT_MS,
): Promise<boolean | null> {
  const consulta = (async (): Promise<boolean | null> => {
    try {
      const { data, error } = await supabase.rpc('driver_available_near', {
        p_lat: pickup.lat,
        p_lng: pickup.lng,
      });
      return !error && typeof data === 'boolean' ? data : null;
    } catch {
      return null;
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const prazo = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const resposta = await Promise.race([consulta, prazo]);
  if (timer) clearTimeout(timer);
  return resposta;
}
