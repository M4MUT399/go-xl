/**
 * Regras de gorjeta, num lugar só.
 *
 * ── POR QUE ESTE ARQUIVO EXISTE ─────────────────────────────────────────────
 *
 * Até aqui a gorjeta só podia ser dada num único ponto do app: a
 * `RateRideScreen`. E só existia UM caminho até ela — `ActiveRideScreen:343`,
 * que navega no instante em que o status vira `completed`, e só se aquela tela
 * estiver em foco:
 *
 *     if (!navigation.isFocused()) { stopped = true; return; }
 *     if (ride.status === 'completed') navigation.replace('RateRide', { ride });
 *
 * Se o passageiro não estava com o app aberto NAQUELA tela naquele segundo —
 * celular bloqueado, app em segundo plano, ele saiu para outro app ao descer do
 * carro — a tela nunca abre. E não havia volta: a `TripDetailsScreen` apenas
 * EXIBE a gorjeta quando ela existe, sem oferecer nenhuma. Perdeu o instante,
 * perdeu a gorjeta para sempre.
 *
 * Foi um caso real, relatado pela passageira: a corrida não debitou e "não
 * apareceu a opção de gorjeta". O dinheiro perdido aí não é da plataforma — a
 * gorjeta vai 100% para o motorista (migração 0064). Quem paga a conta do
 * defeito é o parceiro.
 *
 * ── O QUE O SERVIDOR JÁ ACEITA, SEM MUDAR NADA ─────────────────────────────
 *
 * Conferido em `supabase/functions/tip-ride/index.ts`: ela autoriza por
 * `passenger_id`, é idempotente (`tip_amount > 0` devolve `already_tipped`), e
 * **não impõe janela de tempo nem confere `status`**. Ou seja, a gorjeta
 * retroativa já funciona contra a função publicada — o que faltava era um botão.
 *
 * ── A JANELA É DO CLIENTE, E ISSO PRECISA ESTAR ESCRITO ────────────────────
 *
 * `TIP_WINDOW_DAYS` é aplicado AQUI, no app. O servidor não o conhece. Quem
 * chamar a `tip-ride` direto consegue gorjetar uma corrida de qualquer idade.
 * Isso não é um buraco de segurança — a função só aceita o PRÓPRIO passageiro
 * daquela corrida, e o valor tem teto —, é uma regra de produto que hoje mora
 * só de um lado. Para fechá-la dos dois, ver `SERVER_WINDOW_SNIPPET` no fim
 * deste arquivo.
 */

import { RideRecord } from '../types';

/** Valores sugeridos, em dólares. Mesma lista que a `RateRideScreen` usa. */
export const TIP_PRESETS = [5, 10, 15];

/** Mínimo aceito pela `tip-ride` (`index.ts:58`). Abaixo disso ela devolve 400. */
export const TIP_MIN_DOLLARS = 0.5;

/**
 * Espelha o DEFAULT de `MAX_TIP_CENTS` na `tip-ride` (20000 centavos = $200).
 * O servidor é a autoridade e o valor dele é configurável por variável de
 * ambiente, então este número é uma cortesia de UI — barrar antes de gastar uma
 * ida à rede —, nunca a garantia. Se divergirem, quem recusa é o servidor e a
 * tela mostra a mensagem dele.
 */
export const TIP_MAX_DOLLARS = 200;

/** Prazo para gorjetar depois da corrida concluída. Regra de produto. */
export const TIP_WINDOW_DAYS = 7;

const DIA_MS = 24 * 60 * 60 * 1000;

export type TipBlockedReason =
  | 'not_completed'   // corrida cancelada, agendada ou em andamento
  | 'already_tipped'  // já tem gorjeta registrada
  | 'window_closed';  // passou de TIP_WINDOW_DAYS

export type TipEligibility =
  | { canTip: true; deadlineMs: number }
  | { canTip: false; reason: TipBlockedReason };

/**
 * Esta corrida ainda aceita gorjeta?
 *
 * `nowMs` entra por parâmetro em vez de `Date.now()` por dentro: uma regra que
 * depende do relógio e o lê sozinha não tem como ser testada nas bordas, e a
 * borda é justamente o que importa aqui.
 *
 * Corrida NÃO PAGA continua elegível de propósito. A gorjeta é um
 * PaymentIntent separado da tarifa (0064) e vai inteira para o motorista;
 * recusá-la porque a tarifa falhou puniria o parceiro por um defeito da
 * plataforma. Foi exatamente o caso que originou este arquivo.
 */
export function tipEligibility(
  ride: Pick<RideRecord, 'status' | 'tip_amount' | 'completed_at' | 'created_at'>,
  nowMs: number,
): TipEligibility {
  if (ride.status !== 'completed') {
    return { canTip: false, reason: 'not_completed' };
  }

  if ((Number(ride.tip_amount) || 0) > 0) {
    return { canTip: false, reason: 'already_tipped' };
  }

  // `completed_at` é o marco certo; `created_at` é o reserva. Uma corrida
  // concluída sem `completed_at` existe (o UPDATE de status e o carimbo são o
  // mesmo statement, mas linhas antigas podem não ter) e recusar a gorjeta nela
  // seria transformar um dado faltando em dinheiro perdido pelo motorista.
  const marco = Date.parse(ride.completed_at ?? ride.created_at ?? '');
  if (!Number.isFinite(marco)) {
    return { canTip: false, reason: 'window_closed' };
  }

  const deadlineMs = marco + TIP_WINDOW_DAYS * DIA_MS;
  if (nowMs > deadlineMs) {
    return { canTip: false, reason: 'window_closed' };
  }

  return { canTip: true, deadlineMs };
}

/**
 * Converte o que o usuário digitou em dólares, ou `null` se não der para ler.
 * Aceita vírgula decimal — o app roda em pt-BR e es-419 além de en-US, e
 * `parseFloat('7,50')` devolve 7, cobrando menos do que a pessoa quis dar.
 */
export function parseTipInput(texto: string): number | null {
  const limpo = texto.trim().replace(',', '.');
  if (!limpo) return null;
  const n = Number.parseFloat(limpo);
  if (!Number.isFinite(n)) return null;
  return n;
}

/** O valor cabe no que a `tip-ride` aceita? */
export function isTipAmountValid(dolares: number): boolean {
  return Number.isFinite(dolares) && dolares >= TIP_MIN_DOLLARS && dolares <= TIP_MAX_DOLLARS;
}

/** Centavos inteiros, que é o que a `tip-ride` recebe. */
export function toTipCents(dolares: number): number {
  return Math.round(dolares * 100);
}

/*
 * ── PARA FECHAR A JANELA TAMBÉM NO SERVIDOR ─────────────────────────────────
 *
 * Cole isto na `tip-ride` logo depois da checagem de `already_tipped` (o
 * arquivo é seu; não o toquei):
 *
 *     const TIP_WINDOW_DAYS = 7;
 *     const marco = Date.parse(r.completed_at ?? r.created_at ?? '');
 *     if (!Number.isFinite(marco) ||
 *         Date.now() - marco > TIP_WINDOW_DAYS * 86400000) {
 *       return json({ error: 'Prazo para gorjeta encerrado.' }, 400);
 *     }
 *
 * Exige acrescentar `completed_at, created_at` ao `.select(...)` da linha 77.
 * Enquanto isso não for feito, o prazo vale só no app — e está escrito aqui
 * para que ninguém leia `TIP_WINDOW_DAYS` e conclua que o servidor o impõe.
 */
