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

import { receiptFareLines, receiptHtml, receiptLang, receiptSubject, tipReceiptHtml, tipReceiptSubject } from '../rideReceipt';
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
  // "exibir imagens?". A logo só entra embutida (cid:/data:), nunca por URL.
  it('não carrega imagem remota', () => {
    expect(html).not.toMatch(/<img/i);
    const comLogo = receiptHtml(corrida(CASOS[0]), {}, { ...EMPRESA, logoSrc: 'cid:goxl-logo' });
    expect(comLogo).toContain('src="cid:goxl-logo"');
    expect(comLogo).not.toMatch(/<img[^>]+src="https?:/i);
  });

  it('sem logo, o cabeçalho cai para o nome da empresa', () => {
    expect(html).toContain('>Go XL</span>');
  });

  it('a data sai na hora de Orlando, não em UTC', () => {
    // 2026-09-19T14:00Z = 10:00 AM EDT
    expect(html).toContain('10:00 AM EDT');
    expect(html).not.toContain('UTC');
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

describe('o idioma do recibo é o que o passageiro escolheu no app', () => {
  const r = corrida(CASOS[4]); // tem pedágio, taxa e gorjeta: todas as linhas aparecem

  it('português', () => {
    const html = receiptHtml(r, { passengerName: 'Edson Luiz', driverName: 'Fabricio' }, EMPRESA, 'pt');
    expect(html).toContain('Recibo da sua corrida');
    expect(html).toContain('Olá Edson,');
    for (const rotulo of ['Origem', 'Destino', 'Motorista', 'Tarifa base', 'Pedágios', 'Gorjeta']) {
      expect(html).toContain(rotulo);
    }
    expect(html).not.toContain('Base fare');
    expect(receiptSubject(r, EMPRESA, 'pt')).toBe('Go XL — recibo da sua corrida ($100.90)');
  });

  it('espanhol', () => {
    const html = receiptHtml(r, { passengerName: 'Jesus Mora' }, EMPRESA, 'es');
    expect(html).toContain('Recibo de tu viaje');
    expect(html).toContain('Hola Jesus,');
    expect(html).toContain('Propina');
    expect(html).toContain('Peajes');
    expect(receiptSubject(r, EMPRESA, 'es')).toBe('Go XL — recibo de tu viaje ($100.90)');
  });

  it('o valor é o mesmo em qualquer idioma — só o texto muda', () => {
    const total = (h: string) => h.match(/\$\d+\.\d{2}(?=<\/td><\/tr>\s*<\/table>)/)?.[0];
    const en = receiptHtml(r, {}, EMPRESA, 'en');
    expect(total(receiptHtml(r, {}, EMPRESA, 'pt'))).toBe(total(en));
    expect(total(receiptHtml(r, {}, EMPRESA, 'es'))).toBe(total(en));
  });

  it('valor estranho ou ausente no banco cai para inglês', () => {
    expect(receiptLang('pt')).toBe('pt');
    expect(receiptLang('PT-BR')).toBe('pt');
    expect(receiptLang('es')).toBe('es');
    expect(receiptLang('fr')).toBe('en');
    expect(receiptLang(null)).toBe('en');
    expect(receiptLang(undefined)).toBe('en');
  });
});

describe('a data do recibo é a da VIAGEM, nunca a da reserva', () => {
  // Corrida agendada: reservada em 07/10, feita em 08/10. É o caso do Steve Horn.
  const agendada = {
    ...corrida(CASOS[0]),
    created_at: '2026-10-07T16:57:00Z',  // reserva
    boarded_at: '2026-10-08T17:09:00Z',  // embarque  → 1:09 PM EDT
    completed_at: '2026-10-08T17:49:00Z', // chegada  → 1:49 PM EDT
  };

  it('mostra embarque e chegada do dia da corrida', () => {
    const html = receiptHtml(agendada, {}, EMPRESA, 'en');
    expect(html).toContain('Pickup');
    expect(html).toContain('Thu, Oct 8, 2026, 1:09 PM EDT');
    expect(html).toContain('Drop-off');
    expect(html).toContain('Thu, Oct 8, 2026, 1:49 PM EDT');
    expect(html).not.toContain('Oct 7');
  });

  it('sem embarque nem chegada, NÃO cai para a data da reserva', () => {
    const html = receiptHtml({ ...agendada, boarded_at: null, completed_at: null }, {}, EMPRESA, 'en');
    expect(html).not.toContain('Oct 7');
    expect(html).not.toContain('Pickup');
  });
});

describe('o recibo da gorjeta', () => {
  const gorjeta = {
    rideId: '24c4247f-0000-0000-0000-000000000000',
    amount: 15,
    chargedAt: '2026-10-09T11:21:00Z',       // cobrada no dia seguinte
    rideCompletedAt: '2026-10-08T17:49:00Z',
    card: 'Visa •••• 4242',
  };

  it('traz o valor da gorjeta, a hora da cobrança e o dia da corrida', () => {
    const html = tipReceiptHtml(gorjeta, { passengerName: 'Steve Horn', driverName: 'Fabricio' }, EMPRESA, 'en');
    expect(html).toContain('Tip receipt');
    expect(html).toContain('Hi Steve,');
    expect(html).toContain('$15.00');
    expect(html).toContain('Fri, Oct 9, 2026, 7:21 AM EDT'); // cobrança
    expect(html).toContain('Thu, Oct 8, 2026, 1:49 PM EDT'); // corrida
    expect(html).toContain('Visa •••• 4242');
    expect(html).toContain('Fabricio');
  });

  it('sai no idioma do passageiro', () => {
    const html = tipReceiptHtml(gorjeta, { passengerName: 'Edson Luiz' }, EMPRESA, 'pt');
    expect(html).toContain('Recibo da gorjeta');
    expect(html).toContain('Olá Edson,');
    expect(html).toContain('Cobrada em');
    expect(tipReceiptSubject(gorjeta, EMPRESA, 'pt')).toBe('Go XL — recibo da gorjeta ($15.00)');
    expect(tipReceiptSubject(gorjeta, EMPRESA, 'es')).toBe('Go XL — recibo de propina ($15.00)');
  });
});

describe('recibo de 29/10/2026: dados do passageiro, espera e recibo único', () => {
  const { receiptHtml: html, receiptFareLines: linhas } = jest.requireActual('../rideReceipt');
  const empresa = { legalName: 'Go XL' };
  const corrida = {
    id: 'abcdef12-0000-0000-0000-000000000000', price: 40, toll_amount: 0, airport_port_fee: 0,
    completed_at: '2026-10-29T15:00:00Z', boarded_at: '2026-10-29T14:30:00Z',
  };

  it('traz nome completo e e-mail no bloco "Billed to"', () => {
    const h = html(corrida, { passengerName: 'Ryan Guerrina', passengerEmail: 'ryan@example.com' }, empresa, 'en');
    expect(h).toContain('Billed to');
    expect(h).toContain('Ryan Guerrina');
    expect(h).toContain('ryan@example.com');
  });

  it('sem dados do passageiro, o bloco não aparece', () => {
    expect(html(corrida, {}, empresa, 'pt')).not.toContain('Cobrado de');
  });

  it('a espera entra como linha e soma no total', () => {
    const r = linhas({ ...corrida, wait_fee_amount: 3 });
    expect(r.lines.map((l: { label: string }) => l.label)).toContain('Wait time');
    expect(r.total).toBe(43);
  });

  it('recibo único: gorjeta dentro do total e agradecimento pela gorjeta', () => {
    const h = html({ ...corrida, tip_amount: 8 }, { passengerName: 'Steve Horn' }, empresa, 'en');
    expect(h).toContain('$48.00');
    expect(h).toContain('and for the tip');
  });
});
