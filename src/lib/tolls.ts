// tolls — estimativa de pedágio no preço da corrida (P5).
//
// Regras do projeto:
//   • Nada de valor fixo "chumbado": o pedágio é CONFIGURÁVEL por jurisdição
//     (system_config) e vem DESLIGADO por padrão. Com a flag desligada o valor
//     é sempre 0 → o preço da corrida não muda em relação ao comportamento atual.
//   • Provider abstrato: hoje temos um MockTollProvider determinístico (para
//     testes/rollout controlado) e um stub do GoogleTollProvider, que será a
//     integração real (Routes API com toll info). Trocar de provider é uma
//     mudança de configuração, não de código.
import { getConfig, getConfigValue } from './systemConfig';
import { callEdgeFunction } from './edgeFunction';
import { reportError } from './errorReporting';

/**
 * A forma de chamar a Edge Function, injetável para o teste não precisar de
 * rede nem de sessão. O provider recebe isto em vez de importar direto.
 */
export type PublicCaller = <T>(name: string, body: Record<string, unknown>) => Promise<T>;

export type LatLng = { lat: number; lng: number };

export type TollQuery = {
  origin: LatLng;
  destination: LatLng;
  /** Distância da rota em km — usada pelos providers baseados em distância. */
  distanceKm: number;
};

/** Origem da estimativa. 'none' = pedágio desligado ou sem cobrança aplicável. */
export type TollSource = 'none' | 'mock' | 'google';

export type TollQuote = {
  /** Valor do pedágio em USD, sempre >= 0 e arredondado a centavos. */
  amount: number;
  source: TollSource;
};

export type MockTollParams = {
  /** Taxa fixa (USD) somada quando há cobrança. */
  flat: number;
  /** Taxa por km (USD). */
  perKm: number;
};

const ZERO: TollQuote = { amount: 0, source: 'none' };

/** Arredonda para centavos e nunca deixa o valor ficar negativo. */
function toMoney(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100) / 100;
}

export interface TollProvider {
  readonly source: TollSource;
  quote(query: TollQuery): Promise<TollQuote>;
}

/**
 * MockTollProvider — cálculo determinístico `flat + perKm * distanceKm`.
 * Serve para testes e para um rollout controlado antes da integração real:
 * o admin ajusta flat/perKm por jurisdição sem tocar no app.
 */
export class MockTollProvider implements TollProvider {
  readonly source = 'mock' as const;
  constructor(private readonly params: MockTollParams) {}

  async quote(query: TollQuery): Promise<TollQuote> {
    const raw = this.params.flat + this.params.perKm * Math.max(0, query.distanceKm);
    const amount = toMoney(raw);
    return amount > 0 ? { amount, source: 'mock' } : ZERO;
  }
}

/**
 * Chave de cache: coordenadas arredondadas a ~11 m (4 casas decimais).
 *
 * Duas consultas do mesmo trecho não precisam virar duas chamadas pagas, e o
 * GPS oscila alguns metros parado. Arredondar demais juntaria ruas vizinhas com
 * pedágios diferentes; 4 casas é fino o bastante para não fazer isso.
 */
function chaveDeCache(q: TollQuery, passes: string[]): string {
  const r = (n: number) => n.toFixed(4);
  return `${r(q.origin.lat)},${r(q.origin.lng)}>${r(q.destination.lat)},${r(q.destination.lng)}|${passes.join('+')}`;
}

const CACHE_TTL_MS = 5 * 60_000;
const cacheGoogle = new Map<string, { quote: TollQuote; em: number }>();

/** Limpa o cache de pedágio. Existe para os testes e para o admin. */
export function limparCacheDePedagio(): void {
  cacheGoogle.clear();
}

