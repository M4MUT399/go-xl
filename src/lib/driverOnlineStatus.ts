/**
 * Decide o que a tela deve mostrar depois de tentar gravar o status
 * online/offline do motorista.
 *
 * Existe separado do contexto porque é a regra que já errou duas vezes, e
 * dentro de um `useEffect` ela não é testável sem montar o app inteiro.
 *
 * ─── OS DOIS ERROS QUE ESTA FUNÇÃO EXISTE PARA NÃO REPETIR ──────────────────
 *
 * 1. RECUSA SILENCIOSA. O trigger da migration 0038 NÃO lança exceção quando o
 *    motorista não tem Stripe Connect aprovado: ele faz `new.is_online := false`
 *    e deixa o `upsert` retornar SUCESSO. Quem só olha `error` conclui que deu
 *    certo e deixa a chave verde por horas, enquanto o servidor tem `false` e
 *    nenhuma corrida chega. Por isso a decisão depende do valor DEVOLVIDO pelo
 *    banco (`returned`), não de ausência de erro.
 *
 * 2. REVERSÃO NO HEARTBEAT DE ABERTURA. A gravação também roda ao abrir o app,
 *    sem ninguém ter tocado na chave. Reverter ali inverte um estado que o
 *    usuário não pediu: abrir o app sem rede estando OFFLINE ligava a chave para
 *    "Online" e persistia isso entre sessões. Por isso a reversão por falha de
 *    transporte exige `userInitiated`.
 */

export type StatusWriteOutcome = {
  /** O valor que pedimos ao servidor. */
  requested: boolean;
  /**
   * O que o banco diz estar gravado, lido de volta na mesma chamada.
   * `null` quando não deu para ler (a escrita pode ter ido, não sabemos).
   */
  returned: boolean | null;
  /** Houve erro de transporte/permissão — a escrita não chegou. */
  failed: boolean;
  /** A escrita veio de um toque na chave, não do heartbeat de abertura. */
  userInitiated: boolean;
};

export type StatusRevertDecision = {
  /** Para qual valor corrigir a EXIBIÇÃO. `null` = não mexer. */
  revertTo: boolean | null;
  /** Mostrar o aviso de que o status não está em sincronia com o servidor. */
  syncFailed: boolean;
  reason: 'ok' | 'refused' | 'transport' | 'unknown';
};

export function decideStatusRevert(outcome: StatusWriteOutcome): StatusRevertDecision {
  const { requested, returned, failed, userInitiated } = outcome;

  if (failed) {
    return {
      // Só corrige a chave quando o usuário acabou de mexer nela: aí a reversão
      // conta a verdade ("seu toque não valeu"). No heartbeat de abertura não
      // houve toque, e inverter seria inventar uma ação do usuário.
      revertTo: userInitiated ? !requested : null,
      // O aviso vale nos dois casos: estando ONLINE sem sincronizar, o motorista
      // acha que está recebendo corridas e não está.
      syncFailed: true,
      reason: 'transport',
    };
  }

  // A escrita foi aceita mas o banco guardou OUTRA coisa: é a coerção do 0038.
  // O valor do servidor é a verdade, venha de toque ou de heartbeat.
  if (returned !== null && returned !== requested) {
    return { revertTo: returned, syncFailed: true, reason: 'refused' };
  }

  // Escrita ok mas sem leitura de volta: não há o que corrigir e não há o que
  // denunciar. Não inventamos falha a partir de ignorância.
  if (returned === null) {
    return { revertTo: null, syncFailed: false, reason: 'unknown' };
  }

  return { revertTo: null, syncFailed: false, reason: 'ok' };
}
