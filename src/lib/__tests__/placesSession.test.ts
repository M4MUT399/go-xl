import { readFileSync } from 'fs';
import { join } from 'path';
import {
  newSessionToken,
  resolvePlace,
  searchPlaces,
  type PlaceSuggestion,
} from '../geocoding';
import { callEdgeFunction } from '../edgeFunction';
import { clearSamples, recentSamples } from '../fieldMetrics';

jest.mock('../edgeFunction', () => ({ callEdgeFunction: jest.fn() }));

const mockCall = callEdgeFunction as jest.MockedFunction<typeof callEdgeFunction>;

// ESCOPO DESTE ARQUIVO: o contrato entre o cliente e a Edge Function
// `places-search`, mais a decisão de faturamento que mora no servidor.
//
// O que este arquivo NÃO prova, e ninguém deve ler como provado:
//   · que a Google aceita estes corpos — nenhuma chamada real foi feita;
//   · que a sessão é TROCADA depois do details. O token aqui é parâmetro, então
//     dá para mostrar que ele é repassado igual às duas chamadas, não que a
//     tela gera um novo depois. A rotação vive em RequestRideScreen e segue
//     sem cobertura;
//   · latência. A régua de 300 ms continua não medida.

const SERVIDOR = join(__dirname, '../../../supabase/functions/places-search/index.ts');

/** Lê um regex do servidor em vez de copiá-lo — cópia não detecta divergência. */
function regexDoServidor(nome: string): RegExp {
  const src = readFileSync(SERVIDOR, 'utf8');
  const m = new RegExp(`^const ${nome} = /(.+)/;$`, 'm').exec(src);
  if (!m) throw new Error(`não achei \`const ${nome} = /.../\` em ${SERVIDOR}`);
  return new RegExp(m[1]);
}

const PREDICAO = {
  placePrediction: {
    placeId: 'ChIJ_MCO_terminal_A',
    text: { text: 'Orlando International Airport Terminal A, Orlando, FL' },
    structuredFormat: {
      mainText: { text: 'Orlando International Airport Terminal A' },
      secondaryText: { text: 'Orlando, FL, USA' },
    },
    types: ['airport'],
  },
};

