import { decideStatusRevert, statusBannerText, type StatusWriteOutcome } from '../driverOnlineStatus';
import { translations, type Lang } from '../../i18n/translations';

const base: StatusWriteOutcome = {
  requested: true,
  returned: true,
  failed: false,
  userInitiated: true,
};

describe('decideStatusRevert', () => {
  it('escrita aceita e confirmada: não mexe em nada', () => {
    expect(decideStatusRevert(base)).toEqual({
      revertTo: null,
      syncFailed: false,
      reason: 'ok',
    });
  });

  // ── Defeito 1: a recusa silenciosa do trigger da 0038 ────────────────────
  // O trigger faz `new.is_online := false` e o upsert retorna SUCESSO. Quem
  // olhar só `error` conclui que deu certo. Este é o caso real do motorista
  // sem Stripe Connect aprovado que ficava "Online" sem receber corrida.
  it('servidor devolve false para um pedido de true: reverte e denuncia', () => {
    const d = decideStatusRevert({ ...base, requested: true, returned: false });
    expect(d.revertTo).toBe(false);
    expect(d.syncFailed).toBe(true);
    expect(d.reason).toBe('refused');
  });

  it('a recusa é detectada mesmo SEM erro — é o ponto todo', () => {
    const d = decideStatusRevert({ ...base, requested: true, returned: false, failed: false });
    expect(d.reason).toBe('refused');
  });

  it('a recusa vale também no heartbeat, não só no toque', () => {
    // O valor do servidor é a verdade venha de onde vier: se o banco diz
    // offline, mostrar "Online" é mentira independentemente de quem escreveu.
    const d = decideStatusRevert({
      ...base,
      requested: true,
      returned: false,
      userInitiated: false,
    });
    expect(d.revertTo).toBe(false);
    expect(d.reason).toBe('refused');
  });

  // ── Defeito 2: reversão no heartbeat de abertura ─────────────────────────
  it('falha de rede NO TOQUE: reverte a chave, porque o toque não valeu', () => {
    const d = decideStatusRevert({ ...base, requested: true, returned: null, failed: true });
    expect(d.revertTo).toBe(false);
    expect(d.syncFailed).toBe(true);
    expect(d.reason).toBe('transport');
  });

  it('falha de rede NO HEARTBEAT: NÃO inverte a chave', () => {
    // O bug concreto: motorista OFFLINE abre o app sem rede. O heartbeat grava
    // `false`, falha, e a versão anterior fazia `setIsOnline(!false)` = true,
    // persistindo "Online" entre sessões sem ninguém ter tocado na chave.
    const d = decideStatusRevert({
      requested: false,
      returned: null,
      failed: true,
      userInitiated: false,
    });
    expect(d.revertTo).toBeNull();
    expect(d.syncFailed).toBe(true);
  });

  it('falha no heartbeat estando ONLINE: avisa, mas não desliga sozinho', () => {
    const d = decideStatusRevert({
      requested: true,
      returned: null,
      failed: true,
      userInitiated: false,
    });
    expect(d.revertTo).toBeNull();
    // O aviso importa: o motorista acha que está recebendo corridas e o
    // servidor pode não saber que ele está online.
    expect(d.syncFailed).toBe(true);
  });

  it('escrita ok mas sem leitura de volta: não inventa falha', () => {
    const d = decideStatusRevert({ ...base, returned: null, failed: false });
    expect(d).toEqual({ revertTo: null, syncFailed: false, reason: 'unknown' });
  });

  it('nunca reverte para o mesmo valor que foi pedido', () => {
    // Invariante: uma reversão que devolve o valor pedido não corrige nada e
    // ainda re-dispara o efeito de escrita — era assim que nascia o loop.
    for (const requested of [false, true]) {
      for (const returned of [false, true, null]) {
        for (const failed of [false, true]) {
          for (const userInitiated of [false, true]) {
            const d = decideStatusRevert({ requested, returned, failed, userInitiated });
            if (d.revertTo !== null) expect(d.revertTo).not.toBe(requested);
          }
        }
      }
    }
  });

  it('syncFailed implica que algo de fato deu errado', () => {
    for (const requested of [false, true]) {
      for (const returned of [false, true, null]) {
        for (const userInitiated of [false, true]) {
          const d = decideStatusRevert({ requested, returned, failed: false, userInitiated });
          // Sem erro de transporte, só a divergência de valor justifica o aviso.
          if (d.syncFailed) expect(returned).toBe(!requested);
        }
      }
    }
  });
});

