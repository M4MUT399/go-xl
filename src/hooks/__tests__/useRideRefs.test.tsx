import React from 'react';
import { create, act, type ReactTestRenderer } from 'react-test-renderer';
import { useDriverRide } from '../useRide';

/**
 * Os ESPELHOS SÍNCRONOS de `useDriverRide` — os `ref`s que os handlers de
 * broadcast leem quando um `ride_offer_revoked` chega.
 *
 * O defeito que este arquivo persegue não é a REGRA (que mora em
 * `lib/rideRevocation.ts`, é pura e já tem suíte própria). É de onde vêm as
 * ENTRADAS dela. Enquanto a sincronia dos espelhos morava num `useEffect`, um
 * broadcast que chegasse entre o commit e o flush do efeito passivo decidia
 * sobre uma fila ANTERIOR — e a decisão certa sobre um estado que não existe
 * mais é uma decisão errada. Aqui a fila é montada de verdade, o broadcast é
 * disparado de verdade, e o que se observa são os efeitos (`stopAll`,
 * `logRideOfferEvent`, a cabeça da fila).
 *
 * `react-test-renderer` é dependência TRANSITIVA de `jest-expo` — ver o mesmo
 * aviso em `src/contexts/__tests__/driverOnlineSync.test.tsx`.
 */

const mockCanais: Record<string, Record<string, (msg: { payload: unknown }) => void>> = {};

jest.mock('../../lib/supabase', () => {
  const canal = (nome: string) => {
    const self: Record<string, unknown> = {};
    self.on = (tipo: string, filtro: Record<string, string>, cb: (m: { payload: unknown }) => void) => {
      if (tipo === 'broadcast') {
        mockCanais[nome] = mockCanais[nome] ?? {};
        mockCanais[nome][filtro.event] = cb;
      }
      return self;
    };
    self.subscribe = () => self;
    self.send = () => Promise.resolve();
    return self;
  };
  // Cadeia de query que GRAVA por onde passou e devolve o que `mockResposta`
  // decidir. O padrão é "nada encontrado, sem erro" — igual ao mock cego que
  // estava aqui antes. O que mudou é que agora um teste consegue responder
  // UMA consulta específica, que é o único jeito de fazer `activeRide` existir
  // sem rodar `acceptRide` inteiro (cobrança no cartão incluída).
  const construir = (tabela: string): unknown => {
    const chamadas: Array<[string, ...unknown[]]> = [];
    const self: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (typeof prop !== 'string') return undefined;
          if (prop === 'then') {
            return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
              Promise.resolve(mockResposta(tabela, chamadas)).then(res, rej);
          }
          return (...args: unknown[]) => {
            chamadas.push([prop, ...args]);
            return self;
          };
        },
      },
    );
    return self;
  };
  return {
    supabase: {
      channel: canal,
      removeChannel: () => undefined,
      from: (tabela: string) => construir(tabela),
      rpc: (nome: string) => construir(nome),
      auth: { getSession: () => Promise.resolve({ data: { session: null } }) },
    },
  };
});

type Chamada = [string, ...unknown[]];
const SEM_RESPOSTA = () => ({ data: null, error: null });
let mockResposta: (tabela: string, chamadas: Chamada[]) => { data: unknown; error: unknown } =
  SEM_RESPOSTA;

const mockStopAll = jest.fn();
jest.mock('../../lib/offerAlertManager', () => ({
  offerAlertManager: {
    stopAll: (...a: unknown[]) => mockStopAll(...a),
    registerForceClose: () => () => undefined,
    start: () => undefined,
    stop: () => undefined,
  },
}));

const mockLogOffer = jest.fn();
jest.mock('../../lib/rideOfferEvents', () => ({
  logRideOfferEvent: (...a: unknown[]) => mockLogOffer(...a),
}));
jest.mock('../../lib/notifications', () => ({
  dismissRideNotifications: () => undefined,
  scheduleRideOfferNotification: () => undefined,
}));
// A flag de múltiplas ofertas simultâneas. Configurável porque as DUAS posições
// são produção: com ela ligada quem manda é a presença na fila; desligada, quem
// manda é a CABEÇA (`pendingRideId`) — e é só nessa configuração que o espelho
// da cabeça tem efeito observável.
let mockMultiOffer = true;
jest.mock('../useFeatureFlag', () => ({ useFeatureFlag: () => mockMultiOffer }));
jest.mock('../../lib/systemConfig', () => ({
  getConfig: () => Promise.resolve(null),
  isConfigFlagEnabled: () => Promise.resolve(false),
}));
jest.mock('../../lib/errorReporting', () => ({ reportError: () => undefined }));
jest.mock('../../lib/routing', () => ({ getRoute: () => Promise.resolve(null) }));

