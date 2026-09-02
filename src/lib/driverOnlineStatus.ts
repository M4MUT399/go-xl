/**
 * Decide o que a tela deve mostrar depois de tentar gravar o status
 * online/offline do motorista.
 *
 * Existe separado do contexto porque é a regra que já errou três vezes, e
 * dentro de um `useEffect` ela não é testável sem montar o app inteiro.
 *
 * ─── OS TRÊS ERROS QUE ESTA FUNÇÃO EXISTE PARA NÃO REPETIR ──────────────────
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
 *
 * 3. SUCESSO SILENCIOSO SEM POSIÇÃO. A escrita de status feita SEM coordenada é
 *    um UPDATE que não carimba `updated_at` (carimbar ressuscitaria a posição da
 *    sessão anterior — ver DriverRideContext). Ela é ACEITA, devolve `true` e
 *    não tem erro nenhum. Só que despacho e mapa do passageiro exigem
 *    `is_online = true` E `updated_at` fresco: com o carimbo velho, o motorista
 *    não entra em leque nenhum. É o defeito 1 de novo — chave verde, nenhuma
 *    corrida — só que sem sequer um erro para denunciá-lo. Por isso a decisão
 *    também depende de ter havido COORDENADA (`noPosition`), não só de o banco
 *    ter aceitado.
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
  /**
   * O UPDATE não casou LINHA NENHUMA (zero linhas, sem erro).
   *
   * Não confundir com `returned === null` por ignorância: aqui o servidor
   * RESPONDEU, e a resposta é "não existe linha para este motorista". Sem
   * `lat`/`lng` (NOT NULL, sem default) não há como criá-la, então o status
   * pedido simplesmente não foi gravado em lugar nenhum.
   */
  noRow?: boolean;
  /**
   * A escrita saiu SEM coordenada nenhuma (UPDATE só de status).
   *
   * Não confundir com `noRow`: aqui a linha existe e o `is_online` pedido foi
   * gravado. O que NÃO foi atualizado é `updated_at`, e é ele que decide se o
   * motorista aparece para o despacho. Ver o erro 3 no cabeçalho.
   */
  noPosition?: boolean;
};

export type StatusRevertDecision = {
  /** Para qual valor corrigir a EXIBIÇÃO. `null` = não mexer. */
  revertTo: boolean | null;
  /** Mostrar o aviso de que o status não está em sincronia com o servidor. */
  syncFailed: boolean;
  reason: 'ok' | 'refused' | 'transport' | 'unknown' | 'no_position';
};