describe('decideStatusRevert — UPDATE que não casa linha nenhuma', () => {
  // O caso: motorista sem linha em `driver_locations` (conta nova que nunca
  // ficou online com GPS, ou linha apagada pelo delete-account). O UPDATE volta
  // `{ data: null, error: null }` — zero linhas. A regra antiga lia isso como
  // "não deu para ler de volta" e ficava CALADA: chave verde, servidor sem nada,
  // nenhuma corrida e nenhum aviso. É o cenário do cabeçalho do módulo.
  const semLinha: StatusWriteOutcome = {
    requested: true,
    returned: null,
    failed: false,
    userInitiated: true,
    noRow: true,
  };

  it('pedido de ONLINE sem linha denuncia, mas NÃO derruba a chave', () => {
    const d = decideStatusRevert(semLinha);
    expect(d.syncFailed).toBe(true);
    expect(d.reason).toBe('no_position');
    // A regra que esta linha substituiu revertia para `false`, com o argumento
    // de que "o servidor provou que ele não está online". O argumento acerta o
    // passado e erra o futuro: a única coisa capaz de CRIAR essa linha é o
    // efeito de posição do DriverRideContext, e ele só publica com a chave
    // ligada. Reverter aqui desliga a cura junto com o sintoma — o fix de GPS
    // chega dois segundos depois e não publica nada. Era esse o defeito
    // relatado: o motorista não conseguia mais entrar em serviço.
    expect(d.revertTo).toBeNull();
  });

  it('o heartbeat de abertura tem o mesmo desfecho do toque', () => {
    // Aqui não há assimetria a preservar: como a chave não cai em nenhum dos
    // dois, `userInitiated` não muda nada. O que muda é só QUEM decide a hora de
    // avisar — e isso é do vigia, não desta função.
    const d = decideStatusRevert({ ...semLinha, userInitiated: false });
    expect(d.revertTo).toBeNull();
    expect(d.reason).toBe('no_position');
  });

  it('pedido de OFFLINE sem linha não é falha: não há o que desligar', () => {
    const d = decideStatusRevert({ ...semLinha, requested: false });
    expect(d).toEqual({ revertTo: null, syncFailed: false, reason: 'ok' });
  });

  it('sem a marca, o MESMO retorno continua sendo ignorância silenciosa', () => {
    // Guarda da distinção: `data: null` de um UPSERT (ou de uma leitura que não
    // voltou) segue sem denunciar nada — o que mudou foi saber diferenciar.
    const d = decideStatusRevert({ ...semLinha, noRow: false });
    expect(d).toEqual({ revertTo: null, syncFailed: false, reason: 'unknown' });
  });

  it('erro de transporte ganha do zero-linhas: sem resposta não há prova', () => {
    const d = decideStatusRevert({ ...semLinha, failed: true });
    expect(d.reason).toBe('transport');
  });
});

describe('decideStatusRevert — aceito, porém SEM coordenada', () => {
  // O caso do motorista que JÁ TEM linha em `driver_locations` (todo mundo que
  // um dia ficou online com GPS) e agora está sem fix — GPS desligado pelo
  // Android, permissão negada. O UPDATE casa a linha, grava `is_online: true` e
  // devolve `true`: nenhum erro, nenhuma divergência de valor. Só que ele não
  // carimba `updated_at`, e é o carimbo que põe o motorista no leque do despacho
  // (dispatch-engine/index.ts:152-156) e no mapa do passageiro (0069:646).
  const semCoordenada: StatusWriteOutcome = {
    requested: true,
    returned: true,
    failed: false,
    userInitiated: true,
    noPosition: true,
  };

  it('pedido de ONLINE aceito sem coordenada É falha, e a razão é o GPS', () => {
    const d = decideStatusRevert(semCoordenada);
    expect(d.syncFailed).toBe(true);
    expect(d.reason).toBe('no_position');
  });

  it('não derruba a chave: o status pedido está gravado e a cura é o próximo fix', () => {
    // Reverter aqui pararia o efeito de posição (ele só publica online) — e é
    // ele quem carimba o `updated_at` que falta. A reversão mataria a cura.
    expect(decideStatusRevert(semCoordenada).revertTo).toBeNull();
  });

  it('pedido de OFFLINE sem coordenada não acusa nada', () => {
    // Ficar fora do leque é exatamente o que se pediu.
    const d = decideStatusRevert({ ...semCoordenada, requested: false, returned: false });
    expect(d).toEqual({ revertTo: null, syncFailed: false, reason: 'ok' });
  });

  it('a RECUSA do trigger ganha da falta de coordenada', () => {
    // Se o servidor coagiu `is_online := false`, o que o motorista precisa ler é
    // sobre o cadastro de repasse — mandá-lo checar o GPS seria o defeito de
    // origem outra vez, só que invertido.
    const d = decideStatusRevert({ ...semCoordenada, returned: false });
    expect(d.reason).toBe('refused');
    expect(d.revertTo).toBe(false);
  });

  it('o erro de transporte também ganha: a escrita nem chegou', () => {
    const d = decideStatusRevert({ ...semCoordenada, returned: null, failed: true });
    expect(d.reason).toBe('transport');
  });

  it('sem a marca, o MESMO retorno continua passando por sucesso', () => {
    // Guarda da distinção: um UPSERT com coordenada que volta `true` é sucesso
    // de verdade — ele carimbou `updated_at`.
    const d = decideStatusRevert({ ...semCoordenada, noPosition: false });
    expect(d).toEqual({ revertTo: null, syncFailed: false, reason: 'ok' });
  });
});

