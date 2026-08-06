import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from '../lib/supabase';
import { getConfig, getConfigDefault } from '../lib/systemConfig';
import { useAuth } from './useAuth';
import { useBackgroundCheck } from './useBackgroundCheck';
import {
  evaluateOnboardingGate,
  type OnboardingGateReason,
} from '../lib/driverOnboardingGate';

export type DriverOnboardingGateState = {
  /** TODOS os motivos de bloqueio aplicáveis (não só o primeiro) — Bloco 3. */
  reasons: OnboardingGateReason[];
  canGoOnline: boolean;
  /** A jurisdição exige aceite do disclosure legal para ficar online? */
  disclosureRequired: boolean;
  /** Versão vigente do disclosure (resolvida por jurisdição → global). */
  disclosureVersion: string;
  /** O motorista já tem uma linha de aceite para a versão vigente? */
  disclosureAccepted: boolean;
  /** Bloco 4: o motorista tem alguma suspensão ativa (driver_suspensions, lifted_at nulo)? */
  safetySuspended: boolean;
  /** Chama a RPC `accept_driver_disclosure` e recarrega o estado. */
  acceptDisclosure: () => Promise<boolean>;
  refresh: () => Promise<void>;
};

/** Chave fixa do disclosure de compliance TNC (Bloco 3) — mesma usada na migration 0059. */
const DISCLOSURE_KEY = 'tnc_driver_disclosure';

/**
 * useDriverOnboardingGate — Bloco 3 (compliance TNC F.S. 627.748): compõe TODOS
 * os gates legais/operacionais do motorista numa só leitura, reutilizando
 * `useBackgroundCheck` (P7) para o registro/veredito de background check e
 * somando as peças NOVAS deste bloco (recheck trienal, desqualificação já
 * persistida, disclosure legal). A REGRA em si mora inteira em
 * `evaluateOnboardingGate` (src/lib/driverOnboardingGate.ts) — este hook só
 * busca os dados e entrega o resultado; a mesma regra roda no servidor via
 * `driver_can_go_online()` (migration 0059), então o cliente NUNCA é a
 * autoridade final — é só para dar o aviso certo na hora certa.
 *
 * Bloco 4 (F.S. 627.748): também lê `safetySuspended` (veredito JÁ
 * PERSISTIDO de `driver_suspensions`, lifted_at nulo — ver
 * safetyIncidents.ts) pelo mesmo motivo — o cliente só LÊ, nunca decide
 * suspensão a partir de denúncias brutas.
 *
 * `backgroundCheckDisqualified` é passado como o veredito JÁ PERSISTIDO
 * (`driver_background_checks.disqualified`) — o hook nunca reavalia achados
 * brutos no cliente (ver comentário em driverOnboardingGate.ts).
 */
