// Testa a ZONA DO MCO tal como a migração 0079 a grava — não uma cópia dela.
//
// O teste LÊ o arquivo da migração e extrai o `jsonb_build_object` de `v_zona`.
// Se alguém mudar o raio, a taxa ou o centro no SQL e não mexer aqui, estes
// testes mudam de resultado junto. Um teste que declarasse a zona de novo, em
// TypeScript, passaria para sempre e não provaria nada sobre o que vai para o
// banco — foi de propósito que ele não é escrito assim.
//
// O motor (haversine, pickup/dropoff, soma de zonas) já é coberto por
// airportFees.test.ts. Aqui a pergunta é outra: com ESTES números, quem paga a
// taxa e quem não paga?
import fs from 'fs';
import path from 'path';
import { computeAirportFees, haversineKm, type FeeZone } from '../airportFees';

jest.mock('../supabase', () => ({ supabase: { from: jest.fn() } }));

const MIGRACAO = path.join(
  __dirname, '..', '..', '..', 'supabase', 'migrations', '0079_mco_airport_fee.sql',
);

/** Extrai o jsonb_build_object de `v_zona` da migração e devolve uma FeeZone. */
function zonaDaMigracao(): FeeZone {
  const sql = fs.readFileSync(MIGRACAO, 'utf8');
  const bloco = sql.match(/v_zona\s*:=\s*jsonb_build_object\(([\s\S]*?)\n\s*\);/);
  if (!bloco) throw new Error('não achei o jsonb_build_object de v_zona na 0079');

  const zona: Record<string, unknown> = {};
  const par = /'([A-Za-z]+)'\s*,\s*(?:'([^']*)'|(-?[0-9]+(?:\.[0-9]+)?))/g;
  let m: RegExpExecArray | null;
  while ((m = par.exec(bloco[1])) !== null) {
    zona[m[1]] = m[2] !== undefined ? m[2] : Number(m[3]);
  }
  return zona as unknown as FeeZone;
}

const MCO = zonaDaMigracao();
const ZONAS = [MCO];

// Coordenadas reais. As do terminal são as que sustentam a escolha do raio;
// as de fora são endereços conhecidos de Orlando.
const TERMINAL_AB   = { lat: 28.4294, lng: -81.3089 }; // ponto de referência do aeroporto
const TERMINAL_C    = { lat: 28.4166, lng: -81.2993 }; // estimado (ver 0079)
const HYATT_NO_MCO  = { lat: 28.4300, lng: -81.3084 }; // hotel DENTRO do terminal
const MARRIOTT_FORA = { lat: 28.4415, lng: -81.3235 }; // 7499 Augusta National Dr
const FLORIDA_MALL  = { lat: 28.4460, lng: -81.3960 };
const DOWNTOWN      = { lat: 28.5383, lng: -81.3792 };
const LAKE_NONA     = { lat: 28.3730, lng: -81.2470 };
const DISNEY        = { lat: 28.3700, lng: -81.5190 };
const OAK_RIDGE     = { lat: 28.4640, lng: -81.4130 }; // destino da corrida real de 25/08

describe('0079 — a zona gravada é a que se pretende gravar', () => {
  it('cobra US$ 7,00 no embarque', () => {
    expect(MCO.pickupFee).toBe(7);
  });

  // Não é simetria esquecida: a GOAA cobra a TNC por embarque e a lei da
  // Flórida veda cobrar as duas pontas da mesma viagem.
  it('NÃO cobra no desembarque', () => {
    expect(MCO.dropoffFee).toBe(0);
  });

  it('é uma zona só, de raio 2,2 km', () => {
    expect(MCO.id).toBe('mco');
    expect(MCO.radiusKm).toBe(2.2);
  });
});

