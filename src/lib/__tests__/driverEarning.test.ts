// O que o motorista RECEBE por uma corrida concluída.
//
// O defeito que originou isto: a lista de ganhos mostrava `ride.price` — a
// tarifa do PASSAGEIRO — como se fosse o ganho do motorista, enquanto o card
// logo acima, na mesma tela, mostrava o valor líquido. Na corrida de 08/10/2026
// do Fabricio eram US$ 62,73 contra US$ 48,06. E a gorjeta de US$ 15 daquela
// corrida não aparecia em lugar nenhum.
//
// Os casos abaixo usam os números REAIS dessas corridas de propósito: um teste
// com valores redondos não teria pego o arredondamento de centavo.

import { driverEarning, totalDriverEarnings } from '../driverEarning';

/** Corrida de 08/10/2026, Fabricio × Steve Horn. */
const OITO_OUT = { price: 62.73, driver_amount: 48.06, tip_amount: 15, paid: true };
/** Corrida de 04/10/2026, sem gorjeta. */
const QUATRO_OUT = { price: 26.01, driver_amount: 22.11, tip_amount: null, paid: true };

describe('o ganho é o do motorista, não a tarifa do passageiro', () => {
  it('usa driver_amount, nunca price', () => {
    const g = driverEarning(OITO_OUT);
    expect(g.fare).toBe(48.06);
    expect(g.fare).not.toBe(62.73);
  });

  it('a gorjeta soma por fora do split e aparece separada', () => {
    const g = driverEarning(OITO_OUT);
    expect(g.tip).toBe(15);
    expect(g.total).toBe(63.06);
  });

  it('sem gorjeta, o total é só a fatia da tarifa', () => {
    const g = driverEarning(QUATRO_OUT);
    expect(g.tip).toBe(0);
    expect(g.total).toBe(22.11);
  });

  it('não marca como estimado quando o valor veio do servidor', () => {
    expect(driverEarning(OITO_OUT).estimated).toBe(false);
  });
});

describe('estorno não é ganho', () => {
  // refund-ride grava paid = false e NÃO zera driver_amount; toda via de
  // repasse exige paid = true.
  it('corrida estornada é marcada como não recebida', () => {
    expect(driverEarning({ ...OITO_OUT, paid: false }).collected).toBe(false);
  });

  it('e fica FORA do total do período', () => {
    const t = totalDriverEarnings([OITO_OUT, { ...QUATRO_OUT, paid: false }]);
    expect(t.total).toBe(63.06);
  });

  it('paid ausente também não conta', () => {
    expect(driverEarning({ price: 50, driver_amount: 40 }).collected).toBe(false);
  });
});

describe('quando driver_amount falta, o número é um CHUTE e precisa se declarar', () => {
  // P1 nº 1 da AUDITORIA: a fatia padrão é 80%, então um motorista de 85% vê
  // MENOS do que recebe. Não dá para consertar a estimativa aqui — a fatia real
  // mora em profiles.driver_share_percent. Dá para parar de apresentá-la como
  // se fosse o valor.
  it('estima pela fatia padrão e marca a linha', () => {
    const g = driverEarning({ price: 100, driver_amount: null, tip_amount: 0, paid: true });
    expect(g.fare).toBe(80);
    expect(g.estimated).toBe(true);
  });

  it('a fatia usada na estimativa é injetável', () => {
    const g = driverEarning({ price: 100, driver_amount: null, paid: true }, 0.85);
    expect(g.fare).toBe(85);
  });

  it('o total do período conta quantas linhas são estimativa', () => {
    const t = totalDriverEarnings([OITO_OUT, { price: 100, driver_amount: null, paid: true }]);
    expect(t.estimatedCount).toBe(1);
  });

  // driver_amount = 0 é um VALOR, não ausência. Tratá-lo como ausência
  // substituiria um zero legítimo por 80% da tarifa.
  it('zero é valor, não ausência', () => {
    const g = driverEarning({ price: 100, driver_amount: 0, paid: true });
    expect(g.fare).toBe(0);
    expect(g.estimated).toBe(false);
  });
});

describe('soma do período', () => {
  it('separa tarifa de gorjeta', () => {
    const t = totalDriverEarnings([OITO_OUT, QUATRO_OUT]);
    expect(t.fare).toBe(70.17);
    expect(t.tips).toBe(15);
    expect(t.total).toBe(85.17);
  });

  it('lista vazia é zero, não NaN', () => {
    expect(totalDriverEarnings([])).toEqual({ fare: 0, tips: 0, total: 0, estimatedCount: 0 });
  });

  it('aguenta corrida sem valor nenhum gravado', () => {
    const t = totalDriverEarnings([{ paid: true }]);
    expect(t.total).toBe(0);
  });
});