describe('newSessionToken', () => {
  it('sai no formato UUID v4 que a Google recomenda', () => {
    expect(newSessionToken()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('não repete — token repetido junta buscas de sessões diferentes', () => {
    const tokens = new Set(Array.from({ length: 500 }, newSessionToken));
    expect(tokens.size).toBe(500);
  });

  it('passa no validador do próprio servidor', () => {
    // Este é o ponto de fricção real: quem gera está no cliente e quem recusa
    // está na Edge Function. Se um dos dois lados mudar de formato sozinho,
    // toda busca vira 400 e o app cai calado no Nominatim.
    const validador = regexDoServidor('SESSION_TOKEN_OK');
    for (let i = 0; i < 50; i++) {
      expect(validador.test(newSessionToken())).toBe(true);
    }
  });
});

describe('trava de injeção no servidor', () => {
  it('o placeId não pode escapar do caminho da URL', () => {
    const validador = regexDoServidor('PLACE_ID_OK');
    expect(validador.test('ChIJ_MCO_terminal_A')).toBe(true);
    for (const hostil of ['../../evil', 'a/b', 'a?key=x', 'a&b', '', 'a b']) {
      expect(validador.test(hostil)).toBe(false);
    }
  });

  it('o sessionToken não pode virar query string extra', () => {
    const validador = regexDoServidor('SESSION_TOKEN_OK');
    for (const hostil of ['a&fields=all', 'a?x=1', '../x', '']) {
      expect(validador.test(hostil)).toBe(false);
    }
  });
});

describe('searchPlaces', () => {
  it('manda o token recebido e traduz a predição para a linha da lista', async () => {
    mockCall.mockResolvedValueOnce({ suggestions: [PREDICAO] });

    const out = await searchPlaces('orlando intl', 'tok-1', { lat: 28.42, lng: -81.31 });

    expect(mockCall).toHaveBeenCalledWith('places-search', {
      action: 'autocomplete',
      query: 'orlando intl',
      near: { lat: 28.42, lng: -81.31 },
      sessionToken: 'tok-1',
    });
    expect(out).toEqual([
      {
        placeId: 'ChIJ_MCO_terminal_A',
        shortName: 'Orlando International Airport Terminal A',
        address: 'Orlando, FL, USA',
        category: 'Aeroporto',
        // Os tipos crus seguem junto: é por eles que a tela sabe que o destino
        // é aeroporto e pede voo + terminal.
        types: ['airport'],
      },
    ]);
  });

  it('a predição não traz coordenada — quem trouxer está inventando', async () => {
    mockCall.mockResolvedValueOnce({ suggestions: [PREDICAO] });
    const [sugestao] = await searchPlaces('orlando intl', 'tok-1');
    expect(sugestao.location).toBeUndefined();
  });

  it('não gasta sessão com menos de 3 caracteres', async () => {
    expect(await searchPlaces('or', 'tok-1')).toEqual([]);
    expect(mockCall).not.toHaveBeenCalled();
  });

  it('descarta sugestão sem placeId, que seria intocável na lista', async () => {
    mockCall.mockResolvedValueOnce({
      suggestions: [{ placePrediction: { text: { text: 'sem id' } } }, PREDICAO],
    });
    const out = await searchPlaces('orlando', 'tok-1');
    expect(out).toHaveLength(1);
    expect(out[0].placeId).toBe('ChIJ_MCO_terminal_A');
  });
});

describe('resolvePlace', () => {
  it('fecha a sessão com o MESMO token da busca e devolve lat/lng', async () => {
    mockCall.mockResolvedValueOnce({ suggestions: [PREDICAO] });
    const [sugestao] = await searchPlaces('orlando intl', 'tok-1');

    mockCall.mockResolvedValueOnce({ location: { latitude: 28.4312, longitude: -81.3081 } });
    const ponto = await resolvePlace(sugestao, 'tok-1');

    expect(mockCall).toHaveBeenLastCalledWith('places-search', {
      action: 'details',
      placeId: 'ChIJ_MCO_terminal_A',
      sessionToken: 'tok-1',
    });
    expect(ponto).toEqual({ lat: 28.4312, lng: -81.3081 });
  });

  it('devolve null quando a resolução falha, em vez de um ponto inventado', async () => {
    mockCall.mockRejectedValueOnce(new Error('rede caiu'));
    const sugestao: PlaceSuggestion = { placeId: 'ChIJ_x', shortName: 'X', address: 'X' };
    expect(await resolvePlace(sugestao, 'tok-1')).toBeNull();
  });

  it('devolve null quando a Google responde sem location', async () => {
    mockCall.mockResolvedValueOnce({ location: null });
    const sugestao: PlaceSuggestion = { placeId: 'ChIJ_x', shortName: 'X', address: 'X' };
    expect(await resolvePlace(sugestao, 'tok-1')).toBeNull();
  });
});

describe('fallback Nominatim', () => {
  const RESPOSTA_NOMINATIM = [
    { lat: '28.5383', lon: '-81.3792', display_name: 'Orlando, Orange County, Florida, USA' },
  ];

  beforeEach(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => RESPOSTA_NOMINATIM,
    }) as unknown as typeof fetch;
  });

  it('assume quando o autocomplete falha, e já vem com coordenada', async () => {
    mockCall.mockRejectedValueOnce(new Error('Places (New) não habilitada'));
    const out = await searchPlaces('orlando', 'tok-1');

    expect(out).toHaveLength(1);
    expect(out[0].placeId).toBe('');
    expect(out[0].location).toEqual({ lat: 28.5383, lng: -81.3792 });
  });

  it('resolver uma sugestão dele não chama a Google — não há sessão a fechar', async () => {
    mockCall.mockRejectedValueOnce(new Error('Places (New) não habilitada'));
    const [sugestao] = await searchPlaces('orlando', 'tok-1');

    mockCall.mockClear();
    const ponto = await resolvePlace(sugestao, 'tok-1');

    expect(ponto).toEqual({ lat: 28.5383, lng: -81.3792 });
    expect(mockCall).not.toHaveBeenCalled();
  });
});

