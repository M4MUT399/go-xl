import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { getConfig, getConfigDefault } from '../lib/systemConfig';
import {
  canDriverGoOnline,
  isCheckValid,
  daysUntilExpiry,
  type BackgroundCheckRecord,
  type CheckStatus,
} from '../lib/backgroundCheck';

export type BackgroundCheckState = {
  /** Registro mais recente do motorista (ou null se nunca iniciou). */
  record: BackgroundCheckRecord | null;
  status: CheckStatus;
  /** A jurisdição exige check aprovado para ficar online? */
  required: boolean;
  /** Há um check aprovado e ainda válido? */
  valid: boolean;
  /** O gate permite ficar online? (sempre true quando required=false) */
  canGoOnline: boolean;
  /** Dias até expirar (ou null). */
  daysToExpiry: number | null;
  refresh: () => Promise<void>;
};

/** Mapeia a linha do banco para o registro sem PII usado pela lib pura. */
function toRecord(row: {
  provider?: string;
  provider_ref?: string;
  status?: string;
  checked_at?: string | null;
  expires_at?: string | null;
} | null): BackgroundCheckRecord | null {
  if (!row) return null;
  return {
    provider: row.provider ?? 'mock',
    providerRef: row.provider_ref ?? '',
    status: (row.status as CheckStatus) ?? 'not_started',
    checkedAt: row.checked_at ?? null,
    expiresAt: row.expires_at ?? null,
  };
}

/**
 * useBackgroundCheck — lê o background check mais recente do motorista (P7) e
 * calcula o gate de disponibilidade. Desligado por padrão (required=false) →
 * canGoOnline sempre true, preservando o comportamento atual. A CRIAÇÃO/veredito
 * do check é responsabilidade do backend (Edge Function + webhook do provider);
 * este hook é somente leitura + regra de gate.
 */
export function useBackgroundCheck(driverId: string | undefined): BackgroundCheckState {
  const [record, setRecord] = useState<BackgroundCheckRecord | null>(null);
  const [required, setRequired] = useState<boolean>(getConfigDefault('background_check_required'));
  const channelId = useRef(Math.random().toString(36).slice(2)).current;

  const refresh = useCallback(async () => {
    if (!driverId) {
      setRecord(null);
      return;
    }
    const { data } = await supabase
      .from('driver_background_checks')
      .select('provider, provider_ref, status, checked_at, expires_at')
      .eq('driver_id', driverId)
      .order('created_at', { ascending: false })
      .limit(1);
    setRecord(toRecord((data && data[0]) ?? null));
  }, [driverId]);

  // Carrega a flag configurável (uma vez; getConfig tem cache de 60s).
  useEffect(() => {
    let alive = true;
    getConfig('background_check_required')
      .then((v) => { if (alive) setRequired(v); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Realtime: reflete a atualização do veredito vinda do webhook do provider.
  useEffect(() => {
    if (!driverId) return;
    const channel = supabase
      .channel(`bgcheck-${driverId}-${channelId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'driver_background_checks', filter: `driver_id=eq.${driverId}` }, () => {
        refresh();
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [driverId, refresh, channelId]);

  const valid = isCheckValid(record);
  const canGoOnline = canDriverGoOnline(required, record);
  const status: CheckStatus = record?.status ?? 'not_started';
  const daysToExpiry = daysUntilExpiry(record);

  return { record, status, required, valid, canGoOnline, daysToExpiry, refresh };
}