describe('statusBannerText — o banner precisa falar do STATUS, não da corrida', () => {
  /** `t` real, montado sobre o dicionário de verdade do app. */
  const tDe = (lang: Lang) => (key: string) => translations[lang][key] ?? key;

  it('nenhum idioma diz "corrida"/"ride"/"viaje" quando a corrida não tem nada a ver', () => {
    // O defeito relatado: o dono viu "não foi possível atualizar o status da
    // corrida" na tela inicial, OFFLINE, sem corrida em andamento. O texto vinha
    // de `driverNav.statusUpdateFailed`, que é sobre corrida.
    expect(statusBannerText('transport', tDe('pt'))).not.toMatch(/corrida/i);
    expect(statusBannerText('transport', tDe('en'))).not.toMatch(/\bride\b/i);
    expect(statusBannerText('transport', tDe('es'))).not.toMatch(/viaje/i);
  });

  it('nomeia o que não foi salvo — o online/offline do motorista', () => {
    // Literais escritos à mão, conferidos contra translations.ts. Não são
    // recompostos com as mesmas chaves que a função usa: isso seria circular.
    expect(statusBannerText('transport', tDe('pt')))
      .toBe('Online/Offline: Não foi possível salvar. Verifique sua conexão e tente novamente.');
    expect(statusBannerText('transport', tDe('en')))
      .toBe('Online/Offline: Could not save. Check your connection and try again.');
    expect(statusBannerText('transport', tDe('es')))
      .toBe('En línea/Desconectado: No se pudo guardar. Verifica tu conexión e inténtalo de nuevo.');
  });

  it("'unknown' cai no mesmo texto de transporte (também não é sobre corrida)", () => {
    expect(statusBannerText('unknown', tDe('pt'))).toBe(statusBannerText('transport', tDe('pt')));
  });

  it("'refused' continua mandando o motorista ao cadastro de repasse", () => {
    expect(statusBannerText('refused', tDe('pt')))
      .toBe('Conclua seu cadastro de repasse no Stripe antes de ficar online para poder receber.');
  });

  it("'no_position' manda checar o GPS, não a conexão", () => {
    // Literais escritos à mão, conferidos contra translations.ts. Mandar checar a
    // CONEXÃO quando o problema é o GPS é o mesmo defeito de origem por outra
    // porta: o texto tem de nomear a causa real.
    //
    // O prefixo é UMA palavra: este motivo só nasce de pedido de ONLINE, então a
    // direção é conhecida e o par "Online/Offline:" lia como rótulo de menu.
    expect(statusBannerText('no_position', tDe('pt')))
      .toBe('Online: Não foi possível obter sua localização. Verifique se o GPS está ligado.');
    expect(statusBannerText('no_position', tDe('en')))
      .toBe("Online: Couldn't get your location. Make sure GPS is on.");
    expect(statusBannerText('no_position', tDe('es')))
      .toBe('En línea: No se pudo obtener tu ubicación. Verifica que el GPS esté activado.');
    expect(statusBannerText('no_position', tDe('pt'))).not.toBe(statusBannerText('transport', tDe('pt')));
  });

  it("nos motivos que podem vir dos DOIS sentidos o prefixo continua sendo o par", () => {
    // 'transport' nasce também do toque para SAIR de serviço que se perdeu na
    // rede — nomear só "Online" ali seria dizer a direção errada.
    expect(statusBannerText('transport', tDe('pt'))).toMatch(/^Online\/Offline: /);
    expect(statusBannerText('unknown', tDe('pt'))).toMatch(/^Online\/Offline: /);
  });

  it('as chaves usadas existem NOS TRÊS idiomas (nada cai no fallback da chave crua)', () => {
    // `t` devolve o próprio nome da chave quando ela não existe no dicionário —
    // é assim que uma chave faltando vazaria para a tela do motorista.
    for (const lang of ['en', 'es', 'pt'] as Lang[]) {
      for (const reason of ['refused', 'transport', 'unknown', 'ok', 'no_position'] as const) {
        const texto = statusBannerText(reason, tDe(lang));
        expect(texto).not.toMatch(/driver\.|edit\.|driverNav\.|home\./);
      }
    }
  });
});