describe('a janela de raio em que 2,2 km foi escolhido', () => {
  // Se estes dois números se invertessem, não existiria raio correto e a zona
  // circular teria de virar polígono. O teste guarda essa premissa.
  it('os terminais ficam mais perto do centro do que o endereço externo mais próximo', () => {
    const centro = { lat: MCO.lat, lng: MCO.lng };
    const maisLongeDentro = Math.max(
      haversineKm(centro, TERMINAL_AB),
      haversineKm(centro, TERMINAL_C),
    );
    const maisPertoFora = haversineKm(centro, MARRIOTT_FORA);
    expect(maisLongeDentro).toBeLessThan(MCO.radiusKm);
    expect(maisPertoFora).toBeGreaterThan(MCO.radiusKm);
    expect(maisLongeDentro).toBeLessThan(maisPertoFora);
  });
});

describe('quem paga a taxa', () => {
  it('embarque no Terminal A/B → US$ 7', () => {
    const r = computeAirportFees(TERMINAL_AB, DOWNTOWN, ZONAS);
    expect(r.total).toBe(7);
    expect(r.lines).toEqual([
      { zoneId: 'mco', name: MCO.name, type: 'pickup', amount: 7 },
    ]);
  });

  it('embarque no Terminal C → US$ 7', () => {
    expect(computeAirportFees(TERMINAL_C, LAKE_NONA, ZONAS).total).toBe(7);
  });

  it('embarque no hotel DENTRO do terminal → US$ 7', () => {
    expect(computeAirportFees(HYATT_NO_MCO, DISNEY, ZONAS).total).toBe(7);
  });

  it('a corrida real de 25/08 (MCO → Oak Ridge) passaria a ter a taxa', () => {
    expect(computeAirportFees(TERMINAL_AB, OAK_RIDGE, ZONAS).total).toBe(7);
  });
});

describe('quem NÃO paga a taxa', () => {
  // O pedido era "corrida PARA o aeroporto". Este é o caso, e ele dá zero —
  // porque não há taxa de desembarque a repassar. Mudar isso é mudar
  // dropoffFee na 0079, e este teste é que vai acusar a mudança.
  it('cidade → MCO (desembarque) → US$ 0', () => {
    expect(computeAirportFees(DOWNTOWN, TERMINAL_AB, ZONAS).total).toBe(0);
    expect(computeAirportFees(FLORIDA_MALL, TERMINAL_C, ZONAS).total).toBe(0);
  });

  it('hotel vizinho ao aeroporto, fora da cerca → US$ 0', () => {
    expect(computeAirportFees(MARRIOTT_FORA, DOWNTOWN, ZONAS).total).toBe(0);
  });

  it.each([
    ['Florida Mall', FLORIDA_MALL],
    ['centro de Orlando', DOWNTOWN],
    ['Lake Nona', LAKE_NONA],
    ['Disney Springs', DISNEY],
    ['Oak Ridge', OAK_RIDGE],
  ])('corrida que nem toca o aeroporto: %s → US$ 0', (_nome, ponto) => {
    expect(computeAirportFees(ponto, DOWNTOWN, ZONAS).total).toBe(0);
  });
});

describe('a taxa não pode ser cobrada duas vezes', () => {
  it('MCO → MCO cobra US$ 7, não US$ 14', () => {
    const r = computeAirportFees(TERMINAL_AB, TERMINAL_C, ZONAS);
    expect(r.total).toBe(7);
    expect(r.lines).toHaveLength(1);
  });

  it('a 0079 grava uma única zona com id mco', () => {
    const sql = fs.readFileSync(MIGRACAO, 'utf8');
    expect(sql.match(/'id',\s*'mco'/g)).toHaveLength(1);
  });
});

describe('compatibilidade com o guard de dinheiro da 0065', () => {
  // A 0065 barra airport_port_fee > least(floor(price*60)/100, 120). A corrida
  // MCO mais barata possível é o piso da tarifa GoXL mais a taxa.
  it('os US$ 7 cabem no teto até na corrida MCO mais barata', () => {
    const PISO_GOXL = 13.09;                       // (8,90 + 3,00) × 1,10
    const price = PISO_GOXL + (MCO.pickupFee ?? 0);
    const teto = Math.min(Math.floor(price * 60) / 100, 120);
    expect(MCO.pickupFee).toBeLessThanOrEqual(teto);
    expect(MCO.pickupFee! + 0).toBeLessThanOrEqual(price); // toll + fee <= price
  });
});
