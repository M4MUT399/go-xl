import { useCallback, useEffect, useState } from 'react';
import { supabase, supabaseUrl } from '../lib/supabase';

/**
 * useTripShare — cria e revoga o link PÚBLICO de rastreio ao vivo (Tarefa 1).
 *
 * Modelo de segurança (ver migration 0044 + Edge Function track-trip):
 *   • O link carrega apenas um TOKEN opaco e aleatório (trip_shares.token,
 *     default gen_random_uuid) — não adivinhável, sem relação com o id da corrida.
 *   • A página pública NÃO lê o banco via RLS: quem serve os dados é a Edge
 *     Function track-trip (verify_jwt=false) usando service_role, que valida o
 *     token + expiração e devolve só campos whitelistados (posição, rota, ETA,
 *     motorista+veículo, status). Nunca telefone/e-mail/preço.
 *   • TTL de segurança: mesmo que a corrida não encerre "limpo", o link morre em
 *     MAX_TTL_MS. A função também trata corrida completed/cancelled como inativa.
 *   • Envio é SEMPRE pelo share sheet nativo (ação do passageiro) — nunca
 *     automático/silencioso.
 */

// Teto de validade do link. A Edge Function já encerra o rastreio quando a
// corrida termina; este TTL é só a rede de segurança para o caso de a corrida
// nunca fechar "limpo" (app fechado, etc.).
const MAX_TTL_MS = 6 * 60 * 60 * 1000; // 6h

export interface CreatedShare {
  token: string;
  url: string;
}

function urlForToken(token: string): string {
  return `${supabaseUrl}/functions/v1/track-trip?token=${encodeURIComponent(token)}`;
}

export function useTripShare(rideId: string | undefined) {
  const [creating, setCreating] = useState(false);
  // true quando existe um compartilhamento vigente (não revogado, não expirado)
  // desta corrida — controla o botão "Parar de compartilhar" na UI.
  const [active, setActive] = useState(false);

  /** Reconsulta se há um share vigente para a corrida. */
  const refresh = useCallback(async () => {
    if (!rideId) {
      setActive(false);
      return;
    }
    try {
      const { data: userData } = await supabase.auth.getUser();
      const uid = userData.user?.id;
      if (!uid) {
        setActive(false);
        return;
      }
      const { data } = await supabase
        .from('trip_shares')
        .select('id')
        .eq('ride_id', rideId)
        .eq('created_by', uid)
        .is('revoked_at', null)
        .gt('expires_at', new Date().toISOString())
        .limit(1)
        .maybeSingle();
      setActive(!!data);
    } catch {
      /* mantém o último estado conhecido */
    }
  }, [rideId]);

  useEffect(() => { refresh(); }, [refresh]);

  /**
   * Garante um link ativo para a corrida e devolve-o. Reaproveita um share ainda
   * válido (não revogado e não expirado) para não gerar links duplicados a cada
   * toque; caso contrário, cria um novo.
   */
  const createShare = useCallback(
    async (contactId?: string | null): Promise<CreatedShare | null> => {
      if (!rideId) return null;
      setCreating(true);
      try {
        const { data: userData } = await supabase.auth.getUser();
        const uid = userData.user?.id;
        if (!uid) return null;

        const nowIso = new Date().toISOString();

        // 1) Reaproveita um share vigente desta corrida.
        const { data: existing } = await supabase
          .from('trip_shares')
          .select('token, expires_at, revoked_at')
          .eq('ride_id', rideId)
          .eq('created_by', uid)
          .is('revoked_at', null)
          .gt('expires_at', nowIso)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();

        if (existing?.token) {
          setActive(true);
          return { token: existing.token as string, url: urlForToken(existing.token as string) };
        }

        // 2) Cria um novo (token é gerado pelo default da coluna no banco).
        const expiresAt = new Date(Date.now() + MAX_TTL_MS).toISOString();
        const { data: created, error } = await supabase
          .from('trip_shares')
          .insert({
            ride_id: rideId,
            created_by: uid,
            contact_id: contactId ?? null,
            expires_at: expiresAt,
          })
          .select('token')
          .single();

        if (error || !created?.token) return null;
        setActive(true);
        return { token: created.token as string, url: urlForToken(created.token as string) };
      } catch {
        return null;
      } finally {
        setCreating(false);
      }
    },
    [rideId],
  );

  /**
   * Parada manual: revoga TODOS os shares vigentes da corrida (o passageiro
   * decidiu parar de compartilhar). A Edge Function passa a responder inativo.
   */
  const revokeShare = useCallback(async (): Promise<boolean> => {
    if (!rideId) return false;
    try {
      const { data: userData } = await supabase.auth.getUser();
      const uid = userData.user?.id;
      if (!uid) return false;

      const { error } = await supabase
        .from('trip_shares')
        .update({ revoked_at: new Date().toISOString() })
        .eq('ride_id', rideId)
        .eq('created_by', uid)
        .is('revoked_at', null);

      if (!error) setActive(false);
      return !error;
    } catch {
      return false;
    }
  }, [rideId]);

  return { creating, active, createShare, revokeShare, refresh };
}