const MOTORISTA = 'motorista-1';

type Hook = ReturnType<typeof useDriverRide>;
let hook: Hook;
let arvore: ReactTestRenderer | null = null;

function Espiao() {
  hook = useDriverRide(MOTORISTA, 'FL');
  return null;
}

function oferta(id: string) {
  return {
    id,
    status: 'requesting',
    pickup: { lat: 28.4, lng: -81.3, address: 'A' },
    dropoff: { lat: 28.5, lng: -81.4, address: 'B' },
    price: 30,
    distance_km: 10,
  } as unknown as Parameters<Hook['setPendingRide']>[0];
}

/** Dispara o broadcast do canal compartilhado 'ride-offers'. */
async function broadcast(evento: 'ride_offer_revoked' | 'ride_taken', payload: unknown) {
  await act(async () => {
    mockCanais['ride-offers'][evento]({ payload });
  });
}

async function montar() {
  await act(async () => {
    arvore = create(<Espiao />);
  });
}

beforeEach(() => {
  for (const k of Object.keys(mockCanais)) delete mockCanais[k];
  mockStopAll.mockClear();
  mockLogOffer.mockClear();
  mockResposta = SEM_RESPOSTA;
  mockMultiOffer = true;
});

// O hook mantém um `setInterval` de backstop enquanto há oferta pendente. Sem
// desmontar, ele sobrevive ao fim da suíte e o Jest derruba o ambiente por
// baixo dele — o erro que aparece é um `Platform.OS` de `undefined`, que não
// tem nada a ver com o que se está testando.
afterEach(async () => {
  if (arvore) {
    const a = arvore;
    await act(async () => {
      a.unmount();
    });
    arvore = null;
  }
});

describe('useDriverRide — espelhos síncronos vistos pela revogação', () => {
  it('revogar uma oferta da CAUDA não derruba a que está tocando', async () => {
    await montar();
    await act(async () => {
      hook.setPendingRide(oferta('A'));
      hook.setPendingRide(oferta('B'));
    });
    expect(hook.pendingRide?.id).toBe('A');

    await broadcast('ride_offer_revoked', { rideId: 'B', by: 'outro', reason: 'taken' });

    // Silenciou a B — e SÓ a B. Com o espelho da fila vindo de um `useEffect`,
    // `queueHasOffer` respondia sobre a fila anterior (sem a B) e a cauda ficava
    // pendurada até o watchdog.
    expect(mockStopAll).toHaveBeenCalledWith('B', 'taken');
    expect(hook.pendingRide?.id).toBe('A');
  });

  it('revogar a CABEÇA promove a próxima da fila', async () => {
    await montar();
    await act(async () => {
      hook.setPendingRide(oferta('A'));
      hook.setPendingRide(oferta('B'));
    });

    await broadcast('ride_offer_revoked', { rideId: 'A', by: 'outro', reason: 'taken' });

    expect(mockStopAll).toHaveBeenCalledWith('A', 'taken');
    expect(hook.pendingRide?.id).toBe('B');
  });

  it('os DOIS eventos do aceite auditam uma vez só', async () => {
    await montar();
    await act(async () => {
      hook.setPendingRide(oferta('A'));
    });

    // `broadcastRideRevoked` emite os dois no aceite: o novo com motivo e o
    // legado. A chave de dedupe é `${rideId}:${reason}` — mesmo motivo, um log.
    await broadcast('ride_offer_revoked', { rideId: 'A', by: 'outro', reason: 'taken' });
    await broadcast('ride_taken', { rideId: 'A', by: 'outro' });

    const auditorias = mockLogOffer.mock.calls.filter((c) => c[2] === 'taken_by_other');
    expect(auditorias).toHaveLength(1);
  });

  it('revogação de corrida que não está na fila é no-op', async () => {
    await montar();
    await act(async () => {
      hook.setPendingRide(oferta('A'));
    });

    await broadcast('ride_offer_revoked', { rideId: 'Z', by: 'outro', reason: 'taken' });

    expect(mockStopAll).not.toHaveBeenCalled();
    expect(hook.pendingRide?.id).toBe('A');
  });
});

