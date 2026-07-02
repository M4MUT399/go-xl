import { useState, useEffect } from 'react';
import { getWaybillConfig, type WaybillCompany } from '../lib/waybill';

export type WaybillConfigState = {
  /** A jurisdição habilita a geração/compartilhamento do waybill? */
  enabled: boolean;
  /** Dados legais da empresa (vazios enquanto não configurados). */
  company: WaybillCompany;
  loading: boolean;
};

/**
 * useWaybillConfig — lê a configuração do waybill (feature flag + empresa) para
 * a jurisdição, de forma assíncrona. Enquanto carrega, `enabled` fica false, de
 * modo que a UI só mostra a ação de recibo depois de confirmar que está ligada.
 * Somente leitura: não gera nada, apenas expõe o estado para gate de UI.
 */
export function useWaybillConfig(jurisdiction: string = 'global'): WaybillConfigState {
  const [state, setState] = useState<WaybillConfigState>({
    enabled: false,
    company: { legalName: '', licenseNumber: '', footerNote: '' },
    loading: true,
  });

  useEffect(() => {
    let alive = true;
    getWaybillConfig(jurisdiction)
      .then(({ enabled, company }) => {
        if (alive) setState({ enabled, company, loading: false });
      })
      .catch(() => {
        if (alive) setState((s) => ({ ...s, loading: false }));
      });
    return () => { alive = false; };
  }, [jurisdiction]);

  return state;
}
