import {
  setMetricsSink,
  consoleMetricsSink,
  setBatteryProvider,
  recordMetric,
  startTiming,
  sampleBattery,
  recentSamples,
  clearSamples,
  markJsBootstrapStart,
  markAppInteractive,
  type MetricSample,
} from '../fieldMetrics';

/**
 * O módulo que MEDE é o único que não pode ser medido depois. Se ele registrar
 * uma amostra que ninguém observou — um zero de placeholder, uma duração de um
 * relógio que andou para trás, um bootstrap contado duas vezes — o número
 * falso entra na série com a mesma cara de um número real, e a auditoria
 * inteira passa a repousar sobre ele. Por isso quase todo teste aqui é sobre
 * o que NÃO deve ser gravado.
 */

const nowSpy = jest.spyOn(performance, 'now');

function coletadas(): MetricSample[] {
  const recebidas: MetricSample[] = [];
  setMetricsSink((s) => recebidas.push(s));
  return recebidas;
}

beforeEach(() => {
  clearSamples();
  setMetricsSink(null);
  setBatteryProvider(null);
  nowSpy.mockReset();
  // Padrão: relógio parado. Cada teste que se importa com duração dita a sua
  // própria sequência.
  nowSpy.mockReturnValue(0);
});

afterAll(() => {
  nowSpy.mockRestore();
});