describe('fiação da medição de latência', () => {
  // O cronômetro em si está coberto em fieldMetrics.test.ts. O que se prova
  // aqui é a FIAÇÃO — que ela dispara uma vez por espera real, e não dispara
  // quando não houve espera. Fiação errada não quebra o app: ela enche a série
  // de amostras que ninguém viveu, e aí a régua de 300 ms passa a ser medida
  // contra ficção.
  //
  // Continua NÃO MEDIDA: instrumentar não é medir. Nenhum número aqui vem de
  // aparelho, e as asserções são sobre forma e contagem, nunca sobre duração.
  beforeEach(() => {
    clearSamples();
  });

  it('uma busca atendida pela Google grava UMA amostra', async () => {
    mockCall.mockResolvedValueOnce({ suggestions: [PREDICAO] });

    await searchPlaces('orlando intl', 'tok-1');

    const amostras = recentSamples().filter((s) => s.name === 'autocomplete_round_trip');
    expect(amostras).toHaveLength(1);
    expect(amostras[0].unit).toBe('ms');
    expect(amostras[0].context).toMatchObject({ source: 'google', results: 1 });
  });

  it('menos de 3 caracteres não grava amostra — não houve ida à rede', async () => {
    // Um zero aqui por tecla seria a forma mais fácil de a régua de 300 ms
    // "passar": bastaria digitar devagar.
    await searchPlaces('or', 'tok-1');

    expect(recentSamples()).toEqual([]);
  });

  it('queda no Nominatim sai rotulada como nominatim, não como google', async () => {
    const fetchOriginal = global.fetch;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => [{ lat: '28.5383', lon: '-81.3792', display_name: 'Orlando, FL, USA' }],
    }) as unknown as typeof fetch;
    try {
      mockCall.mockRejectedValueOnce(new Error('Places (New) não habilitada'));

      await searchPlaces('orlando', 'tok-1');

      const amostras = recentSamples().filter((s) => s.name === 'autocomplete_round_trip');
      // Uma amostra só, cobrindo as DUAS idas: foi isso que o usuário esperou.
      expect(amostras).toHaveLength(1);
      expect(amostras[0].context).toMatchObject({ source: 'nominatim' });
    } finally {
      global.fetch = fetchOriginal;
    }
  });

  it('o details grava a própria amostra, separada da busca', async () => {
    mockCall.mockResolvedValueOnce({ suggestions: [PREDICAO] });
    const [sugestao] = await searchPlaces('orlando intl', 'tok-1');

    mockCall.mockResolvedValueOnce({ location: { latitude: 28.43, longitude: -81.31 } });
    await resolvePlace(sugestao, 'tok-1');

    const detalhes = recentSamples().filter((s) => s.name === 'place_details_round_trip');
    expect(detalhes).toHaveLength(1);
    expect(detalhes[0].context).toMatchObject({ resolved: true });
  });

  it('details que FALHA continua virando amostra — a espera existiu', async () => {
    // Descartar a falha enviesaria a série para baixo justamente onde ela dói:
    // o usuário esperou o timeout inteiro antes de não receber nada.
    mockCall.mockResolvedValueOnce({ suggestions: [PREDICAO] });
    const [sugestao] = await searchPlaces('orlando intl', 'tok-1');

    mockCall.mockRejectedValueOnce(new Error('timeout'));
    await resolvePlace(sugestao, 'tok-1');

    const detalhes = recentSamples().filter((s) => s.name === 'place_details_round_trip');
    expect(detalhes).toHaveLength(1);
    expect(detalhes[0].context).toMatchObject({ resolved: false, failed: true });
  });

  it('sugestão do Nominatim não grava details — não há sessão a fechar', async () => {
    const sugestao: PlaceSuggestion = {
      placeId: '',
      shortName: 'Orlando',
      address: 'Orlando, FL, USA',
      location: { lat: 28.5383, lng: -81.3792 },
    };

    await resolvePlace(sugestao, 'tok-1');

    expect(recentSamples()).toEqual([]);
  });
});

describe('faixa de cobrança do details (lida do servidor)', () => {
  it('a máscara de campos é só `location`', () => {
    // `location` é Essentials; `displayName` é Pro e subiria a sessão INTEIRA
    // de faixa. Nome e endereço já vieram na predição — pedir de novo aqui é
    // pagar mais caro pelo que o cliente já tem. Se alguém ampliar a máscara,
    // este teste cai antes da fatura.
    // Recorta a partir do details: o `textsearch` tem a máscara dele (Pro, de
    // propósito — é a busca ampla), e não é dela que este teste fala.
    const src = readFileSync(SERVIDOR, 'utf8');
    const detalhe = src.slice(src.indexOf("action === 'details'"));
    const m = /'X-Goog-FieldMask':\s*'([^']*)'/.exec(detalhe);
    expect(m).not.toBeNull();
    expect(m![1]).toBe('location');
  });

  it('o details manda o sessionToken — sem ele a sessão não fecha e tudo vira avulso', () => {
    const src = readFileSync(SERVIDOR, 'utf8');
    const detalhe = src.slice(src.indexOf("action === 'details'"));
    expect(detalhe).toMatch(/sessionToken=\$\{encodeURIComponent\(sessionToken\)\}/);
  });
});
