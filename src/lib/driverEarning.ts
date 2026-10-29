/**
 * Quanto o motorista RECEBEU por uma corrida concluída.
 *
 * ── POR QUE ESTE ARQUIVO EXISTE ─────────────────────────────────────────────
 *
 * A `EarningsScreen` tinha a mesma conta escrita em três lugares (o card de
 * totais, as barras dos últimos 7 dias e, implicitamente, o gráfico) — e a
 * LISTA de corridas não usava nenhuma delas. Ela mostrava `ride.price`.
 *
 * `price` é a tarifa que o PASSAGEIRO paga. Não é o ganho do motorista, e a
 * diferença é grande: na corrida de 08/10/2026 do Fabricio, `price` = US$ 62,73
 * e `driver_amount` = US$ 48,06. A tela se contradizia sozinha — o card de cima
 * dizia "Avg net/ride $48.06" e a linha logo abaixo dizia "+ $62.73" pela mesma
 * corrida. O motorista lia o número maior, que é o que ele NÃO recebe.
 *
 * ── A GORJETA ENTRA, E FORA DO SPLIT ───────────────────────────────────────
 *
 * Ela vai INTEIRA ao motorista (migração 0064), então soma ao ganho sem passar
 * pela comissão. Somá-la dentro do split faria a plataforma aparecer
 * descontando uma comissão que não existe.
 *
 * Até 09/10/2026 a gorjeta simplesmente não aparecia na lista: o motorista via
 * a corrida sem saber que tinha recebido US$ 15 a mais, nem de quem.
 *
 * ── ESTORNO NÃO É GANHO ────────────────────────────────────────────────────
 *
 * `refund-ride` grava `paid = false` e NÃO zera `driver_amount`, e toda via de
 * repasse exige `paid = true`. Sem olhar `paid`, uma corrida estornada seguiria
 * somando — dinheiro na tela que nunca chega na conta. `collected` carrega
 * isso; quem renderiza decide se soma ou se marca a linha.
 *
 * ── `estimated`: O NÚMERO PODE SER UM CHUTE, E ISSO TEM QUE APARECER ───────
 *
 * Quando `driver_amount` é nulo, a única saída é estimar pela fatia PADRÃO
 * (80%). Para um motorista de 85% isso mostra MENOS do que ele recebe, e para
 * um de 75%, mais. É o item P1 nº 1 da AUDITORIA, aberto desde agosto: "qualquer
 * linha com driver_amount NULL renderiza os ganhos de um motorista 85/15 a 80%".
 *
 * Não dá para consertar a estimativa aqui — a fatia real mora em
 * `profiles.driver_share_percent` e o repasse a aplica no servidor. O que dá
 * para fazer é PARAR DE APRESENTAR O CHUTE COMO SE FOSSE O VALOR. `estimated`
 * existe para a tela poder dizer isso.
 */
import { DEFAULT_DRIVER_SHARE } from './split';

export interface EarningRideInput {
  price?: number | null;
  driver_amount?: number | null;
  tip_amount?: number | null;
  paid?: boolean | null;
}

export interface DriverEarning {
  /** Parte do motorista na tarifa, já sem a comissão. */
  fare: number;
  /** Gorjeta — inteira dele, fora do split. */
  tip: number;
  /** `fare + tip`: o que ele de fato recebe pela corrida. */
  total: number;
  /** A tarifa foi retida no cartão? `false` = nunca capturada ou estornada. */
  collected: boolean;
  /** `driver_amount` estava ausente; `fare` é estimativa pela fatia padrão. */
  estimated: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);

export function driverEarning(
  ride: EarningRideInput,
  defaultShare: number = DEFAULT_DRIVER_SHARE,
): DriverEarning {
  const temValor = ride.driver_amount != null && Number.isFinite(Number(ride.driver_amount));
  const fare = temValor ? round2(num(ride.driver_amount)) : round2(num(ride.price) * defaultShare);
  const tip = round2(num(ride.tip_amount));

  return {
    fare,
    tip,
    total: round2(fare + tip),
    collected: ride.paid === true,
    estimated: !temValor,
  };
}

/** Soma de um período. Só entra o que o cartão REALMENTE reteve. */
export function totalDriverEarnings(
  rides: readonly EarningRideInput[],
  defaultShare: number = DEFAULT_DRIVER_SHARE,
): { fare: number; tips: number; total: number; estimatedCount: number } {
  let fare = 0, tips = 0, estimatedCount = 0;
  for (const r of rides) {
    const g = driverEarning(r, defaultShare);
    if (!g.collected) continue;
    fare += g.fare;
    tips += g.tip;
    if (g.estimated) estimatedCount += 1;
  }
  return { fare: round2(fare), tips: round2(tips), total: round2(fare + tips), estimatedCount };
}
