import React from 'react';
import { create, act } from 'react-test-renderer';
import { DriverRideProvider, useDriverRideContext } from '../DriverRideContext';

/**
 * A sincronia do status ONLINE do motorista com `driver_locations`.
 *
 * Por que montar o Provider de verdade em vez de testar `decideStatusRevert`
 * isolado: `decideStatusRevert` já tem sua própria suíte e é PURA — ela nunca
 * errou. Os defeitos desta área foram todos de CICLO DE VIDA DE REF, que só
 * existem entre um `setState` e o commit seguinte, e que nenhum teste de função
 * pura pode enxergar:
 *
 *   • um toque na chave descartado em silêncio porque o espelho de render ainda
 *     não tinha atualizado (`intendedOnlineRef`);
 *   • a marca de reversão ficando presa e engolindo a gravação SEGUINTE
 *     (`revertingToRef`);
 *   • os DOIS efeitos que escrevem status disputando o banner, com o último a
 *     RESOLVER vencendo em vez do último a ser ENVIADO (`statusWriteSeqRef`);
 *   • uma queda de rede no meio do turno que não levantava nada, porque só o
 *     efeito de TRANSIÇÃO olhava `error` e ele não roda sem a chave mudar
 *     (`posFailStreakRef`).
 *
 * `react-test-renderer` entra aqui como dependência TRANSITIVA de `jest-expo`
 * (não está em `package.json`). Se um bump do Expo a remover, este arquivo para
 * de resolver — o conserto é adicioná-la explicitamente em devDependencies, não
 * apagar os testes.
 *
 * Toda resposta do Supabase é resolvida À MÃO (ver `mockWrites`): sem controlar
 * a ORDEM das respostas não dá para reproduzir nenhum dos defeitos acima.
 */

type Resp = { data: { is_online: boolean } | null; error: unknown };

/**
 * `op` distingue UPSERT de UPDATE. Não é detalhe de implementação: `lat`/`lng`
 * são `not null` sem default em `driver_locations` (supabase/schema.sql:135-136)
 * e o upsert do PostgREST é um insert — mandar upsert SEM coordenada é uma
 * escrita que o banco recusa (23502), e era ela que acendia o banner de falha na
 * abertura do app. O teste "todo upsert leva coordenada" mais abaixo é a rede.
 */
type Escrita = { op: 'upsert' | 'update'; payload: Record<string, unknown>; resolve: (r: Resp) => void };

const mockWrites: Escrita[] = [];
const mockStore: Record<string, string | null> = {};
const mockSetItem = jest.fn();

jest.mock('../../lib/supabase', () => ({
  supabase: {
    from: () => {
      const registrar = (op: 'upsert' | 'update', payload: Record<string, unknown>) =>
        new Promise<Resp>((resolve) => {
          mockWrites.push({ op, payload, resolve });
        });
      const devolve = (op: 'upsert' | 'update', payload: Record<string, unknown>) => ({
        select: () => ({ maybeSingle: () => registrar(op, payload) }),
      });
      return {
        upsert: (payload: Record<string, unknown>) => devolve('upsert', payload),
        update: (payload: Record<string, unknown>) => ({
          eq: () => devolve('update', payload),
        }),
      };
    },
  },
}));

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: (k: string) => Promise.resolve(mockStore[k] ?? null),
    setItem: (k: string, v: string) => {
      mockStore[k] = v;
      mockSetItem(k, v);
      return Promise.resolve();
    },
  },
}));

let mockEmitLocation: ((c: unknown) => void) | null = null;
jest.mock('../../hooks/useLocation', () => ({
  useLocation: () => {
    const react = require('react') as typeof React;
    const [loc, setLoc] = react.useState<unknown>(null);
    react.useEffect(() => {
      mockEmitLocation = setLoc;
      return () => {
        mockEmitLocation = null;
      };
    }, []);
    return { location: loc };
  },
}));

jest.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ profile: { id: 'motorista-1', jurisdiction: 'FL' } }),
}));
jest.mock('../../hooks/useRide', () => ({
  useDriverRide: () => ({ activeRide: null, pendingRide: null }),
}));
jest.mock('../../hooks/useDutyIdleTracker', () => ({ useDutyIdleTracker: () => [] }));
jest.mock('../../hooks/useDutyMovementTracker', () => ({
  useDutyMovementTracker: () => ({ enabled: false, workedMinutes: 0 }),
}));
jest.mock('../../hooks/useDriverPeriodTracker', () => ({
  useDriverPeriodTracker: () => ({ enabled: false, period: 'P0' }),
}));
jest.mock('../../hooks/useTelematicsSession', () => ({ useTelematicsSession: () => undefined }));
jest.mock('../../native/carRideBridge', () => ({
  updateCarActiveRide: () => undefined,
  updateCarRideOffer: () => undefined,
}));

type Ctx = ReturnType<typeof useDriverRideContext>;
let ctx: Ctx;

function Espiao() {
  ctx = useDriverRideContext();
  return null;
}

const OK = (is_online: boolean): Resp => ({ data: { is_online }, error: null });
const REDE_CAIU: Resp = { data: null, error: { message: 'network request failed' } };

/**
 * A árvore montada pelo teste corrente. Guardada para o `afterEach` DESMONTAR:
 * o Provider arma um temporizador enquanto o motorista está em serviço (o vigia
 * de posição), e uma árvore abandonada deixa esse temporizador de pé depois que
 * o arquivo termina — disparando um `setState` num ambiente de teste já
 * derrubado. Desmontar roda a limpeza do efeito e fecha isso.
 */
