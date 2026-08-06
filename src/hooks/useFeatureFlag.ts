import { useEffect, useState } from 'react';
import { getConfig, getConfigDefault, type ConfigKey } from '../lib/systemConfig';

/**
 * useFeatureFlag — lê uma flag booleana de rollout gradual do system_config,
 * com valor síncrono imediato (o DEFAULT local) enquanto a query resolve.
 *
 * Serve aos rollouts por bloco (câmera / navegação course-up / jornada v2):
 * o componente já renderiza com o padrão seguro e "religa" sozinho quando o
 * valor configurado (possivelmente por jurisdição) chega do backend. Reaproveita
 * o cache/fallback de getConfig — nunca deixa o app sem valor.
 *
 * @param key  chave booleana em CONFIG_DEFAULTS (ex.: 'camera_controller_enabled').
 * @returns o valor atual da flag (default local até a query voltar).
 */
export function useFeatureFlag(key: ConfigKey, jurisdiction: string = 'global'): boolean {
  const [enabled, setEnabled] = useState<boolean>(() => Boolean(getConfigDefault(key)));

  useEffect(() => {
    let alive = true;
    getConfig(key, jurisdiction)
      .then((v) => {
        if (alive) setEnabled(Boolean(v));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [key, jurisdiction]);

  return enabled;
}
