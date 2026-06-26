import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

/**
 * Detecta erros de refresh token inválido/expirado.
 * Quando o token salvo no dispositivo está corrompido ou expirou, o gotrue
 * lança "AuthApiError: Invalid Refresh Token". Em vez de deixar o erro
 * estourar na tela, limpamos a sessão silenciosamente e devolvemos o usuário
 * para a tela de login.
 */
export function isInvalidRefreshTokenError(error: unknown): boolean {
  if (!error) return false;
  const msg =
    typeof error === 'string'
      ? error
      : (error as { message?: string }).message ?? '';
  return /refresh token|refresh_token_not_found|invalid.*token/i.test(msg);
}

/** Limpa qualquer sessão inválida persistida no dispositivo. */
export async function clearStaleSession(): Promise<void> {
  try {
    await supabase.auth.signOut({ scope: 'local' });
  } catch {
    // ignora — apenas garantimos que nada quebre a UI
  }
}