let arvore: ReturnType<typeof create> | null = null;

async function montar(persistido: 'true' | 'false') {
  mockStore.driver_is_online = persistido;
  await act(async () => {
    arvore = create(
      <DriverRideProvider>
        <Espiao />
      </DriverRideProvider>,
    );
  });
}

const resolvidas = new Set<number>();

/** Resolve a n-ésima escrita enviada ao servidor (0-based) e deixa o React assentar. */
async function responder(i: number, resp: Resp) {
  await act(async () => {
    resolvidas.add(i);
    mockWrites[i].resolve(resp);
  });
}

/**
 * Resolve todas as escritas ainda pendentes. Serve aos testes que não conseguem
 * saber o índice de antemão: ligar e desligar a chave com um fix de GPS na mão
 * re-dispara o efeito de posição, e quantas escritas isso gera é justamente o
 * detalhe de implementação que o teste não deve fixar.
 */
/** Resolve só a escrita mais recente, deixando as anteriores penduradas. */
async function responderUltima(resp: Resp) {
  await responder(mockWrites.length - 1, resp);
}

async function responderPendentes(resp: Resp) {
  await act(async () => {
    for (let i = 0; i < mockWrites.length; i += 1) {
      if (resolvidas.has(i)) continue;
      resolvidas.add(i);
      mockWrites[i].resolve(resp);
    }
  });
}

/** Um fix de GPS novo. Objeto novo a cada chamada — é a dependência do efeito. */
async function fixDeGps(lat: number) {
  await act(async () => {
    mockEmitLocation?.({ lat, lng: -81.3, heading: 90, speed: 12 });
  });
}

async function tocarNaChave(val: boolean) {
  await act(async () => {
    ctx.setIsOnline(val);
  });
}

beforeEach(() => {
  mockWrites.length = 0;
  resolvidas.clear();
  for (const k of Object.keys(mockStore)) delete mockStore[k];
});

afterEach(async () => {
  const montada = arvore;
  arvore = null;
  if (montada) await act(async () => { montada.unmount(); });
});