/**
 * O VALOR dos espelhos, não só onde eles são atribuídos.
 *
 * O bloco estrutural mais abaixo trava a FORMA (`ref.current = x` no corpo do
 * hook). Ele não olha o lado direito — e trocar as três atribuições por
 * `= null` deixava as 920 asserções da suíte inteira VERDES, com o motorista
 * recebendo oferta nova de passageiro embarcado e seguindo navegando para uma
 * corrida cancelada. Os quatro testes de comportamento acima não pegavam porque
 * são todos dominados por `offerQueueRef`.
 *
 * Cada teste aqui existe para matar um mutante `= null` específico.
 */
describe('useDriverRide — os espelhos carregam o VALOR certo', () => {
  it('cancelamento do passageiro encerra a corrida ATIVA (activeRideRef)', async () => {
    // `activeRide` chega pelo caminho de produção da RETOMADA: o app reabre
    // depois de um kill e busca a corrida accepted/em curso do motorista. É a
    // única porta que não passa por `acceptRide` (e portanto pela cobrança).
    const ATIVA = { id: 'ATIVA-1', status: 'accepted', driver_id: MOTORISTA, passenger_id: 'p1' };
    mockResposta = (tabela, chamadas) => {
      const pedeAtivas = chamadas.some(
        ([m, campo, valor]) =>
          m === 'in' && campo === 'status' && Array.isArray(valor) && valor.includes('accepted'),
      );
      return tabela === 'rides' && pedeAtivas ? { data: ATIVA, error: null } : { data: null, error: null };
    };

    await montar();
    expect(hook.activeRide?.id).toBe('ATIVA-1');

    await broadcast('ride_offer_revoked', { rideId: 'ATIVA-1', by: 'passageiro', reason: 'cancelled' });

    // Com `activeRideRef.current` valendo null, `resolveRevocation` devolve
    // `endActiveRide: false` e o motorista continua navegando para uma corrida
    // que o passageiro já cancelou.
    expect(hook.activeRide).toBeNull();
  });

  it('agendamento revogado some do popup (pendingScheduledRideIdRef)', async () => {
    await montar();
    const daquiAUmaHora = new Date(Date.now() + 3600_000).toISOString();
    await act(async () => {
      hook.setPendingScheduledRide({
        id: 'AGENDADA-1',
        status: 'scheduled',
        scheduled_for: daquiAUmaHora,
      } as unknown as Parameters<Hook['setPendingScheduledRide']>[0]);
    });
    expect(hook.pendingScheduledRide?.id).toBe('AGENDADA-1');

    await broadcast('ride_offer_revoked', { rideId: 'AGENDADA-1', by: 'outro', reason: 'taken' });

    expect(hook.pendingScheduledRide).toBeNull();
  });

  it('com multiOffer DESLIGADA, quem silencia a oferta é a cabeça (pendingRideIdRef)', async () => {
    // Com a flag ligada, `decideOfferSilence` decide por presença na fila e o
    // espelho da CABEÇA não tem efeito observável nenhum — foi assim que o
    // mutante `pendingRideIdRef.current = null` sobreviveu à suíte toda.
    mockMultiOffer = false;
    await montar();
    await act(async () => {
      hook.setPendingRide(oferta('A'));
    });

    await broadcast('ride_offer_revoked', { rideId: 'A', by: 'outro', reason: 'taken' });

    expect(mockStopAll).toHaveBeenCalledWith('A', 'taken');
  });
});

