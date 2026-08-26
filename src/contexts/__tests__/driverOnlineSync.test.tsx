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

const mockWrites: Array<{ payload: Record<string, unknown>; resolve: (r: Resp) => void }> = [];
const mockStore: Record<string, string | null> = {};
const mockSetItem = jest.fn();

jest.mock('../../lib/supabase', () => ({
  supabase: {
    from: () => ({
      upsert: (payload: Record<string, unknown>) => ({
        select: () => ({
          maybeSingle: () =>
            new Promise<Resp>((resolve) => {
              mockWrites.push({ payload, resolve });
            }),
        }),
      }),
    }),
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

async function montar(persistido: 'true' | 'false') {
  mockStore.driver_is_online = persistido;
  await act(async () => {
    create(
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
});
