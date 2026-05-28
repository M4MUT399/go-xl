import * as WebBrowser from 'expo-web-browser';
import { supabase } from './supabase';

export interface CheckoutResult {
  status: 'completed' | 'cancelled' | 'error';
  error?: string;
}

/**
 * Cria uma sessão de Stripe Checkout (via Edge Function) e abre a página
 * de pagamento no navegador. Retorna quando o usuário fecha o navegador.
 *
 * Como o Stripe Checkout exige success_url https, o retorno ao app é manual
 * (o usuário fecha o navegador). Aqui tratamos o fechamento como conclusão
 * otimista — adequado para modo de teste/MVP.
 */
export async function startCheckout(amount: number, description: string, rideId?: string): Promise<CheckoutResult> {
  const { data, error } = await supabase.functions.invoke('create-checkout', {
    body: { amount, description, rideId },
  });

  if (error) return { status: 'error', error: error.message };
  if (!data?.url) return { status: 'error', error: data?.error ?? 'Falha ao iniciar pagamento' };

  const result = await WebBrowser.openBrowserAsync(data.url, {
    dismissButtonStyle: 'done',
    showTitle: true,
  });

  // openBrowserAsync resolve quando o usuário fecha o navegador.
  return { status: result.type === 'cancel' ? 'cancelled' : 'completed' };
}
