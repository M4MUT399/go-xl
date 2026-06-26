/**
 * Guarda global contra rejeições de promise de rede não tratadas.
 *
 * O cliente Supabase (auto-refresh de sessão, realtime e algumas queries)
 * pode rejeitar com "TypeError: Network request failed" quando a conexão
 * oscila por um instante. Esses erros são transitórios — a próxima tentativa
 * se recupera sozinha — mas, sem tratamento, o React Native os reporta como
 * "Possible Unhandled Promise Rejection", o que no Expo Go vira aquele toast
 * vermelho no rodapé da tela.
 *
 * Este módulo intercepta o rastreador de rejeições do RN e engole APENAS os
 * erros de rede benignos, deixando todos os outros seguirem o fluxo normal de
 * log. Não altera a semântica das requisições — apenas evita o ruído visual.
 */

function isBenignNetworkError(error: unknown): boolean {
  if (!error) return false;
  const msg =
    typeof error === 'string'
      ? error
      : (error as { message?: string })?.message ?? String(error);
  return /network request failed|network error|fetch failed|aborted/i.test(msg);
}

export function installNetworkErrorGuard(): void {
  try {
    // Caminho usado internamente pelo React Native para rastrear rejeições.
    // Envolto em require dinâmico + try/catch para não quebrar caso mude.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const tracking = require('promise/setimmediate/rejection-tracking');
    tracking.enable({
      allRejections: true,
      onUnhandled: (id: number, error: unknown) => {
        if (isBenignNetworkError(error)) return; // ignora ruído de rede
        // Mantém o comportamento padrão para erros reais.
        console.warn(`Possible Unhandled Promise Rejection (id: ${id}):`, error);
      },
      onHandled: () => {},
    });
  } catch {
    // Se o rastreador não estiver disponível nesta versão, seguimos sem ele.
  }
}