describe('useDriverRide — onde os espelhos são atribuídos', () => {
  /**
   * Este bloco é ESTRUTURAL de propósito, e vale registrar por que não dá para
   * ser comportamental.
   *
   * A terceira entrada de `resolveRevocation` é `activeRideRef`, e o defeito
   * real dela vive na janela ENTRE O COMMIT E O FLUSH DO EFEITO PASSIVO: no
   * aceite, `setActiveRide(ride)` e a saída da oferta da fila caem no mesmo
   * lote; se `activeRideRef` fosse sincronizado por `useEffect`, um broadcast
   * `'cancelled'` nessa fresta leria `pendingRideId = null` (já commitado) e
   * `activeRideId = null` (efeito ainda não rodou) — dois commits diferentes na
   * mesma decisão — e devolveria `endActiveRide: false`, deixando o motorista
   * navegando para uma corrida cancelada.
   *
   * `act()` não abre essa fresta: ele faz o commit E o flush dos efeitos antes
   * de devolver o controle, então nenhum teste de render consegue observar o
   * intervalo. E `useDriverRide` não expõe `setActiveRide`, de modo que chegar
   * a `activeRide` exigiria rodar `acceptRide` inteiro (cobrança no cartão
   * incluída). Um teste que simulasse tudo isso estaria testando a simulação.
   *
   * O que sobra de honesto é travar a PROPRIEDADE que fecha a janela: os três
   * espelhos são atribuídos no corpo do componente, não dentro de efeito
   * nenhum. Não é prova de comportamento — é uma trava contra a regressão que
   * já aconteceu uma vez, quando um deles foi "consertado" e os outros dois
   * ficaram no efeito, tornando a decisão mista PIOR do que era antes.
   */
  const fonte: string = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'useRide.ts'),
    'utf8',
  );

  /**
   * Apaga comentários e literais de string, preservando o COMPRIMENTO (troca por
   * espaço) para que os índices continuem valendo. Existe só para a contagem de
   * chaves abaixo não se perder com uma `{` dentro de um comentário ou de uma
   * mensagem de log.
   */
  function neutralizar(src: string): string {
    const out = src.split('');
    let i = 0;
    const apagarAte = (fim: number) => {
      for (let k = i; k < fim && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
      i = fim;
    };
    while (i < src.length) {
      const c = src[i];
      if (c === '/' && src[i + 1] === '/') {
        const fim = src.indexOf('\n', i);
        apagarAte(fim === -1 ? src.length : fim);
      } else if (c === '/' && src[i + 1] === '*') {
        const fim = src.indexOf('*/', i);
        apagarAte(fim === -1 ? src.length : fim + 2);
      } else if (c === "'" || c === '"' || c === '`') {
        let j = i + 1;
        while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
        apagarAte(Math.min(j + 1, src.length));
      } else {
        i += 1;
      }
    }
    return out.join('');
  }

  /**
   * Devolve as violações do espelho `ref` em `src`. Duas regras:
   *
   *   (a) PROFUNDIDADE DE CHAVES: a atribuição está a exatamente uma chave de
   *       distância do topo do arquivo — ou seja, direto no corpo do hook, e não
   *       dentro de bloco, callback, `if`, `try` ou o que for. É a regra que
   *       importa, e ela não conhece nomes: a primeira versão tinha uma
   *       LISTA-BRANCA de "adiadores" (`useEffect`, `useCallback`, ...) e um
   *       simples `setTimeout(() => { ... }, 0)` passava por ela intacto,
   *       reabrindo a janela inteira com a suíte verde.
   *   (b) INDENTAÇÃO de dois espaços. Redundante com (a) na prática, mantida
   *       porque falha com mensagem mais legível e não custa nada.
   *
   * Este bloco é uma trava SECUNDÁRIA. A cobertura de verdade são os testes de
   * VALOR acima — enquanto só existia trava estrutural, trocar as atribuições
   * por `= null` mantinha a suíte inteira verde.
   *
   * `=(?!=)`: sem isso, `pendingRideIdRef.current === pendingId` (uma LEITURA,
   * dentro do poll de backstop) contava como atribuição e o teste falhava
   * apontando para o lugar errado.
   */
  function violacoes(ref: string, src: string): string[] {
    const limpo = neutralizar(src);
    const atribuicao = new RegExp(`${ref}\\.current\\s*=(?!=)`, 'g');
    const total = (limpo.match(atribuicao) ?? []).length;
    if (total === 0) return [`nenhuma atribuição a ${ref}.current`];

    const problemas: string[] = [];

    let profundidade = 0;
    let cursor = 0;
    let noCorpoDoHook = 0;
    atribuicao.lastIndex = 0;
    for (let m = atribuicao.exec(limpo); m; m = atribuicao.exec(limpo)) {
      for (; cursor < m.index; cursor++) {
        if (limpo[cursor] === '{') profundidade++;
        else if (limpo[cursor] === '}') profundidade--;
      }
      if (profundidade === 1) noCorpoDoHook++;
    }
    if (noCorpoDoHook !== total) {
      problemas.push(`${total - noCorpoDoHook} atribuição(ões) aninhada(s) fora do corpo do hook`);
    }

    const indentada = (limpo.match(new RegExp(`^ {2}${ref}\\.current\\s*=(?!=)`, 'gm')) ?? []).length;
    if (indentada !== total) problemas.push(`${total - indentada} atribuição(ões) fora da indentação do corpo`);

    return problemas;
  }

  const ESPELHOS = ['pendingRideIdRef', 'pendingScheduledRideIdRef', 'activeRideRef', 'offerQueueRef'];

  it.each(ESPELHOS)('%s é atribuído em render, no corpo do hook', (ref) => {
    // (`handledRevocations`, que é um Set mutado dentro de handler, não entra
    // nesta lista — ele não alimenta `resolveRevocation`.)
    expect(violacoes(ref, fonte)).toEqual([]);
  });

  it('o neutralizador apaga comentário e string sem mexer nos índices', () => {
    // A contagem de chaves depende disto: uma `{` dentro de um comentário ou de
    // uma mensagem de log desalinharia a profundidade do arquivo inteiro.
    const limpo = neutralizar(fonte);
    expect(limpo).toHaveLength(fonte.length);
    expect(fonte).toMatch(/\/\//);
    expect(limpo).not.toMatch(/\/\//);
    // E as chaves de código fecham: se sobrasse uma aberta, a regra (a) reprovaria
    // o arquivo bom.
    const abre = (limpo.match(/\{/g) ?? []).length;
    const fecha = (limpo.match(/\}/g) ?? []).length;
    expect(abre).toBe(fecha);
  });

  /**
   * As regressões que os casos acima têm de reprovar, cada uma injetada no texto
   * REAL de `useRide.ts`. Injetar no arquivo de verdade, e não num trecho
   * sintético de cinco linhas, é o ponto: o trecho sintético provava que a regex
   * funciona sobre o trecho sintético. Aqui o extrator enfrenta as 1.400 linhas
   * que ele enfrenta em produção, com a regressão dentro.
   *
   * Mutar `useRide.ts` no disco para demonstrar isso seria um experimento que
   * ninguém mais consegue repetir; concatenar em memória fica no arquivo e roda
   * a cada `npx jest`.
   */
  const REGRESSOES: Array<[string, string]> = [
    ['useEffect', '  useEffect(() => {\n    activeRideRef.current = activeRide;\n  }, [activeRide]);'],
    ['useLayoutEffect', '  useLayoutEffect(() => {\n    activeRideRef.current = activeRide;\n  }, [activeRide]);'],
    ['useCallback', '  const sincronizar = useCallback(() => {\n    activeRideRef.current = activeRide;\n  }, [activeRide]);'],
    ['bloco condicional', '  if (activeRide) {\n    activeRideRef.current = activeRide;\n  }'],
    // A combinação que derrubava a lista-branca: um adiador que ninguém listou,
    // com o corpo escrito na indentação do corpo do hook. Nenhuma das duas
    // regras antigas pegava; a de profundidade de chaves pega.
    ['setTimeout com o corpo desindentado', '  setTimeout(() => {\n  activeRideRef.current = activeRide;\n  }, 0);'],
    ['useEffect com o corpo desindentado', '  useEffect(() => {\n  activeRideRef.current = activeRide;\n  }, [activeRide]);'],
  ];

  /**
   * A regressão entra DENTRO do corpo do hook, logo abaixo da linha real. Colar
   * no fim do arquivo não serviria: lá o trecho fica no topo do módulo, com
   * profundidade de chaves diferente da do corpo do hook, e o teste passaria
   * pelo motivo errado — reprovando por estar fora do hook, não por estar
   * aninhado.
   */
  const ANCORA = '  activeRideRef.current = activeRide;';

  function comRegressao(trecho: string): string {
    expect(fonte.split(ANCORA)).toHaveLength(2); // âncora única, senão a injeção mente
    return fonte.replace(ANCORA, `${ANCORA}\n${trecho}`);
  }

  it.each(REGRESSOES)('a asserção REPROVA a regressão: %s', (_nome, trecho) => {
    expect(violacoes('activeRideRef', comRegressao(trecho))).not.toEqual([]);
  });

  it('e ACEITA a mesma linha escrita no corpo do hook', () => {
    // O contrapeso dos casos acima: eles falhariam também se `violacoes`
    // reprovasse qualquer texto injetado, por qualquer motivo.
    expect(violacoes('activeRideRef', comRegressao(ANCORA))).toEqual([]);
  });
});