/**
 * GoogleTollProvider — pedágio real, pela Routes API.
 *
 * A chamada não sai daqui direto: vai pela Edge Function `toll-quote`, que
 * guarda a chave. Uma chamada REST feita pelo app não pode ser restringida por
 * aplicativo no Google Cloud, então a chave teria de ser irrestrita e sairia
 * extraível do binário — o mesmo motivo que criou a `places-search`.
 *
 * ── POR QUE HÁ CACHE AQUI DENTRO ───────────────────────────────────────────
 *
 * `estimateTollAmount` é chamado em três lugares, e um deles é um `useEffect`
 * da tela de pedido que dispara A CADA mudança de destino. Pedir `tollInfo` à
 * Google custa US$ 0,015 por chamada. Sem cache, um passageiro indeciso vira
 * conta — e o mesmo trecho seria consultado de novo no instante do pedido.
 *
 * ── FALHA É SEMPRE ZERO, NUNCA EXCEÇÃO ─────────────────────────────────────
 *
 * `estimateTollAmount` já engole exceções, mas contar com isso deixaria o erro
 * invisível. Aqui a falha é explícita: devolve 0 e registra. Cobrar pedágio
 * errado é pior que não cobrar — o valor vai INTEIRO para o motorista, então
 * um erro para cima sai do bolso do passageiro e vira reclamação.
 */
export class GoogleTollProvider implements TollProvider {
  readonly source = 'google' as const;

  constructor(
    private readonly chamar: PublicCaller,
    private readonly tollPasses: string[] = [],
  ) {}

  async quote(query: TollQuery): Promise<TollQuote> {
    const chave = chaveDeCache(query, this.tollPasses);
    const hit = cacheGoogle.get(chave);
    if (hit && Date.now() - hit.em < CACHE_TTL_MS) return hit.quote;

    try {
      const r = await this.chamar<{ amount?: number }>('toll-quote', {
        origin: query.origin,
        dest: query.destination,
        ...(this.tollPasses.length ? { tollPasses: this.tollPasses } : {}),
      });
      const amount = toMoney(Number(r?.amount));
      const quote: TollQuote = amount > 0 ? { amount, source: 'google' } : ZERO;
      cacheGoogle.set(chave, { quote, em: Date.now() });
      return quote;
    } catch (e) {
      // Não cacheia falha: a próxima corrida merece uma tentativa nova.
      reportError(e, { op: 'GoogleTollProvider.quote' });
      return ZERO;
    }
  }
}

/** Cria o provider a partir do nome configurado. Default: mock. */
export function makeTollProvider(
  provider: string,
  mock: MockTollParams,
  google: { chamar: PublicCaller; tollPasses: string[] } = {
    chamar: callEdgeFunction,
    tollPasses: [],
  },
): TollProvider {
  switch (provider) {
    case 'google':
      return new GoogleTollProvider(google.chamar, google.tollPasses);
    case 'mock':
    default:
      return new MockTollProvider(mock);
  }
}

/**
 * estimateTollAmount — ponto de entrada usado pelo fluxo de preço.
 * Resolve a configuração por jurisdição e devolve o valor do pedágio.
 *
 * Garantias de segurança (não quebrar o fluxo de corrida):
 *   • flag `tolls_enabled` desligada → { amount: 0, source: 'none' }.
 *   • qualquer erro (provider, config, rede) → cai para 0, nunca lança.
 */
export async function estimateTollAmount(
  query: TollQuery,
  jurisdiction: string = 'global'
): Promise<TollQuote> {
  try {
    const enabled = await getConfig('tolls_enabled', jurisdiction);
    if (!enabled) return ZERO;

    const [provider, flat, perKm, passes] = await Promise.all([
      getConfig('toll_provider', jurisdiction),
      getConfig('mock_toll_flat', jurisdiction),
      getConfig('mock_toll_per_km', jurisdiction),
      // Passes de pedágio (ex.: ['US_FL_SUNPASS']). Vazio = a Google devolve o
      // preço em DINHEIRO, que é o teto: quem tem SunPass paga menos. Deixar
      // vazio superestima a favor do motorista, que recebe o repasse; encher
      // com o passe errado subestima e ele come a diferença. Fica em config
      // para o ajuste não exigir build.
      getConfigValue<string[]>('toll_passes', [], jurisdiction),
    ]);

    const p = makeTollProvider(
      String(provider),
      { flat: Number(flat), perKm: Number(perKm) },
      { chamar: callEdgeFunction, tollPasses: Array.isArray(passes) ? passes : [] },
    );
    const quote = await p.quote(query);
    return { amount: toMoney(quote.amount), source: quote.source };
  } catch {
    return ZERO;
  }
}
