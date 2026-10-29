import React from 'react';
import { create, act } from 'react-test-renderer';
import { useDutyMovementTracker } from '../useDutyMovementTracker';

/**
 * A JORNADA POR MOVIMENTO, DO LADO DA FIAÇÃO.
 *
 * A máquina pura (src/lib/dutyMovement.ts) sempre soube congelar quando perde o
 * GPS — o teste dela passa `speedMps: null` e vê UNKNOWN. O furo nunca esteve
 * lá: estava aqui. `useLocation` devolve a posição em estado e NUNCA a zera
 * quando os fixes param de chegar (useLocation.ts:26,124-141), então este hook
 * repetia a ÚLTIMA velocidade lida para sempre. App minimizado, tela bloqueada,
 * GPS desligado pelo Android: a máquina continuava vendo "54 km/h" e creditava
 * o intervalo inteiro como jornada, até estourar o limite e impor descanso
 * obrigatório a quem estava com o carro parado na garagem.
 *
 * Por isso o teste é de HOOK e não de função pura: o que precisa ser provado é
 * que a velocidade parada de chegar deixa de contar.
 */

jest.mock('../useFeatureFlag', () => ({ useFeatureFlag: () => true }));
jest.mock('../../lib/systemConfig', () => ({
  getConfig: () => Promise.resolve('token-de-teste'),
}));
jest.mock('../../lib/errorReporting', () => ({ reportWarning: () => undefined }));

const mockStore: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: (k: string) => Promise.resolve(mockStore[k] ?? null),
    setItem: (k: string, v: string) => {
      mockStore[k] = v;
      return Promise.resolve();
    },
    multiSet: (pares: [string, string][]) => {
      for (const [k, v] of pares) mockStore[k] = v;
      return Promise.resolve();
    },
  },
}));

/** Cada item é uma linha que o app mandaria para a trilha de auditoria. */
const auditoria: Array<{ reason: string }> = [];
jest.mock('../../lib/supabase', () => ({
  supabase: {
    from: () => ({
      insert: (linha: { reason: string }) => {
        auditoria.push(linha);
        return { then: (cb: (r: { error: null }) => void) => cb({ error: null }) };
      },
    }),
  },
}));

type Fix = { speed: number } | null;

let minutos = 0;

function Sonda({ fix, online }: { fix: Fix; online: boolean }) {
  const r = useDutyMovementTracker('motorista-1', online, fix);
  minutos = r.workedMinutes;
  return null;
}

/** ~54 km/h, bem acima do limiar de 8 km/h da histerese. */
const ANDANDO = 15;