export function useDriverOnboardingGate(): DriverOnboardingGateState {
  const { profile } = useAuth();
  const driverId = profile?.id;
  const jurisdiction = profile?.jurisdiction ?? 'global';
  const bgCheck = useBackgroundCheck(driverId);

  const [disqualified, setDisqualified] = useState(false);
  const [recheckYears, setRecheckYears] = useState<number>(getConfigDefault('background_check_recheck_years'));
  const [disclosureRequired, setDisclosureRequired] = useState<boolean>(getConfigDefault('driver_disclosure_required'));
  const [disclosureVersion, setDisclosureVersion] = useState<string>(getConfigDefault('driver_disclosure_version'));
  const [disclosureAccepted, setDisclosureAccepted] = useState(false);
  // Bloco 4: veredito JÁ PERSISTIDO de suspensão ativa (driver_suspensions,
  // lifted_at nulo) — mesmo princípio de `disqualified` acima: o hook só LÊ,
  // nunca reavalia denúncias brutas (ver safetyIncidents.ts).
  const [safetySuspended, setSafetySuspended] = useState(false);
  const channelId = useRef(Math.random().toString(36).slice(2)).current;

  // Config resolvida por jurisdição (uma vez; getConfig tem cache de 60s).
  useEffect(() => {
    let alive = true;
    Promise.all([
      getConfig('background_check_recheck_years', jurisdiction),
      getConfig('driver_disclosure_required', jurisdiction),
      getConfig('driver_disclosure_version', jurisdiction),
    ]).then(([years, required, version]) => {
      if (!alive) return;
      setRecheckYears(years);
      setDisclosureRequired(required);
      setDisclosureVersion(version);
    }).catch(() => {});
    return () => { alive = false; };
  }, [jurisdiction]);

  // Veredito de desqualificação já persistido — mesma linha lida por useBackgroundCheck,
  // mas o hook de P7 não expõe essa coluna (é específica do Bloco 3), então buscamos à parte.
  const refreshDisqualification = useCallback(async () => {
    if (!driverId) { setDisqualified(false); return; }
    const { data } = await supabase
      .from('driver_background_checks')
      .select('disqualified')
      .eq('driver_id', driverId)
      .order('created_at', { ascending: false })
      .limit(1);
    setDisqualified(Boolean((data && data[0] as { disqualified?: boolean } | undefined)?.disqualified));
  }, [driverId]);

  const refreshDisclosureAcceptance = useCallback(async () => {
    if (!driverId) { setDisclosureAccepted(false); return; }
    const { data } = await supabase
      .from('driver_disclosure_acceptances')
      .select('id')
      .eq('driver_id', driverId)
      .eq('disclosure_key', DISCLOSURE_KEY)
      .eq('version', disclosureVersion)
      .limit(1);
    setDisclosureAccepted(!!(data && data.length > 0));
  }, [driverId, disclosureVersion]);

  // Bloco 4: existe alguma suspensão ainda não levantada? (RLS já permite o
  // próprio motorista ler suas linhas em driver_suspensions.)
  const refreshSuspension = useCallback(async () => {
    if (!driverId) { setSafetySuspended(false); return; }
    const { data } = await supabase
      .from('driver_suspensions')
      .select('id')
      .eq('driver_id', driverId)
      .is('lifted_at', null)
      .limit(1);
    setSafetySuspended(!!(data && data.length > 0));
  }, [driverId]);

  const refresh = useCallback(async () => {
    await Promise.all([bgCheck.refresh(), refreshDisqualification(), refreshDisclosureAcceptance(), refreshSuspension()]);
  }, [bgCheck, refreshDisqualification, refreshDisclosureAcceptance, refreshSuspension]);

  useEffect(() => { refreshDisqualification(); }, [refreshDisqualification]);
  useEffect(() => { refreshDisclosureAcceptance(); }, [refreshDisclosureAcceptance]);
  useEffect(() => { refreshSuspension(); }, [refreshSuspension]);

  // Realtime: reflete o veredito de desqualificação/suspensão assim que persistido.
  useEffect(() => {
    if (!driverId) return;
    const channel = supabase
      .channel(`onboarding-gate-${driverId}-${channelId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'driver_background_checks', filter: `driver_id=eq.${driverId}` }, () => {
        refreshDisqualification();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'driver_disclosure_acceptances', filter: `driver_id=eq.${driverId}` }, () => {
        refreshDisclosureAcceptance();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'driver_suspensions', filter: `driver_id=eq.${driverId}` }, () => {
        refreshSuspension();
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [driverId, channelId, refreshDisqualification, refreshDisclosureAcceptance, refreshSuspension]);

  const acceptDisclosure = useCallback(async (): Promise<boolean> => {
    const { error } = await supabase.rpc('accept_driver_disclosure', {
      p_disclosure_key: DISCLOSURE_KEY,
      p_version: disclosureVersion,
    });
    if (error) return false;
    await refreshDisclosureAcceptance();
    return true;
  }, [disclosureVersion, refreshDisclosureAcceptance]);

  const { reasons, canGoOnline } = evaluateOnboardingGate({
    verificationStatus: profile?.verification_status,
    backgroundCheckRequired: bgCheck.required,
    backgroundCheckRecord: bgCheck.record,
    disqualificationFindings: null,
    backgroundCheckDisqualified: disqualified,
    backgroundCheckRecheckYears: recheckYears,
    stripeChargesEnabled: !!profile?.stripe_charges_enabled,
    stripePayoutsEnabled: !!profile?.stripe_payouts_enabled,
    disclosureRequired,
    disclosureAccepted,
    safetySuspended,
  });

  return {
    reasons,
    canGoOnline,
    disclosureRequired,
    disclosureVersion,
    disclosureAccepted,
    safetySuspended,
    acceptDisclosure,
    refresh,
  };
}
