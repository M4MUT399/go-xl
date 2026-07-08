import { useState, useEffect, useCallback } from 'react';
import * as WebBrowser from 'expo-web-browser';
import { callEdgeFunction } from '../lib/edgeFunction';

/**
 * Status da conta Stripe Connect (Express) do motorista.
 *
 * Alimenta o banner de "Configurar recebimento" na EarningsScreen e decide se
 * o botão "Solicitar repasse" pode ser habilitado (só quando payoutsEnabled).
 */
export interface ConnectStatus {
  hasAccount: boolean;
  onboardingComplete: boolean;
  payoutsEnabled: boolean;
  chargesEnabled: boolean;
  needsAttention: boolean;
  disabledReason: string | null;
}

const INITIAL: ConnectStatus = {
  hasAccount: false,
  onboardingComplete: false,
  payoutsEnabled: false,
  chargesEnabled: false,
  needsAttention: false,
  disabledReason: null,
};

export function useConnectAccount(driverId: string | undefined) {
  const [status, setStatus] = useState<ConnectStatus>(INITIAL);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [onboarding, setOnboarding] = useState(false);

  const refresh = useCallback(async () => {
    if (!driverId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const json = await callEdgeFunction<ConnectStatus>('connect-account-status');
      setStatus({ ...INITIAL, ...json });
    } catch (e: any) {
      setError(e?.message ?? 'Não foi possível verificar sua conta de recebimento.');
    } finally {
      setLoading(false);
    }
  }, [driverId]);

  useEffect(() => { refresh(); }, [refresh]);

  /**
   * Abre o onboarding Express no navegador e reconsulta o status ao voltar.
   * Usa o mesmo padrão do cadastro de cartão (setup-card → WebBrowser).
   *
   * openAuthSessionAsync (em vez de openBrowserAsync) fecha o navegador
   * SOZINHO assim que o Stripe redireciona para goxl://payout-return — o
   * motorista nunca vê nenhuma página web intermediária.
   */
  const startOnboarding = useCallback(async (): Promise<{ ok: boolean; error?: string }> => {
    setOnboarding(true);
    try {
      const json = await callEdgeFunction<{ url?: string }>('connect-onboard-driver');
      if (!json.url) throw new Error('Não foi possível abrir o cadastro de recebimento.');
      await WebBrowser.openAuthSessionAsync(json.url, 'goxl://payout-return');
      await refresh();
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? 'Não foi possível iniciar o cadastro.' };
    } finally {
      setOnboarding(false);
    }
  }, [refresh]);

  return { status, loading, error, onboarding, refresh, startOnboarding };
}
