import { createClient } from '@supabase/supabase-js';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Credenciais públicas do projeto Supabase.
 *
 * A URL e a publishable key (`sb_publishable_…`) são, por definição, públicas:
 * elas são embarcadas em TODO bundle do cliente e já estão versionadas no
 * eas.json. A segurança dos dados vem das políticas RLS, não do sigilo dessas
 * strings. Por isso podemos usá-las como fallback embutido.
 *
 * Por que o fallback existe:
 *   Não há arquivo .env no repositório — as variáveis EXPO_PUBLIC_* são
 *   injetadas só em tempo de build (eas.json). Se essa injeção falhar (build
 *   antigo, perfil sem `env`, etc.), `createClient('', '')` LANÇA
 *   "supabaseUrl is required" no carregamento do módulo e o app trava na splash
 *   nativa antes de renderizar qualquer coisa. O fallback garante que o cliente
 *   sempre receba credenciais válidas e o app nunca quebre na inicialização.
 */
const FALLBACK_SUPABASE_URL = 'https://zukydkodafdmhaulhxeh.supabase.co';
const FALLBACK_SUPABASE_ANON_KEY = 'sb_publishable_Tu3TmYgQa6gOII2X-AbDLg_A0eLlIbd';

// Exportadas para reuso em chamadas `fetch` cruas (upload de foto, PATCH de
// perfil). O caminho de escrita/upload interno do supabase-js trava no
// dispositivo (corpo ArrayBuffer / caminho autenticado), então algumas telas
// replicam o padrão comprovado do edgeFunction.ts: getSession() fresco + fetch.
export const supabaseUrl =
  process.env.EXPO_PUBLIC_SUPABASE_URL?.trim() || FALLBACK_SUPABASE_URL;
export const supabaseAnonKey =
  process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim() || FALLBACK_SUPABASE_ANON_KEY;

if (__DEV__ && !process.env.EXPO_PUBLIC_SUPABASE_URL) {
  console.warn(
    '[supabase] EXPO_PUBLIC_SUPABASE_URL ausente — usando fallback embutido. ' +
      'Defina as variáveis no .env (dev) ou no eas.json (build).',
  );
}

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
