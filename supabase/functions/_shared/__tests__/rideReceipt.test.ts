// O recibo do E-MAIL e o recibo da TELA precisam dizer o mesmo número.
//
// São dois renderizadores diferentes por necessidade — o do app
// (`src/lib/waybill.ts`) importa `./systemConfig` e não carrega numa Edge
// Function; o do servidor (`_shared/rideReceipt.ts`) monta HTML de e-mail, que
// tem regras próprias. O HTML pode divergir à vontade. A MATEMÁTICA não pode.
//
// Se a tela disser que a tarifa-base foi US$ 38,53 e o e-mail disser US$ 41,53,
// o passageiro fica com dois documentos do mesmo serviço com números
// diferentes, e é sempre o segundo que vira reclamação. Este arquivo roda os
// DOIS sobre o MESMO insumo e compara linha a linha.

// `src/lib/waybill.ts` importa `./systemConfig`, que puxa o cliente Supabase e
// o AsyncStorage nativo. É EXATAMENTE por isso que a Edge Function não consegue
// carregá-lo e o `_shared/rideReceipt.ts` existe. Aqui cortamos essa fronteira
// para poder comparar os dois: `buildWaybill` é puro e não usa nada disso.
jest.mock('../../../../src/lib/systemConfig', () => ({
  getConfigValue: () => Promise.resolve(null),
}));

import { receiptFareLines, receiptHtml, receiptSubject } from '../rideReceipt';
import { buildWaybill } from '../../../../src/lib/waybill';

const EMPRESA = { legalName: 'Go XL', licenseNumber: 'MCO-123', supportEmail: 'support@goxl.app' };

/** Os casos que mudam a composição: com e sem pedágio, taxa e gorjeta. */
const CASOS = [
  { nome: 'só tarifa', price: 41.53, toll_amount: 0, airport_port_fee: 0, tip_amount: 0 },
  { nome: 'com gorjeta', price: 41.53, toll_amount: 0, airport_port_fee: 0, tip_amount: 20 },
  { nome: 'com taxa de aeroporto', price: 60.67, toll_amount: 0, airport_port_fee: 7, tip_amount: 15 },
  { nome: 'com pedágio', price: 55.10, toll_amount: 3.25, airport_port_fee: 0, tip_amount: 0 },
  { nome: 'tudo junto', price: 88.4, toll_amount: 3.25, airport_port_fee: 7, tip_amount: 12.5 },
  { nome: 'centavos que arredondam', price: 36.185, toll_amount: 1.005, airport_port_fee: 0, tip_amount: 0 },
];

function corrida(c: typeof CASOS[number]) {
  return {
    id: '4bfce647-a64d-40a4-91ad-35e6b7f30a72',
    price: c.price,
    toll_amount: c.toll_amount,
    airport_port_fee: c.airport_port_fee,
    tip_amount: c.tip_amount,
    distance_km: 25.4,
    duration_min: 32,
    origin_address: '6457 Winder Oaks Blvd, Orlando',
    destination_address: 'Orlando International Airport',
    completed_at: '2026-09-19T14:00:00Z',
    created_at: '2026-09-19T13:00:00Z',
  };
}

describe('a conta do e-mail é a mesma conta da tela', () => {
  it.each(CASOS.map((c) => [c.nome, c] as const))('%s', (_nome, c) => {
    const r = corrida(c);
    const doEmail = receiptFareLines(r);
    const daTela = buildWaybill(r, { legalName: EMPRESA.legalName, licenseNumber: EMPRESA.licenseNumber });

    // Mesma quantidade de linhas: zero não vira linha em nenhum dos dois.
    expect(doEmail.lines.length).toBe(daTela.fareLines.length);
    // Mesmos valores, na mesma ordem.
    expect(doEmail.lines.map((l) => l.amount)).toEqual(daTela.fareLines.map((l) => l.amount));
    // E o total, que é o número que o passageiro confere contra a fatura.
    expect(doEmail.total).toBe(daTela.total);
  });
});

describe('a composição em si', () => {
  it('a base desconta pedágio e taxa, porque o price já os inclui', () => {
    const { lines } = receiptFareLines({ id: 'x', price: 60.67, toll_amount: 3.25, airport_port_fee: 7 });
    expect(lines[0]).toEqual({ label: 'Base fare', amount: 50.42 });
  });

  it('a gorjeta SOMA ao total, porque é cobrança separada', () => {
    const { total } = receiptFareLines({ id: 'x', price: 41.53, tip_amount: 20 });
    expect(total).toBe(61.53);
  });

  it('não cria linha para valor zero', () => {
    const { lines } = receiptFareLines({ id: 'x', price: 41.53, toll_amount: 0, airport_port_fee: 0, tip_amount: 0 });
    expect(lines.map((l) => l.label)).toEqual(['Base fare']);
  });

  it('aguenta corrida sem nenhum valor gravado', () => {
    const { lines, total } = receiptFareLines({ id: 'x' });
    expect(total).toBe(0);
    expect(lines).toEqual([{ label: 'Base fare', amount: 0 }]);
  });
});

describe('o HTML do e-mail', () => {
  const html = receiptHtml(corrida(CASOS[2]), { passengerName: 'Steve Horn', driverName: 'Edson', vehicle: 'Suburban' }, EMPRESA);

  // Cliente de e-mail descarta <style> externo e trata flex/grid de forma
  // imprevisível — o layout tem que ser tabela com estilo em linha.
  it('não depende de folha de estilo externa nem de flex', () => {
    expect(html).not.toMatch(/<link[^>]+stylesheet/i);
    expect(html).not.toMatch(/display:\s*(flex|grid)/i);
    expect(html).toContain('<table');
  });

  // Recibo que depende de imagem carregar chega quebrado, atrás de
  // "exibir imagens?".
  it('não carrega imagem remota', () => {
    expect(html).not.toMatch(/<img/i);
  });

  it('mostra o total e trata o passageiro pelo primeiro nome', () => {
    // 60,67 + 15 de gorjeta. A taxa de aeroporto NAO soma: ela ja esta no price.
    expect(html).toContain('$75.67');
    expect(html).toContain('Hi Steve,');
  });

  it('escapa o que vem do banco — endereço é texto de terceiro', () => {
    const perigoso = receiptHtml(
      { ...corrida(CASOS[0]), destination_address: '<script>alert(1)</script>' },
      { passengerName: 'Ana' }, EMPRESA,
    );
    expect(perigoso).not.toContain('<script>alert(1)</script>');
    expect(perigoso).toContain('&lt;script&gt;');
  });

  it('o assunto leva o valor, que é o que se lê sem abrir', () => {
    expect(receiptSubject(corrida(CASOS[1]), EMPRESA)).toBe('Go XL — receipt for your ride ($61.53)');
  });
});