describe('useDutyMovementTracker — a velocidade velha não conta como movimento', () => {
  beforeEach(() => {
    for (const k of Object.keys(mockStore)) delete mockStore[k];
    minutos = 0;
    auditoria.length = 0;
    jest.useFakeTimers();
    jest.setSystemTime(0);
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  /** Avança o relógio E dispara os ticks de 60s que caem no caminho. */
  async function avancar(ms: number) {
    await act(async () => {
      jest.advanceTimersByTime(ms);
    });
  }

  /**
   * O APP MINIMIZADO: o relógio anda, os timers NÃO disparam.
   *
   * `advanceTimersByTime` faz o contrário — ele roda o tick de 60 s dentro do
   * intervalo, que é justamente o que o sistema operacional NÃO faz quando
   * suspende o app. Sem este helper, o teste de background estava na verdade
   * testando morte de GPS em primeiro plano.
   */
  function dormir(ms: number) {
    jest.setSystemTime(Date.now() + ms);
  }

  /** Entrega um fix NOVO (objeto novo, como o useLocation faz a cada leitura). */
  async function novoFix(arvore: ReturnType<typeof create>, speed: number) {
    await act(async () => {
      arvore.update(<Sonda fix={{ speed }} online />);
    });
  }

  async function montarAndando() {
    let arvore!: ReturnType<typeof create>;
    await act(async () => {
      arvore = create(<Sonda fix={{ speed: ANDANDO }} online />);
    });
    // A histerese exige 8 km/h sustentado por 30 s antes de confirmar MOVING.
    await avancar(1_000);
    await novoFix(arvore, ANDANDO);
    await avancar(31_000);
    await novoFix(arvore, ANDANDO);
    return arvore;
  }

  it('com fixes chegando, a jornada anda', async () => {
    const arvore = await montarAndando();
    const antes = minutos;
    // 5 minutos de estrada, com fix a cada 5 s como o watch entrega.
    for (let i = 0; i < 60; i += 1) {
      await avancar(5_000);
      await novoFix(arvore, ANDANDO);
    }
    expect(minutos - antes).toBeGreaterThan(4.9);
  });

  it('fixes PARAM de chegar: a contagem congela em vez de creditar o vazio', async () => {
    const arvore = await montarAndando();
    await avancar(60_000);
    await novoFix(arvore, ANDANDO);
    const aoCongelar = minutos;

    // Daqui em diante NENHUM fix novo — o app foi para o background, o Android
    // matou o GPS, o motorista bloqueou a tela. O componente segue montado e o
    // tick de 60 s segue rodando com a última velocidade conhecida.
    await avancar(3 * 60 * 60_000);

    // Antes desta correção, `minutos` chegava a ~180 aqui e o descanso
    // obrigatório (limite de 12 h) começava a se aproximar sozinho.
    expect(minutos).toBeLessThan(aoCongelar + 1.6); // no máximo os 90 s de prova
    expect(minutos).toBeGreaterThanOrEqual(aoCongelar);
  });

  it('o GPS voltando volta a contar — o congelamento não é definitivo', async () => {
    const arvore = await montarAndando();
    await avancar(2 * 60 * 60_000); // 2 h congelado
    const congelado = minutos;

    // O sinal volta e o carro anda de verdade por 10 min.
    await novoFix(arvore, ANDANDO);
    await avancar(31_000);
    await novoFix(arvore, ANDANDO);
    for (let i = 0; i < 120; i += 1) {
      await avancar(5_000);
      await novoFix(arvore, ANDANDO);
    }
    expect(minutos).toBeGreaterThan(congelado + 9);
    expect(minutos).toBeLessThan(congelado + 12);
  });

  it('app MINIMIZADO 3h (timers suspensos) e o fix que ACORDA é NOVO', async () => {
    // O cenário do enunciado, e o que os testes anteriores NÃO cobriam: ao
    // acordar, o `useLocation` entrega um fix legítimo de AGORA. O carimbo de
    // frescor sai igual ao instante do sample, então nada nele denuncia o
    // buraco — quem tem de denunciar é o horizonte de prova do passo anterior.
    const arvore = await montarAndando();
    await avancar(60_000);
    await novoFix(arvore, ANDANDO);
    const aoDormir = minutos;

    dormir(3 * 60 * 60_000); // nenhum tick roda aqui: o app está suspenso
    await novoFix(arvore, ANDANDO); // fix NOVO, velocidade real, agora

    // Antes do corte, este único sample creditava as 3 h inteiras.
    expect(minutos).toBeLessThan(aoDormir + 1.6); // no máximo os 90 s de prova
    expect(minutos).toBeGreaterThanOrEqual(aoDormir);
  });

  it('e depois de acordar volta a contar normalmente', async () => {
    const arvore = await montarAndando();
    dormir(3 * 60 * 60_000);
    await novoFix(arvore, ANDANDO);
    const aoAcordar = minutos;

    // 5 min de estrada de verdade, fix a cada 5 s.
    for (let i = 0; i < 60; i += 1) {
      await avancar(5_000);
      await novoFix(arvore, ANDANDO);
    }
    expect(minutos - aoAcordar).toBeGreaterThan(4.9);
    expect(minutos - aoAcordar).toBeLessThan(5.2);
  });

  it('kill + reboot 8h depois: o estado volta do disco e o gap não é creditado', async () => {
    const arvore = await montarAndando();
    await avancar(60_000);
    await novoFix(arvore, ANDANDO);
    const antesDoKill = minutos;
    await act(async () => {
      arvore.unmount();
    });

    // O aparelho passa 8 h desligado. Na volta, o hook recarrega a máquina do
    // AsyncStorage e o `useLocation` entrega o primeiro fix em ~1 s — muito
    // antes do primeiro tick de 60 s.
    dormir(8 * 60 * 60_000);
    let renascido!: ReturnType<typeof create>;
    await act(async () => {
      renascido = create(<Sonda fix={{ speed: ANDANDO }} online />);
    });
    await novoFix(renascido, ANDANDO);

    expect(minutos).toBeLessThan(antesDoKill + 1.6);
    expect(minutos).toBeGreaterThanOrEqual(antesDoKill);
  });

  it('a noite inteira congelado não vira uma linha de auditoria por minuto', async () => {
    // O corte da prova vencida continua satisfeito a cada tick enquanto nenhum
    // fix válido chega. Emitir ali seria trocar um defeito de contagem por um de
    // rede: ~480 inserts na madrugada de quem esqueceu o app aberto.
    const arvore = await montarAndando();
    await novoFix(arvore, ANDANDO);
    auditoria.length = 0;

    await avancar(8 * 60 * 60_000); // 8 h de ticks, nenhum fix novo

    // Dois eventos, e só dois: o buraco no intervalo (onde a prova venceu) e o
    // congelamento que veio no mesmo passo. Os dois PRECISAM sair — a linha do
    // buraco é a única explicação de por que a jornada parou de andar, e ela
    // ficava pelo caminho quando o passo também transitava. Depois deles,
    // silêncio: é a madrugada inteira de quem esqueceu o app aberto.
    expect(auditoria.map((l) => l.reason)).toEqual(['evidence_gap', 'gps_lost']);
  });
});