describe('startTiming', () => {
  it('grava a duração decorrida em ms', () => {
    nowSpy.mockReturnValueOnce(1000).mockReturnValueOnce(1240);
    const fim = startTiming('autocomplete_round_trip');

    expect(fim()).toBe(240);
    expect(recentSamples()).toEqual([
      expect.objectContaining({ name: 'autocomplete_round_trip', value: 240, unit: 'ms' }),
    ]);
  });

  it('usa relógio MONOTÔNICO, não relógio de parede', () => {
    // performance.now não sofre ajuste de NTP nem troca de fuso; Date.now sim.
    // Se a implementação trocar para Date.now, o relógio congelado abaixo faz
    // a duração virar o tempo real de execução e a asserção quebra.
    nowSpy.mockReturnValueOnce(500).mockReturnValueOnce(500);
    const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(0);
    try {
      const fim = startTiming('route_compute');
      expect(fim()).toBe(0);
      expect(nowSpy).toHaveBeenCalled();
    } finally {
      dateSpy.mockRestore();
    }
  });

  it('relógio andando PARA TRÁS não vira amostra', () => {
    // Só alcançável no fallback de Date.now, mas registrar -80ms seria pior do
    // que perder a amostra: a média fica errada e nada denuncia.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      nowSpy.mockReturnValueOnce(2000).mockReturnValueOnce(1920);
      const fim = startTiming('route_compute');

      expect(fim()).toBeNull();
      expect(recentSamples()).toEqual([]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('entrega a amostra ao sink com o contexto já sanitizado', () => {
    const recebidas = coletadas();
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(10);

    startTiming('place_details_round_trip')({ sessionToken: 'tok-abc', resolved: true });

    expect(recebidas).toHaveLength(1);
    // `token` casa com SENSITIVE_KEY — nunca pode chegar inteiro à telemetria.
    expect(recebidas[0].context).toEqual({ sessionToken: '[redacted]', resolved: true });
  });

  it('sink que explode não derruba quem estava medindo', () => {
    setMetricsSink(() => {
      throw new Error('destino fora do ar');
    });
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(5);

    expect(() => startTiming('route_compute')()).not.toThrow();
    // E a amostra continua retida localmente, apesar do sink quebrado.
    expect(recentSamples()).toHaveLength(1);
  });
});

describe('destino console', () => {
  it('só sai no console quando alguém pluga o sink de propósito', () => {
    // Logar toda amostra por padrão despejava ~240 linhas na saída da suíte.
    // Aviso de verdade some no meio disso.
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      recordMetric('route_compute', 12, 'ms');
      expect(log).not.toHaveBeenCalled();

      setMetricsSink(consoleMetricsSink);
      recordMetric('route_compute', 34, 'ms');
      expect(log).toHaveBeenCalledWith('[metric] route_compute 34ms', '');
    } finally {
      log.mockRestore();
    }
  });
});

describe('recordMetric', () => {
  it('recusa valor não finito', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      recordMetric('battery_level', Number.NaN, 'pct');
      recordMetric('route_compute', Number.POSITIVE_INFINITY, 'ms');

      expect(recentSamples()).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('partida (o pedaço visível ao JS)', () => {
  it('mede do primeiro módulo JS até o app utilizável', () => {
    nowSpy.mockReturnValueOnce(100).mockReturnValueOnce(1800);
    markJsBootstrapStart();
    markAppInteractive();

    expect(recentSamples()).toEqual([
      expect.objectContaining({ name: 'js_bootstrap_to_interactive', value: 1700 }),
    ]);
  });

  it('é de disparo ÚNICO — troca de sessão não vira partida nova', () => {
    // O efeito que chama markAppInteractive depende de `loading`, que oscila de
    // novo a cada login/logout. Sem a trava, cada re-autenticação injetaria uma
    // "partida a frio" curtíssima e puxaria a média para baixo.
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(2000).mockReturnValueOnce(9999);
    markJsBootstrapStart();
    markAppInteractive();
    markAppInteractive();

    expect(recentSamples()).toHaveLength(1);
    expect(recentSamples()[0].value).toBe(2000);
  });

  it('não grava nada se o app ficar pronto sem bootstrap marcado', () => {
    markAppInteractive();
    expect(recentSamples()).toEqual([]);
  });

  it('marcar o início duas vezes não adianta o t0', () => {
    // A 2ª chamada sai antes de tocar o relógio, então a sequência é
    // consumida como t0=100 e fim=900 → 800. Se ela vencesse, o t0 viraria 900,
    // o fim leria 1100 e a amostra encolheria para 200 — some da conta
    // justamente o trecho mais caro do bootstrap.
    nowSpy.mockReturnValueOnce(100).mockReturnValueOnce(900).mockReturnValueOnce(1100);
    markJsBootstrapStart();
    markJsBootstrapStart();
    markAppInteractive();

    expect(recentSamples()[0].value).toBe(800);
  });
});

describe('bateria', () => {
  it('sem provider registrado, não existe amostra (e não existe zero)', async () => {
    // O app não tem expo-battery. A resposta certa para "qual a bateria?" é
    // "não sei", nunca 0 — um zero aqui reprovaria a régua de regressão sozinho.
    await expect(sampleBattery()).resolves.toBeNull();
    expect(recentSamples()).toEqual([]);
  });

  it('com provider, grava a carga em pontos percentuais', async () => {
    setBatteryProvider(async () => 82);

    await expect(sampleBattery({ phase: 'ride_start' })).resolves.toBe(82);
    expect(recentSamples()).toEqual([
      expect.objectContaining({ name: 'battery_level', value: 82, unit: 'pct' }),
    ]);
  });

  it('provider que falha não vira amostra nem propaga o erro', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      setBatteryProvider(async () => {
        throw new Error('sem permissão');
      });

      await expect(sampleBattery()).resolves.toBeNull();
      expect(recentSamples()).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('provider que devolve null não vira amostra', async () => {
    setBatteryProvider(async () => null);

    await expect(sampleBattery()).resolves.toBeNull();
    expect(recentSamples()).toEqual([]);
  });
});

describe('retenção em memória', () => {
  it('descarta as MAIS ANTIGAS ao estourar o limite', () => {
    for (let i = 0; i < 205; i++) recordMetric('route_compute', i, 'ms');

    const guardadas = recentSamples();
    expect(guardadas).toHaveLength(200);
    // A janela tem de deslizar para a frente: manter as primeiras e largar as
    // recentes deixaria o app rodando horas sem nunca mostrar o estado atual.
    expect(guardadas[0].value).toBe(5);
    expect(guardadas[199].value).toBe(204);
  });

  it('devolve uma CÓPIA — quem lê não consegue apagar a série', () => {
    recordMetric('route_compute', 1, 'ms');
    recentSamples().length = 0;

    expect(recentSamples()).toHaveLength(1);
  });
});
