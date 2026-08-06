// nav/sharedRouteClient — ponte fina do app com a Edge Function compute-route
// (Bloco 3). NÃO é puro (fala com a rede), por isso fica fora de smoothMarker/
// sharedRoute e não entra nos testes unitários. É "best-effort": qualquer falha
// é engolida e logada — a tela cai no comportamento legado (cliente calcula a
// própria rota) sem quebrar a corrida.

import { supabase } from '../supabase';

export interface ComputeRouteResult {
  version: number;
  etaMin: number;
  distanceKm: number;
}

/**
 * Pede ao servidor para (re)calcular a rota única da corrida e incrementar
 * route_version. Só o MOTORISTA da corrida tem permissão (a função valida).
 * Devolve o resultado ou null em qualquer falha (rede, permissão, sem rota).
 */
export async function requestServerRoute(rideId: string): Promise<ComputeRouteResult | null> {
  try {
    const { data, error } = await supabase.functions.invoke('compute-route', {
      body: { rideId },
    });
    if (error) {
      console.log('[GOXL route] compute-route error:', error.message);
      return null;
    }
    const r = data as Partial<ComputeRouteResult> | null;
    if (!r || typeof r.version !== 'number') return null;
    return { version: r.version, etaMin: r.etaMin ?? 0, distanceKm: r.distanceKm ?? 0 };
  } catch (e) {
    console.log('[GOXL route] compute-route threw:', (e as Error).message);
    return null;
  }
}
