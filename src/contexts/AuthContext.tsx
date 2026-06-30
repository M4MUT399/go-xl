/**
 * AuthContext — estado de autenticação compartilhado em toda a árvore.
 *
 * Por que isso existe:
 *   Antes, cada componente chamava useAuth() e tinha seu próprio useState.
 *   Isso significa que AddCardOnboardingScreen.refreshProfile() atualizava
 *   apenas o estado local da tela, nunca o do AppNavigator — então a
 *   navegação para PassengerTabs nunca acontecia.
 *
 *   Com o Context, há um único store. refreshProfile() atualiza todos os
 *   consumidores ao mesmo tempo.
 */
import React, { createContext, useContext, useState, useEffect } from 'react';
import { supabase, isInvalidRefreshTokenError, clearStaleSession } from '../lib/supabase';
import { uploadImage } from '../lib/storage';
import type { Profile, UserType } from '../types';
import type { Session, AuthError } from '@supabase/supabase-js';
import type { PostgrestError } from '@supabase/supabase-js';

// ─── Tipos ────────────────────────────────────────────────────────────────────

type AnySupabaseError = AuthError | PostgrestError | null | undefined;

interface AuthContextValue {
  session:        Session | null;
  profile:        Profile | null;
  loading:        boolean;
  /** true quando o usuário chegou via deep link de recuperação de senha —
   *  trava a navegação na tela de redefinição até a senha ser atualizada. */
  isRecovery:     boolean;
  markRecovery:   () => void;
  clearRecovery:  () => void;
  updatePassword: (newPassword: string) => Promise<{ error: AnySupabaseError }>;
  resetPasswordForEmail: (email: string) => Promise<{ error: AnySupabaseError }>;
  signIn:         (email: string, password: string) => Promise<{ error: AnySupabaseError }>;
  signUp:         (
    email: string,
    password: string,
    fullName: string,
    phone: string,
    type: UserType,
    options?: { language?: string; avatarUri?: string }
  ) => Promise<{ error: AnySupabaseError }>;
  signOut:        () => Promise<void>;
  refreshProfile: () => Promise<void>;
  /** Atualiza campos do profile localmente (sem nova query ao Supabase).
   *  Útil após uma operação de escrita para disparar re-render imediato. */
  patchProfile:   (updates: Partial<Profile>) => void;
}

// ─── Contexto ─────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextValue | null>(null);

// ─── Provider ─────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRecovery, setIsRecovery] = useState(false);

  useEffect(() => {
    let settled = false;

    // ── Failsafe: a splash NUNCA pode ficar presa ─────────────────────────────
    // Qualquer ponto da inicialização (getSession, fetchProfile) pode pendurar
    // em rede ruim ou num lock interno do gotrue que não libera. Sem um limite,
    // `loading` ficaria true para sempre e o app congelaria na tela de carregar
    // (o sintoma exato relatado na build da App Store). Após 8s liberamos a
    // navegação de qualquer forma: sem sessão o usuário cai no login, que é um
    // estado seguro e recuperável — bem melhor do que travar indefinidamente.
    const failsafe = setTimeout(() => {
      if (!settled) {
        settled = true;
        setLoading(false);
      }
    }, 8000);

    supabase.auth
      .getSession()
      .then(async ({ data: { session }, error }) => {
        if (error && isInvalidRefreshTokenError(error)) {
          await clearStaleSession();
          setSession(null);
          setProfile(null);
          settled = true;
          setLoading(false);
          return;
        }
        setSession(session);
        if (session) await fetchProfile(session.user.id);
        else setLoading(false);
        settled = true;
      })
      .catch(async (err) => {
        if (isInvalidRefreshTokenError(err)) await clearStaleSession();
        setSession(null);
        setProfile(null);
        settled = true;
        setLoading(false);
      });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (event === 'TOKEN_REFRESHED' && !session) {
        clearStaleSession();
        setSession(null);
        setProfile(null);
        setLoading(false);
        return;
      }
      setSession(session);
      if (session) await fetchProfile(session.user.id);
      else {
        setProfile(null);
        setLoading(false);
      }
    });

    return () => {
      clearTimeout(failsafe);
      subscription.unsubscribe();
    };
  }, []);

  async function fetchProfile(userId: string) {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();
    setProfile(data);
    setLoading(false);
  }

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error };
  }

  async function signUp(
    email: string,
    password: string,
    fullName: string,
    phone: string,
    type: UserType,
    options?: { language?: string; avatarUri?: string }
  ) {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error || !data.user) return { error };

    const userId = data.user.id;

    let avatarUrl: string | undefined;
    if (options?.avatarUri) {
      try {
        avatarUrl = await uploadImage('avatars', options.avatarUri, userId);
      } catch {
        // não bloqueia o cadastro se o upload falhar
      }
    }

    const { error: profileError } = await supabase.from('profiles').insert({
      id: userId,
      full_name: fullName,
      phone,
      email,
      type,
      rating: 5.0,
      total_rides: 0,
      language: options?.language ?? 'en',
      ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
    });

    return { error: profileError };
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  function markRecovery() {
    setIsRecovery(true);
  }

  function clearRecovery() {
    setIsRecovery(false);
  }

  async function updatePassword(newPassword: string) {
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    return { error };
  }

  async function resetPasswordForEmail(email: string) {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: 'goxl://reset-password',
    });
    return { error };
  }

  async function refreshProfile() {
    if (session?.user.id) await fetchProfile(session.user.id);
  }

  function patchProfile(updates: Partial<Profile>) {
    setProfile(prev => {
      if (prev) return { ...prev, ...updates };
      // profile ainda não carregou (null) — constrói um mínimo válido a partir
      // da sessão para que o AppNavigator consiga re-renderizar e navegar.
      // Só passageiros chegam aqui via onboarding de cartão.
      if (!session?.user) return prev;
      return {
        id:         session.user.id,
        full_name:  '',
        phone:      '',
        email:      session.user.email ?? '',
        type:       'passenger',
        created_at: new Date().toISOString(),
        ...updates,
      } as Profile;
    });
  }

  const value: AuthContextValue = {
    session,
    profile,
    loading,
    isRecovery,
    markRecovery,
    clearRecovery,
    updatePassword,
    resetPasswordForEmail,
    signIn,
    signUp,
    signOut,
    refreshProfile,
    patchProfile,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useAuthContext(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuthContext deve ser usado dentro de <AuthProvider>');
  }
  return ctx;
}
