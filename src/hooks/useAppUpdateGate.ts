import { useEffect, useState } from 'react';
import { getConfigValue } from '../lib/systemConfig';
import { versaoDoApp } from '../lib/appVersion';
import {
  TRAVA_DESLIGADA,
  lerConfigTrava,
  precisaAtualizar,
  type ConfigTravaVersao,
} from '../lib/minAppVersion';

/**
 * useAppUpdateGate — decide se ESTA build ainda pode ser usada.
 *
 * É a metade GENTIL da trava de versão: explica e oferece o link da loja. A
 * metade com dentes é o trigger da migration 0081, que recusa o INSERT em
 * `rides` no servidor. Ver o cabeçalho de src/lib/minAppVersion.ts para por que
 * as duas precisam existir — resumo: este código não chega ao aparelho que já
 * está velho hoje.
 *
 * ── LÊ UMA VEZ, NA MONTAGEM ────────────────────────────────────────────────
 *
 * Não fica repolando. Uma versão mínima é decisão rara — o admin sobe o número
 * quando publica —, e o aparelho que abrir o app depois disso vai ler o valor
 * novo na próxima abertura. Vigiar em tempo real gastaria bateria para
 * emparedar alguém no meio do uso, que é pior que deixar terminar o que estava
 * fazendo.
 *
 * ── COMEÇA LIBERANDO ───────────────────────────────────────────────────────
 *
 * `bloquear` nasce false e só vira true se a config disser. Se a leitura falhar
 * (offline, tabela ausente), `getConfigValue` devolve o fallback DESLIGADO e
 * nada acontece. Um app que se emparedou por não conseguir falar com o servidor
 * seria pior que um app velho: viraria tijolo exatamente quando a rede está
 * ruim.
 */
export function useAppUpdateGate(): { bloquear: boolean; cfg: ConfigTravaVersao } {
  const [cfg, setCfg] = useState<ConfigTravaVersao>(TRAVA_DESLIGADA);
  const [bloquear, setBloquear] = useState(false);

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const bruto = await getConfigValue<unknown>('min_app_version', TRAVA_DESLIGADA);
        if (!vivo) return;
        const lida = lerConfigTrava(bruto);
        setCfg(lida);
        setBloquear(precisaAtualizar(versaoDoApp(), lida.min));
      } catch {
        // Silêncio proposital: falha de leitura NÃO bloqueia.
      }
    })();
    return () => {
      vivo = false;
    };
  }, []);

  return { bloquear, cfg };
}
