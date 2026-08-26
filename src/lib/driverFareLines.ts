// driverFareLines — o que aparece ABAIXO do valor da corrida no card de chamada
// do motorista (IncomingRideCall).
//
// ── O PROBLEMA QUE ISTO RESOLVE ─────────────────────────────────────────────
//
// O card mostra `ride.price` cru. Desde que a taxa de aeroporto passou a ser
// cobrada (zona `mco` em `airport_port_fees`), esse número inclui US$ 7,00 que
// NÃO são do motorista: a taxa é regulatória, a plataforma recolhe e repassa à
// autoridade do aeroporto, e a comissão do motorista incide só sobre
// `price - toll - venueFee`.
//
// Sem esta linha, o motorista lê "US$ 35,06", faz a conta de cabeça e espera um
// repasse que não vem. O buraco é de expectativa, não de dinheiro — o repasse
// dele sempre foi calculado certo.
//
// ── POR QUE NÃO MOSTRAR `driver_amount` AQUI ───────────────────────────────
//
// Seria a informação mais direta ("você recebe X"), e está errada duas vezes no
// momento da oferta:
//
//   · o motorista ainda não foi definido, então o valor é calculado com a fatia
//     PADRÃO — a fatia real só é aplicada no aceite (`applyDriverSplit`), e o
//     número mudaria na frente dele;
//   · contra uma base com a 0065 aplicada, `driver_amount` vem do cliente e é
//     ZERADO pelo trigger no insert. O card mostraria "você recebe US$ 0,00".
//
// A linha de dedução é verdadeira nos dois casos, hoje e depois da 0065.
//
// ── O SINAL DE MENOS É A MENSAGEM ──────────────────────────────────────────
//
// `− $7.00` sob `$35,06` diz, sem texto novo, que a taxa sai do valor antes da
// divisão: 35,06 − 7,00 = 28,06, que é exatamente a tarifa sobre a qual a
// comissão incide. A alternativa seria uma frase explicativa, e ela exigiria
// chave de tradução nova em três idiomas — a chave `requestRide.airportPortFee`
// já existe em en/es/pt e é a mesma que o passageiro vê no recibo.
import { formatCurrency } from './format';

export type DriverFareLine = {
  /** Chave i18n do rótulo — quem renderiza aplica `t()`. */
  labelKey: string;
  /** Já formatado, com o sinal. */
  value: string;
};

/**
 * Linhas de composição para o card do motorista. Devolve lista VAZIA quando não
 * há nada a explicar — é o caso da esmagadora maioria das corridas, e uma linha
 * "US$ 0,00" só faria ruído.
 *
 * Pedágio fica de fora de propósito: ele é repassado INTEIRO ao motorista, então
 * não há dedução a mostrar. Se algum dia o pedágio passar a ser dividido, é aqui
 * que a linha entra.
 */
export function driverFareLines(
  ride: { airport_port_fee?: number | string | null }
): DriverFareLine[] {
  const fee = Number(ride.airport_port_fee) || 0;
  // `|| 0` já cobre NaN/null/undefined; o `<= 0` também barra valor negativo,
  // que não deveria existir mas não vale exibir como "− $-3.00".
  if (fee <= 0) return [];

  return [{
    labelKey: 'requestRide.airportPortFee',
    value: `− ${formatCurrency(fee)}`,
  }];
}
