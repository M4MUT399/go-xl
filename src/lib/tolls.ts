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
import { getConfig } from './systemConfig';

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
 * GoogleTollProvider — stub. A integração real usará a Routes API com
 * `routeModifiers`/`extraComputations: TOLLS` para obter o `tollInfo` por trecho.
 * Enquanto não implementado, lança para deixar claro que não deve ser selecionado
 * em produção sem o trabalho de integração.
 */
export class GoogleTollProvider implements TollProvider {
  readonly source = 'google' as const;
  async quote(_query: TollQuery): Promise<TollQuote> {
    throw new Error('GoogleTollProvider ainda não implementado');
  }
}

/** Cria o provider a partir do nome configurado. Default: mock. */
export function makeTollProvider(provider: string, mock: MockTollParams): TollProvider {
  switch (provider) {
    case 'google':
      return new GoogleTollProvider();
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

    const [provider, flat, perKm] = await Promise.all([
      getConfig('toll_provider', jurisdiction),
      getConfig('mock_toll_flat', jurisdiction),
      getConfig('mock_toll_per_km', jurisdiction),
    ]);

    const p = makeTollProvider(String(provider), { flat: Number(flat), perKm: Number(perKm) });
    const quote = await p.quote(query);
    return { amount: toMoney(quote.amount), source: quote.source };
  } catch {
    return ZERO;
  }
}