export function decideStatusRevert(outcome: StatusWriteOutcome): StatusRevertDecision {
  const { requested, returned, failed, userInitiated, noRow, noPosition } = outcome;

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
  //
  // Vem ANTES dos dois casos de "sem posição" porque é mais específico: um
  // `false` devolvido NOMEIA a causa (cadastro de repasse incompleto), e falar
  // de GPS por cima disso repete o erro que este módulo persegue — mandar o
  // motorista checar a coisa errada.
  if (returned !== null && returned !== requested) {
    return { revertTo: returned, syncFailed: true, reason: 'refused' };
  }

  // ─── SEM COORDENADA: `noRow` e `noPosition` desembocam no MESMO desfecho ────
  //
  // São duas fotos do mesmo problema. Em `noPosition` a linha existe e o
  // `is_online` pedido foi gravado, mas `updated_at` ficou no carimbo velho de
  // propósito (carimbá-lo ressuscitaria a coordenada de ontem — ver
  // DriverRideContext). Em `noRow` nem linha existe, porque ela só nasce de um
  // insert com `lat`/`lng`, que são NOT NULL sem default. Nos dois casos o
  // desfecho no SERVIDOR é idêntico: este motorista não entra em leque nenhum,
  // porque tanto o despacho (`.eq('is_online', true).gt('updated_at', agora -
  // 10min)`, dispatch-engine/index.ts:152-156) quanto o mapa do passageiro
  // (0069:646) exigem posição FRESCA, e não há posição nenhuma.
  //
  // ─── POR QUE A CHAVE NÃO CAI, NEM MESMO NO `noRow` ─────────────────────────
  //
  // Esta foi a decisão que a rodada anterior errou. Ela revertia `noRow` para
  // OFFLINE com o argumento de que "o servidor provou que ele não está online".
  // O argumento está certo sobre o passado e errado sobre o futuro: a ÚNICA
  // coisa no app inteiro capaz de criar essa linha é o efeito de posição, e ele
  // começa com `if (!isOnline) return`. Derrubar a chave desliga a cura junto
  // com o sintoma — o primeiro fix de GPS chega dois segundos depois e não
  // publica nada, porque o app já se convenceu de que o turno não começou.
  //
  // Era exatamente esse o defeito relatado, por outro caminho: o motorista toca
  // em Online antes do primeiro fix, a chave volta sozinha para Offline e ele
  // não consegue mais entrar em serviço.
  //
  // Mantida a chave, o desfecho se resolve sozinho no caso comum: o fix chega,
  // o efeito de posição faz o UPSERT com coordenada, a linha nasce (ou o
  // `updated_at` é carimbado) e o motorista entra no leque. O que sobra para
  // esta decisão é o AVISO — e ele é sobre GPS, não sobre conexão.
  //
  // Quem decide QUANDO avisar não é esta função: é o vigia no
  // DriverRideContext, que dá uma carência antes de acusar. Aqui só se diz que,
  // se este for o desfecho final, ele é uma falha de sincronia — e de qual tipo.
  if (noRow && !requested) {
    // Pedir OFFLINE sem linha é pedir o que já vale: não há o que desligar nem
    // o que denunciar.
    return { revertTo: null, syncFailed: false, reason: 'ok' };
  }
  if ((noRow || noPosition) && requested) {
    return { revertTo: null, syncFailed: true, reason: 'no_position' };
  }

  // Escrita ok mas sem leitura de volta: não há o que corrigir e não há o que
  // denunciar. Não inventamos falha a partir de ignorância.
  if (returned === null) {
    return { revertTo: null, syncFailed: false, reason: 'unknown' };
  }

  return { revertTo: null, syncFailed: false, reason: 'ok' };
}

/**
 * Texto do banner de status, montado a partir de chaves de i18n que JÁ EXISTEM.
 *
 * Existe como função (e não inline no JSX) por um motivo só: o texto errado é o
 * defeito. Reusar `driverNav.statusUpdateFailed` fazia a tela dizer "não foi
 * possível atualizar o status DA CORRIDA" quando o que falhou foi gravar o
 * ONLINE/OFFLINE do motorista — sem corrida nenhuma em andamento. O dono leu o
 * banner na tela inicial e foi procurar a corrida que não existia.
 *
 * Por que a composição e não uma chave nova: `src/i18n/translations.ts` está
 * travado. `edit.errSaveNetwork` ("Não foi possível salvar. Verifique sua
 * conexão e tente novamente.") é verdadeira e NEUTRA — não fala de corrida — e
 * existe em en/es/pt; prefixá-la com `driver.online`/`driver.offline` nomeia o
 * que não foi salvo. O resultado sai traduzido nos três idiomas, que é o que
 * uma string literal de fallback não daria.
 */
export function statusBannerText(
  reason: StatusRevertDecision['reason'],
  t: (key: string) => string,
): string {
  // 'refused' = o trigger da 0038 coagiu `is_online := false`. A causa quase
  // sempre é o cadastro de repasse — este texto já é o certo e continua.
  if (reason === 'refused') return t('driver.payoutSetupRequiredBody');
  // 'no_position' = está em serviço e não há posição fresca no servidor. Mandar
  // checar a CONEXÃO aqui seria repetir o defeito de origem por outro caminho: o
  // problema é o GPS, e `home.noLocationBody` já diz isso nos três idiomas
  // ("Verifique se o GPS está ligado").
  //
  // Prefixo com UMA palavra, não com as duas. Este motivo só existe para pedido
  // de ONLINE — ver `(noRow || noPosition) && requested` acima —, então a direção
  // é conhecida e "Online/Offline:" lia como rótulo de menu em vez de nomear o
  // estado em que o motorista está. Nos outros motivos a direção pode ser
  // qualquer uma (o toque para SAIR também falha na rede), e ali o par continua.
  if (reason === 'no_position') {
    return `${t('driver.online')}: ${t('home.noLocationBody')}`;
  }
  return `${t('driver.online')}/${t('driver.offline')}: ${t('edit.errSaveNetwork')}`;
}