describe('DriverRideProvider — sincronia do status online', () => {
  it('toque com o MESMO valor não envia nada nem persiste', async () => {
    await montar('false');
    expect(mockWrites).toHaveLength(1); // heartbeat de abertura
    await responder(0, OK(false));
    mockSetItem.mockClear();

    await tocarNaChave(false);

    expect(mockWrites).toHaveLength(1);
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it('toque que MUDA o valor envia a transição', async () => {
    await montar('false');
    await responder(0, OK(false));

    await tocarNaChave(true);

    expect(mockWrites).toHaveLength(2);
    expect(mockWrites[1].payload.is_online).toBe(true);
  });

  it('recusa do servidor reverte a chave, levanta o banner e a marca é consumida em UMA rodada', async () => {
    await montar('false');
    await responder(0, OK(false));
    await tocarNaChave(true);

    // O trigger da 0038 coage `is_online := false` SEM erro.
    await responder(1, OK(false));

    expect(ctx.isOnline).toBe(false);
    expect(ctx.statusSyncFailed).toBe(true);
    expect(ctx.statusSyncReason).toBe('refused');
    // A reversão re-dispara o efeito, e essa rodada NÃO pode ir ao servidor —
    // senão a chave oscila em loop gravando sem parar.
    expect(mockWrites).toHaveLength(2);

    // Mas só essa. A tentativa seguinte do motorista tem de sair.
    await tocarNaChave(true);
    expect(mockWrites).toHaveLength(3);
  });

  it('toque na janela da reversão não é engolido, e a marca não fica presa', async () => {
    await montar('false');
    await responder(0, OK(false));
    await tocarNaChave(true);

    await act(async () => {
      mockWrites[1].resolve(OK(false));
      // Deixa a continuação do efeito rodar (reversão aplicada), mas ANTES do
      // commit do React — é exatamente a janela em que o toque sumia.
      await Promise.resolve();
      await Promise.resolve();
      ctx.setIsOnline(true);
    });

    expect(ctx.isOnline).toBe(true);

    // E a marca de reversão não sobreviveu ao toque: ficar offline agora tem de
    // chegar ao servidor.
    const antes = mockWrites.length;
    await tocarNaChave(false);
    expect(mockWrites.length).toBeGreaterThan(antes);
    expect(mockWrites[mockWrites.length - 1].payload.is_online).toBe(false);
  });

  it('quem abre o app JÁ ONLINE consegue sair de serviço no PRIMEIRO toque', async () => {
    // O restore do AsyncStorage escrevia o estado sem tocar no espelho de
    // intenção. O motorista via a chave verde, tocava para encerrar o turno, e o
    // toque batia no guarda de no-op e sumia: continuava visível ao passageiro e
    // recebendo ofertas depois de ter encerrado.
    await montar('true');
    expect(ctx.isOnline).toBe(true);
    await responder(0, OK(true));

    await tocarNaChave(false);

    expect(mockWrites).toHaveLength(2);
    expect(mockWrites[1].payload.is_online).toBe(false);
    expect(mockStore.driver_is_online).toBe('false');
  });

  it('falha de rede no heartbeat de abertura avisa mas NÃO inverte a chave', async () => {
    await montar('true');

    await responder(0, REDE_CAIU);

    expect(ctx.isOnline).toBe(true); // ninguém tocou em nada; inverter seria inventar
    expect(ctx.statusSyncFailed).toBe(true);
    expect(ctx.statusSyncReason).toBe('transport');
  });

  describe('a escrita de status sem fix de GPS (o banner que subia sozinho)', () => {
    // O defeito relatado: banner vermelho na tela INICIAL, motorista OFFLINE, sem
    // corrida nenhuma, em dois aparelhos. A causa não era rede: o heartbeat de
    // abertura roda assim que o AsyncStorage responde, MUITO antes do primeiro
    // fix de GPS, e mandava um UPSERT sem `lat`/`lng` — colunas `not null` sem
    // default. O Postgres valida NOT NULL na tupla proposta do insert antes de
    // resolver o `on conflict`, então a escrita falhava com 23502 mesmo com a
    // linha do motorista já existindo. `decideStatusRevert` lia `failed: true` e
    // levantava o aviso de transporte. Com a permissão de localização negada o
    // banner nunca mais saía da tela.
    it('abertura SEM fix de GPS grava o status por UPDATE, não por upsert', async () => {
      await montar('false');

      expect(mockWrites).toHaveLength(1);
      expect(mockWrites[0].op).toBe('update');
      expect(mockWrites[0].payload.is_online).toBe(false);
      // O UPDATE não pode carregar coordenada nenhuma — não temos nenhuma.
      expect(mockWrites[0].payload).not.toHaveProperty('lat');
      expect(mockWrites[0].payload).not.toHaveProperty('lng');
      expect(mockWrites[0].payload).not.toHaveProperty('driver_id');
    });

    // ── A coordenada velha não pode voltar a valer ─────────────────────────
    it('o UPDATE sem fix NÃO carimba updated_at', async () => {
      // `updated_at` é a trava de FRESCOR DA POSIÇÃO, não "quando mexemos na
      // linha": o despacho monta o leque com `is_online = true` E
      // `updated_at > agora - 10min` e lê `lat, lng` dessas linhas
      // (dispatch-engine/index.ts:151-156; a RPC do mapa faz igual, 0069:646).
      // Carimbar aqui, sem coordenada nova, ressuscitaria a posição da sessão
      // anterior como se fosse de agora — e `isOnline` vem do AsyncStorage, então
      // isso pegaria TODO motorista que fechou o app com a chave ligada.
      await montar('true');

      expect(mockWrites[0].op).toBe('update');
      expect(mockWrites[0].payload).not.toHaveProperty('updated_at');
      expect(Object.keys(mockWrites[0].payload)).toEqual(['is_online']);
    });

    it('o UPSERT com fix carimba updated_at — ali a posição é nova de verdade', async () => {
      await montar('false');
      await responder(0, OK(false));
      await fixDeGps(28.42);

      await tocarNaChave(true);

      expect(mockWrites[1].op).toBe('upsert');
      expect(typeof mockWrites[1].payload.updated_at).toBe('string');
    });

    // ── Zero linhas casadas: o motorista NÃO pode ficar preso em Offline ──────
    it('UPDATE que não casa linha nenhuma NÃO derruba a chave', async () => {
      // Motorista sem linha em `driver_locations` — conta nova que nunca ficou
      // online com GPS, ou linha apagada pelo delete-account. O PostgREST devolve
      // `{ data: null, error: null }`: sem erro e sem linha.
      //
      // A rodada anterior desta correção revertia a chave aqui. É o defeito
      // relatado por outro caminho: a ÚNICA coisa no app capaz de criar essa
      // linha é o efeito de posição, e ele começa com `if (!isOnline) return`.
      // Com a chave derrubada, o fix de GPS que chega em seguida não publica
      // nada e o motorista não entra em serviço nunca mais.
      await montar('false');
      await responder(0, { data: null, error: null });
      await tocarNaChave(true);

      await responder(1, { data: null, error: null });

      expect(ctx.isOnline).toBe(true);
      expect(mockStore.driver_is_online).toBe('true');
    });

    it('sem linha e sem fix, o PRIMEIRO fix cria a linha por upsert', async () => {
      // O desfecho que a reversão matava, encenado até o fim: é este upsert —
      // com `lat`, `lng` e `updated_at` — que faz o motorista existir para o
      // despacho. Ele só sai porque a chave continuou ligada.
      await montar('false');
      await responder(0, { data: null, error: null });
      await tocarNaChave(true);
      await responder(1, { data: null, error: null });

      await fixDeGps(28.42);

      const ultima = mockWrites[mockWrites.length - 1];
      expect(ultima.op).toBe('upsert');
      expect(ultima.payload.lat).toBe(28.42);
      expect(ultima.payload.is_online).toBe(true);
      expect(typeof ultima.payload.updated_at).toBe('string');
    });

    it('pedido de OFFLINE sem linha nenhuma não acusa falha', async () => {
      // Não há o que desligar: o servidor já não tem esse motorista em lugar
      // nenhum. Levantar banner aqui seria alarme falso — e o heartbeat de
      // abertura de todo motorista offline cairia nele.
      await montar('false');

      await responder(0, { data: null, error: null });

      expect(ctx.isOnline).toBe(false);
      expect(ctx.statusSyncFailed).toBe(false);
      expect(ctx.statusSyncReason).toBe('ok');
    });

    it('abrir o app JÁ ONLINE sem linha nenhuma mantém o turno', async () => {
      // Reverter no heartbeat de abertura é pior ainda do que no toque: ninguém
      // pediu nada, e o motorista que fechou o app em serviço reabriria fora
      // dele — sem ter tocado na chave e sem que o app tivesse dado ao GPS um
      // segundo sequer para responder. Quem cobra a ausência de posição é o
      // vigia, com carência (bloco próprio mais abaixo).
      await montar('true');

      await responder(0, { data: null, error: null });

      expect(ctx.isOnline).toBe(true);
      expect(mockStore.driver_is_online).toBe('true');
      expect(ctx.statusSyncFailed).toBe(false);
    });

    it('UPSERT que volta sem leitura continua sendo ignorância, não falha', async () => {
      // A marca `noRow` só vale para o UPDATE. Um upsert sem representação de
      // volta não prova ausência de linha — e inventar falha a partir disso
      // reacenderia o banner sozinho, que é o defeito de origem.
      await montar('false');
      await responder(0, OK(false));
      await fixDeGps(28.42);
      await tocarNaChave(true);

      await responderUltima({ data: null, error: null });

      expect(ctx.statusSyncFailed).toBe(false);
      expect(ctx.isOnline).toBe(true);
    });

    it('UPDATE que dá certo não acende banner nenhum', async () => {
      await montar('false');
      await responder(0, OK(false));

      expect(ctx.statusSyncFailed).toBe(false);
      expect(ctx.statusSyncReason).toBe('ok');
    });

    it('toque na chave SEM fix de GPS também vai por UPDATE', async () => {
      // Este teste cobre só a FORMA da escrita. A CONSEQUÊNCIA de o servidor
      // aceitá-la (linha existente + `updated_at` velho = motorista fora do
      // leque) é cobrada no bloco do vigia, mais abaixo.
      await montar('false');
      await responder(0, OK(false));

      await tocarNaChave(true);

      expect(mockWrites).toHaveLength(2);
      expect(mockWrites[1].op).toBe('update');
      expect(mockWrites[1].payload.is_online).toBe(true);
    });

    it('com fix na mão a transição volta a ser UPSERT, com coordenada', async () => {
      await montar('false');
      await responder(0, OK(false));
      await fixDeGps(28.42);
      // Offline o efeito de posição não publica nada — o fix só abastece o ref.
      expect(mockWrites).toHaveLength(1);

      await tocarNaChave(true);

      expect(mockWrites[1].op).toBe('upsert');
      expect(mockWrites[1].payload.lat).toBe(28.42);
      expect(mockWrites[1].payload.lng).toBe(-81.3);
      expect(mockWrites[1].payload.driver_id).toBe('motorista-1');
    });

    // A invariante do schema, valendo para TODA escrita que este Provider emite.
    it('todo UPSERT enviado carrega lat e lng (lat/lng são NOT NULL no banco)', async () => {
      await montar('true');
      await responderPendentes(OK(true));
      await fixDeGps(28.43);
      await responderPendentes(OK(true));
      await tocarNaChave(false);
      await responderPendentes(OK(false));
      await tocarNaChave(true);
      await responderPendentes(OK(true));

      const upserts = mockWrites.filter((w) => w.op === 'upsert');
      expect(upserts.length).toBeGreaterThan(0);
      for (const w of upserts) {
        expect(typeof w.payload.lat).toBe('number');
        expect(typeof w.payload.lng).toBe('number');
      }
    });
  });

  describe('efeito de POSIÇÃO (roda a cada fix de GPS)', () => {
    it('recusa no meio do turno derruba a chave — o efeito de transição nunca a veria', async () => {
      await montar('true');
      await responder(0, OK(true));

      await fixDeGps(28.42);
      expect(mockWrites).toHaveLength(2);
      await responder(1, OK(false)); // Connect revogado no meio do turno

      expect(ctx.isOnline).toBe(false);
      expect(ctx.statusSyncFailed).toBe(true);
      expect(ctx.statusSyncReason).toBe('refused');
    });

    it('UM pacote perdido não levanta banner; TRÊS seguidos levantam', async () => {
      await montar('true');
      await responder(0, OK(true));

      await fixDeGps(28.41);
      await responder(1, REDE_CAIU);
      expect(ctx.statusSyncFailed).toBe(false);

      await fixDeGps(28.42);
      await responder(2, REDE_CAIU);
      expect(ctx.statusSyncFailed).toBe(false);

      await fixDeGps(28.43);
      await responder(3, REDE_CAIU);
      expect(ctx.statusSyncFailed).toBe(true);
      expect(ctx.statusSyncReason).toBe('transport');
    });

    it('um sucesso no meio zera a contagem', async () => {
      await montar('true');
      await responder(0, OK(true));

      await fixDeGps(28.41);
      await responder(1, REDE_CAIU);
      await fixDeGps(28.42);
      await responder(2, REDE_CAIU);
      await fixDeGps(28.43);
      await responder(3, OK(true)); // voltou
      await fixDeGps(28.44);
      await responder(4, REDE_CAIU);
      await fixDeGps(28.45);
      await responder(5, REDE_CAIU);

      // Duas falhas depois do sucesso ainda não são uma publicação parada.
      expect(ctx.statusSyncFailed).toBe(false);
    });

    it('rede pendurada: os fixes continuam chegando e o banner sobe assim mesmo', async () => {
      // A forma REAL de uma queda de rede, e o inverso do que os testes acima
      // encenam: as requisições ficam penduradas enquanto o GPS continua
      // produzindo fix. Cada fix novo cancela a rodada anterior, então toda
      // resposta que erra volta já cancelada. Enquanto a contagem ficava DEPOIS
      // do guarda de cancelamento, ela nunca passava de zero e o banner não subia
      // em nenhuma queda de rede de verdade — só nas encenadas.
      await montar('true');
      await responder(0, OK(true));

      await fixDeGps(28.41);
      await fixDeGps(28.42);
      await fixDeGps(28.43);
      expect(mockWrites).toHaveLength(4);

      await responder(1, REDE_CAIU);
      await responder(2, REDE_CAIU);
      await responder(3, REDE_CAIU);

      expect(ctx.statusSyncFailed).toBe(true);
      expect(ctx.statusSyncReason).toBe('transport');
    });

    it('a rede voltando apaga o banner que os próprios fixes levantaram', async () => {
      // Sem isto o aviso "sem conexão" ficava preso na tela pelo resto do turno
      // depois de um bolsão sem sinal, e o motorista que confia no aviso encosta
      // e deixa de rodar por nada.
      await montar('true');
      await responder(0, OK(true));

      await fixDeGps(28.41);
      await responder(1, REDE_CAIU);
      await fixDeGps(28.42);
      await responder(2, REDE_CAIU);
      await fixDeGps(28.43);
      await responder(3, REDE_CAIU);
      expect(ctx.statusSyncFailed).toBe(true);

      await fixDeGps(28.44);
      await responder(4, OK(true));

      expect(ctx.statusSyncFailed).toBe(false);
      expect(ctx.statusSyncReason).toBe('ok');
    });

    it('um fix bem-sucedido NÃO apaga o aviso de que o toque do motorista não valeu', async () => {
      // O toque para sair de serviço se perdeu na rede e a chave voltou sozinha
      // para verde. A rede voltar não desfaz isso: o motorista continua em
      // serviço sem ter pedido, e apagar o aviso esconderia exatamente isso.
      await montar('true');
      await responder(0, OK(true));

      await tocarNaChave(false);
      await responder(1, REDE_CAIU);
      expect(ctx.isOnline).toBe(true);
      expect(ctx.statusSyncReason).toBe('transport');

      await fixDeGps(28.41);
      await responderPendentes(OK(true));

      expect(ctx.statusSyncFailed).toBe(true);
      expect(ctx.statusSyncReason).toBe('transport');
    });

    it('escrita EM VOO não reacende contagem nem autoria depois do fim do turno', async () => {
      // A versão em ORDEM deste caso está no teste abaixo, e ela passava com o
      // early-return zerando as duas refs. Só que zerar no early-return alcança
      // apenas as respostas que JÁ voltaram. Numa queda de rede de verdade as
      // escritas ficam PENDURADAS e resolvem do outro lado do fim de turno —
      // rio abaixo do ponto que deveria tê-las desarmado.
      //
      // Sequência de produção: bolsão sem sinal, três fixes pendurados; o
      // motorista toca para encerrar o turno; as três voltam com erro e
      // reivindicam a autoria do banner já offline; o toque também volta com
      // erro, devolve a chave para verde e levanta o aviso da TRANSIÇÃO ("seu
      // toque não valeu"); o primeiro fix bom apaga esse aviso achando que é
      // dele. O motorista guarda o telefone achando que saiu de serviço.
      await montar('true');
      await responder(0, OK(true));

      // Três fixes SEM resposta — é assim que uma rede caindo se parece.
      await fixDeGps(28.41);
      await fixDeGps(28.42);
      await fixDeGps(28.43);
      expect(mockWrites).toHaveLength(4);

      await tocarNaChave(false); // fim de turno: escrita 4, a da transição

      // Só AGORA a rede desiste das três. Elas pertencem ao turno que acabou.
      await responder(1, REDE_CAIU);
      await responder(2, REDE_CAIU);
      await responder(3, REDE_CAIU);

      // O toque também se perdeu: a chave volta para verde sozinha e o aviso que
      // fica na tela é da transição.
      await responder(4, REDE_CAIU);
      expect(ctx.isOnline).toBe(true);
      expect(ctx.statusSyncFailed).toBe(true);
      expect(ctx.statusSyncReason).toBe('transport');

      // A rede volta. Isso não desfaz o toque perdido, e o aviso tem de ficar.
      await fixDeGps(28.44);
      await responderUltima(OK(true));

      expect(ctx.statusSyncFailed).toBe(true);
      expect(ctx.statusSyncReason).toBe('transport');
    });

    it('a AUTORIA do banner também não atravessa turnos', async () => {
      // A variante contaminada do teste acima. Lá o efeito de posição nunca tinha
      // levantado nada, então a reivindicação de autoria estava limpa por sorte.
      // Aqui ela é levantada de verdade num bolsão sem sinal ANTES do toque, e
      // sobrevive ao fim do turno se ninguém a apagar: o aviso que fica na tela no
      // fim é o da TRANSIÇÃO ("seu toque não valeu"), e um fix bem-sucedido o
      // apagava por achar que era o seu.
      //
      // O desfecho de produção: o motorista tenta encerrar o turno, a rede engole
      // o toque, a chave volta sozinha para verde, o aviso sobe — e some no fix
      // seguinte. Ele guarda o telefone achando que saiu, e continua recebendo
      // corrida.
      await montar('true');
      await responder(0, OK(true));

      await fixDeGps(28.41);
      await responder(1, REDE_CAIU);
      await fixDeGps(28.42);
      await responder(2, REDE_CAIU);
      await fixDeGps(28.43);
      await responder(3, REDE_CAIU);
      expect(ctx.statusSyncFailed).toBe(true); // banner do POSIÇÃO, autoria dele

      // Fim de turno. É aqui que a autoria tem de morrer — sem clarão nenhum na
      // tela, porque o banner continua de pé pelo mesmo motivo de antes.
      await tocarNaChave(false);
      await responder(4, REDE_CAIU);

      // O toque não chegou: a chave voltou para verde sozinha e o aviso agora é
      // da transição, não mais do efeito de posição.
      expect(ctx.isOnline).toBe(true);
      expect(ctx.statusSyncReason).toBe('transport');

      await fixDeGps(28.44);
      await responderUltima(OK(true));

      expect(ctx.statusSyncFailed).toBe(true);
      expect(ctx.statusSyncReason).toBe('transport');
    });

    it('a contagem de falhas não atravessa turnos', async () => {
      // Duas falhas antes do almoço não podem somar com a primeira falha da
      // tarde e levantar o banner no primeiro pacote perdido do turno seguinte.
      await montar('true');
      await responder(0, OK(true));

      await fixDeGps(28.41);
      await responder(1, REDE_CAIU);
      await fixDeGps(28.42);
      await responder(2, REDE_CAIU);

      // Encerra o turno e recomeça. As escritas dos dois toques ficam penduradas
      // DE PROPÓSITO: uma resposta de sucesso no meio zeraria a contagem por
      // conta própria, e o teste passaria mesmo sem o zerar do fim de turno —
      // foi assim que a primeira versão deste teste deixou o mutante vivo.
      await tocarNaChave(false);
      await tocarNaChave(true);

      await fixDeGps(28.44);
      await responderUltima(REDE_CAIU);

      expect(ctx.statusSyncFailed).toBe(false);
    });
  });

  describe('os dois efeitos disputando o banner', () => {
    it('resposta VELHA da transição não apaga banner levantado por fixes mais novos', async () => {
      await montar('false');
      await responder(0, OK(false));

      await tocarNaChave(true); // escrita 1 — fica pendurada, servidor lento
      await fixDeGps(28.41);
      await responder(2, REDE_CAIU);
      await fixDeGps(28.42);
      await responder(3, REDE_CAIU);
      await fixDeGps(28.43);
      await responder(4, REDE_CAIU);
      expect(ctx.statusSyncFailed).toBe(true);

      // Só agora a transição responde — com sucesso, e VELHA. Apagar o banner
      // aqui deixaria o motorista achando que a posição dele está no ar.
      await responder(1, OK(true));

      expect(ctx.statusSyncFailed).toBe(true);
      expect(ctx.statusSyncReason).toBe('transport');
    });

    it('a resposta MAIS RECENTE apaga o banner normalmente', async () => {
      await montar('false');
      await responder(0, OK(false));
      await tocarNaChave(true);
      await responder(1, OK(true));

      await fixDeGps(28.41);
      await responder(2, REDE_CAIU);
      await fixDeGps(28.42);
      await responder(3, REDE_CAIU);
      await fixDeGps(28.43);
      await responder(4, REDE_CAIU);
      expect(ctx.statusSyncFailed).toBe(true);

      await tocarNaChave(false);
      await responder(5, OK(false));

      expect(ctx.statusSyncFailed).toBe(false);
      expect(ctx.statusSyncReason).toBe('ok');
    });
  });

  describe('o VIGIA: em serviço sem posição no servidor', () => {
    // O caso que nenhum dos dois efeitos enxergava. Sem fix de GPS não há
    // escrita de posição (o efeito começa com `if (!location) return`), e a
    // escrita de status que sobra é um UPDATE que o servidor ACEITA e devolve
    // `true`. Só que ela não carimba `updated_at`, e é o carimbo que põe o
    // motorista no leque do despacho (dispatch-engine/index.ts:152-156) e no mapa
    // do passageiro (0069:646). Antes do vigia: chave verde, zero erro, zero
    // banner, zero corrida — pelo turno inteiro, sem uma pista na tela.
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    /** Avança o relógio (e os temporizadores) deixando o React assentar. */
    async function passar(ms: number) {
      await act(async () => {
        jest.advanceTimersByTime(ms);
      });
    }

    it('abrir o app JÁ ONLINE sem GPS: silêncio na carência, aviso depois dela', async () => {
      await montar('true');
      await responder(0, OK(true)); // o servidor ACEITA o UPDATE sem coordenada

      // Durante a carência não se acusa nada: aqui um aparelho perfeito ainda
      // está pedindo permissão e esperando o primeiro fix.
      await passar(44_000);
      expect(ctx.statusSyncFailed).toBe(false);

      await passar(2_000);
      expect(ctx.statusSyncFailed).toBe(true);
      expect(ctx.statusSyncReason).toBe('no_position');
      // A chave NÃO cai: o `is_online` pedido está gravado, e derrubá-la faria o
      // efeito de posição parar de publicar — matando a cura.
      expect(ctx.isOnline).toBe(true);
    });

    it('motorista SEM LINHA fica em serviço e é cobrado pelo vigia, não pela chave', async () => {
      // O outro lado da mesma moeda: aqui o UPDATE não casa linha nenhuma
      // (`{ data: null, error: null }`). A chave continua ligada — é ela que
      // deixa o efeito de posição vivo para criar a linha no primeiro fix — e
      // quem cobra a ausência é o vigia, com carência e com o texto do GPS.
      await montar('false');
      await responder(0, { data: null, error: null });
      await tocarNaChave(true);
      await responder(1, { data: null, error: null });

      await passar(44_000);
      expect(ctx.statusSyncFailed).toBe(false);

      await passar(2_000);
      expect(ctx.isOnline).toBe(true);
      expect(ctx.statusSyncFailed).toBe(true);
      expect(ctx.statusSyncReason).toBe('no_position');
    });

    it('fixes de GPS sozinhos NÃO adiam o prazo do vigia, e o texto é o de conexão', async () => {
      // O vão de rede que ENGOLE a requisição sem responder: o GPS está vivo e
      // entrega fix a cada 5 s, cada fix dispara uma publicação, e nenhuma delas
      // volta — nem sucesso nem erro. Nada muda na tela e nada chega ao
      // servidor.
      //
      // Enquanto `location` era dependência do vigia, cada fix desarmava e
      // rearmava o temporizador do zero: o prazo nunca vencia e o motorista
      // ficava com a chave verde, invisível ao despacho, sem uma palavra — o
      // mesmo silêncio que o vigia existe para quebrar. O prazo é contado do
      // início do TURNO, e só uma publicação CONFIRMADA o re-arma.
      await montar('true');
      // A escrita de status (índice 0) fica pendurada de propósito.

      await passar(10_000);
      await fixDeGps(28.41);
      await passar(10_000);
      await fixDeGps(28.42);
      await passar(10_000);
      await fixDeGps(28.43);
      await passar(10_000);
      await fixDeGps(28.44);
      expect(ctx.statusSyncFailed).toBe(false); // 40 s: ainda na carência

      await passar(6_000);

      expect(ctx.statusSyncFailed).toBe(true);
      // E o texto é o de CONEXÃO, não o do GPS. Quatro fixes chegaram nos 46 s:
      // o GPS é a única peça que está comprovadamente funcionando, e mandar
      // checá-lo é o mesmo erro de mandar checar a conexão quando o problema é
      // o cadastro do Stripe — apontar para o lugar errado.
      expect(ctx.statusSyncReason).toBe('transport');
    });

    it('sair e voltar ao serviço recomeça a carência do zero', async () => {
      // O marco é do TURNO. Sem zerá-lo ao sair de serviço, o motorista que
      // encerra às 14h e volta às 20h reentraria com o prazo já vencido: aviso
      // de GPS na cara antes de o primeiro fix da noite ter chance de chegar —
      // o "banner que sobe sozinho" de novo, só que com outro texto.
      await montar('true');
      await responder(0, OK(true));
      await passar(30_000);

      await tocarNaChave(false);
      await responderUltima(OK(false));
      await passar(5 * 60_000);
      expect(ctx.statusSyncFailed).toBe(false); // offline o vigia é mudo

      await tocarNaChave(true);
      await responderUltima(OK(true));

      await passar(44_000);
      expect(ctx.statusSyncFailed).toBe(false);
      await passar(2_000);
      expect(ctx.statusSyncReason).toBe('no_position');
    });

    it('toque em ONLINE sem fix: a resposta ACEITA não passa por sucesso', async () => {
      // A reprodução em campo: motorista que já ficou online com GPS um dia
      // (linha existente), desliga o GPS, abre o app e toca em Online. O UPDATE
      // casa a linha e devolve `{ is_online: true }` — nenhum erro em lugar
      // nenhum. É por isso que a decisão olha `noPosition` e não só o retorno.
      await montar('false');
      await responder(0, OK(false));
      await tocarNaChave(true);
      await responder(1, OK(true));

      expect(ctx.statusSyncFailed).toBe(false); // ainda na carência

      await passar(46_000);
      expect(ctx.statusSyncFailed).toBe(true);
      expect(ctx.statusSyncReason).toBe('no_position');
    });

    it('o primeiro fix publicado apaga o aviso — o vigia não fica preso', async () => {
      await montar('true');
      await responder(0, OK(true));
      await passar(46_000);
      expect(ctx.statusSyncFailed).toBe(true);

      // O motorista religa o GPS. O fix vira publicação com `updated_at` novo, e
      // é isso — não o fix em si — que o devolve ao leque.
      await fixDeGps(28.42);
      await responderUltima(OK(true));

      expect(ctx.statusSyncFailed).toBe(false);
      expect(ctx.statusSyncReason).toBe('ok');
    });

    it('GPS apenas lento não vira alarme falso', async () => {
      // A trava contra o "banner que subia sozinho": um fix chegando dentro da
      // carência tem de deixar a tela limpa para sempre depois disso.
      await montar('true');
      await responder(0, OK(true));
      await passar(10_000);
      await fixDeGps(28.42);
      await responderUltima(OK(true));

      await passar(120_000);

      expect(ctx.statusSyncFailed).toBe(false);
    });

    it('fora de serviço o vigia não abre a boca', async () => {
      // Offline a posição não é publicada de propósito (privacidade do motorista
      // fora de serviço). Cobrar frescor aqui seria alarme falso em todo mundo.
      await montar('false');
      await responder(0, OK(false));

      await passar(10 * 60_000);

      expect(ctx.statusSyncFailed).toBe(false);
    });

    it('publicação que PARA no meio do turno avisa antes de o motorista sumir do leque', async () => {
      // O Android mata o GPS com o app em segundo plano: os fixes simplesmente
      // param. `useLocation` nunca zera a posição, então nada na tela muda e
      // nenhuma escrita nova sai. Aos 10 min o `updated_at` vence e o despacho
      // para de considerá-lo; o aviso sai aos 8, com margem para reagir.
      await montar('true');
      await responder(0, OK(true));
      await fixDeGps(28.42);
      await responderUltima(OK(true));

      await passar(7 * 60_000);
      expect(ctx.statusSyncFailed).toBe(false);

      await passar(90_000);
      expect(ctx.statusSyncFailed).toBe(true);
      expect(ctx.statusSyncReason).toBe('no_position');
    });

    it('a resposta ACEITA do status não apaga o aviso do vigia', async () => {
      // A escrita de status pendurada num servidor lento resolve DEPOIS de o
      // prazo vencer. Ela volta `{ is_online: true }`, sem erro — e se isso
      // contasse como sucesso, o aviso sumiria da tela sem que uma única
      // coordenada tivesse chegado ao servidor. O motorista voltaria ao silêncio
      // com a chave verde, que é o defeito inteiro.
      await montar('true');
      expect(mockWrites).toHaveLength(1); // pendurada de propósito

      await passar(46_000);
      expect(ctx.statusSyncReason).toBe('no_position');

      await responder(0, OK(true));

      expect(ctx.statusSyncFailed).toBe(true);
      expect(ctx.statusSyncReason).toBe('no_position');
    });

    it('o aviso de rede caída ganha do vigia — quem levantou é quem apaga', async () => {
      // Os fixes estão chegando (o GPS está vivo), mas nenhum chega ao servidor.
      // O texto certo aí é o de conexão, e o vigia não pode trocá-lo pelo de GPS
      // nem apagá-lo quando o prazo dele vencer.
      await montar('true');
      await responder(0, OK(true));
      await fixDeGps(28.41);
      await responder(1, REDE_CAIU);
      await fixDeGps(28.42);
      await responder(2, REDE_CAIU);
      await fixDeGps(28.43);
      await responder(3, REDE_CAIU);
      expect(ctx.statusSyncReason).toBe('transport');

      await passar(10 * 60_000);

      expect(ctx.statusSyncFailed).toBe(true);
      expect(ctx.statusSyncReason).toBe('transport');
    });

    it('recusa do trigger DEPOIS do aviso do vigia não deixa a chave cair calada', async () => {
      // O pior desfecho possível, e ele nasceu de uma ref de autoria duplicada.
      // Enquanto o levantamento e o banner na tela tinham donos separados, esta
      // sequência derrubava a chave e APAGAVA a explicação no mesmo commit:
      //
      //   motorista novo (o mesmo que esbarra no cadastro do Stripe) abre o app
      //   na garagem → 45 s sem fix, o vigia levanta 'no_position' → o GPS
      //   acorda → a publicação volta RECUSADA pelo trigger 0038 → a chave cai
      //   → o vigia re-roda (publicação e `isOnline` mudaram), acha que o banner
      //   ainda é dele e limpa a tela.
      //
      // Resultado em campo: Offline, tela limpa, nenhuma palavra — o silêncio
      // que o cabeçalho de driverOnlineStatus.ts existe para acabar. E o banner
      // apagado era justamente o que mandaria o motorista ao cadastro de repasse,
      // que é a única coisa capaz de destravar a conta dele.
      await montar('true');
      await responder(0, OK(true));

      await passar(46_000);
      expect(ctx.statusSyncReason).toBe('no_position');
      expect(ctx.isOnline).toBe(true);

      await fixDeGps(28.42);
      await responderUltima(OK(false)); // o trigger coage `is_online := false`

      expect(ctx.isOnline).toBe(false);
      expect(ctx.statusSyncFailed).toBe(true);
      expect(ctx.statusSyncReason).toBe('refused');
    });

    it('o toque que dá certo apaga o aviso de rede que já não vale', async () => {
      // Não LEVANTAR o aviso de falta de posição na escrita de status é certo —
      // quem faz isso é o vigia, depois da carência. Calar a escrita INTEIRA não
      // era: ela também é quem apaga um aviso velho que a própria resposta
      // desmente. Sem isso, o motorista que perdeu o toque numa queda de rede
      // tocava de novo com a rede boa, FICAVA online — e o banner vermelho de
      // conexão seguia na tela o turno inteiro, porque o vigia é mudo enquanto
      // houver aviso e o efeito de posição só apaga o que ele mesmo levantou.
      await montar('false');
      await responder(0, OK(false));

      await tocarNaChave(true);
      await responderUltima(REDE_CAIU);
      expect(ctx.isOnline).toBe(false); // o toque não valeu, a chave voltou
      expect(ctx.statusSyncReason).toBe('transport');

      // A rede voltou. O UPDATE sem fix é ACEITO: a escrita chegou e voltou com
      // o valor pedido, o que desmente o aviso de conexão que está na tela.
      await tocarNaChave(true);
      await responderUltima(OK(true));

      expect(ctx.isOnline).toBe(true);
      expect(ctx.statusSyncFailed).toBe(false);
      expect(ctx.statusSyncReason).toBe('ok');

      // E apagar não é calar: a falta de posição continua sendo cobrada por quem
      // tem competência para isso, depois da carência.
      await passar(46_000);
      expect(ctx.statusSyncReason).toBe('no_position');
    });

    it('publicação que trava com o GPS VIVO manda checar a conexão, não o GPS', async () => {
      // A outra metade da distinção. Aqui a posição já publicou uma vez (o prazo
      // é o de frescor, 8 min), o GPS continua entregando fix — e a publicação
      // desse fix fica pendurada num vão de rede que não responde e também não
      // erra, então a contagem de falhas do efeito de posição nunca dispara.
      //
      // O prazo vence do mesmo jeito, mas mandar checar o GPS aqui aponta para o
      // único pedaço do aparelho que está comprovadamente funcionando.
      await montar('true');
      await responder(0, OK(true));
      await fixDeGps(28.42);
      await responderUltima(OK(true)); // publicou: o relógio de frescor arma

      await passar(4 * 60_000);
      await fixDeGps(28.43); // sai a publicação, e ela nunca volta
      await passar(4 * 60_000 + 1_000);

      expect(ctx.statusSyncFailed).toBe(true);
      expect(ctx.statusSyncReason).toBe('transport');
      // A chave não cai: derrubá-la desligaria o efeito de posição, que é o
      // único capaz de curar isto quando a rede voltar.
      expect(ctx.isOnline).toBe(true);
    });
  });
});
