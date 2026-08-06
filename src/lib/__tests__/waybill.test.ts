import {
  buildWaybill,
  waybillToHtml,
  getWaybillConfig,
  type WaybillCompany,
  type WaybillRideInput,
} from '../waybill';
import * as systemConfig from '../systemConfig';

// Mocka o Supabase para não carregar módulos nativos ao importar systemConfig.
jest.mock('../supabase', () => ({ supabase: { from: jest.fn() } }));

const NOW = new Date('2026-07-01T20:00:00.000Z');
const COMPANY: WaybillCompany = {
  legalName: '2MT Motorsports LLC',
  licenseNumber: 'TNC-12345',
  footerNote: 'Este recibo não é fatura fiscal.',
};

const RIDE: WaybillRideInput = {
  id: 'ride-abc',
  price: 40, // já inclui tarifa + pedágio + taxa
  toll_amount: 5,
  airport_port_fee: 2.5,
  tip_amount: 8,
  distance_km: 12.34,
  duration_min: 25,
  origin_address: 'Downtown Orlando',
  destination_address: 'MCO Airport',
  created_at: '2026-07-01T18:00:00.000Z',
  driverName: 'Edson L.',
  vehicleLabel: 'Cadillac Escalade • ABC1234',
  passengerName: 'Maria S.',
};

describe('buildWaybill', () => {
  it('separa tarifa-base, pedágio, taxa e gorjeta; total = price + tip', () => {
    const w = buildWaybill(RIDE, COMPANY, {}, NOW);
    // base = price - toll - venue = 40 - 5 - 2.5 = 32.5
    expect(w.fareLines).toEqual([
      { label: 'Base fare', amount: 32.5 },
      { label: 'Tolls', amount: 5 },
      { label: 'Airport/Port fee', amount: 2.5 },
      { label: 'Tip', amount: 8 },
    ]);
    // total = price + tip = 48
    expect(w.total).toBe(48);
  });

  it('omite linhas de valor zero (sem pedágio/taxa/gorjeta)', () => {
    const w = buildWaybill({ id: 'r', price: 20 }, COMPANY, {}, NOW);
    expect(w.fareLines).toEqual([{ label: 'Base fare', amount: 20 }]);
    expect(w.total).toBe(20);
  });

  it('carrega dados da corrida e da empresa', () => {
    const w = buildWaybill(RIDE, COMPANY, {}, NOW);
    expect(w.company.legalName).toBe('2MT Motorsports LLC');
    expect(w.rideId).toBe('ride-abc');
    expect(w.origin).toBe('Downtown Orlando');
    expect(w.destination).toBe('MCO Airport');
    expect(w.distanceKm).toBe(12.34);
    expect(w.driverName).toBe('Edson L.');
    expect(w.currency).toBe('USD');
  });

  it('aceita labels customizados (i18n)', () => {
    const w = buildWaybill(RIDE, COMPANY, { baseFare: 'Tarifa base' }, NOW);
    expect(w.fareLines[0].label).toBe('Tarifa base');
  });

  it('campos ausentes viram null/0 sem quebrar', () => {
    const w = buildWaybill({ id: 'r' }, COMPANY, {}, NOW);
    expect(w.total).toBe(0);
    expect(w.distanceKm).toBeNull();
    expect(w.driverName).toBeNull();
  });
});

describe('waybillToHtml', () => {
  it('inclui empresa, licença, endereços e total formatado', () => {
    const html = waybillToHtml(buildWaybill(RIDE, COMPANY, {}, NOW));
    expect(html).toContain('2MT Motorsports LLC');
    expect(html).toContain('TNC-12345');
    expect(html).toContain('Downtown Orlando');
    expect(html).toContain('MCO Airport');
    expect(html).toContain('$48.00');
    expect(html).toContain('Este recibo não é fatura fiscal.');
  });

  it('escapa HTML de campos livres (anti-injeção)', () => {
    const evil = buildWaybill(
      { ...RIDE, origin_address: '<script>alert(1)</script>' },
      COMPANY, {}, NOW,
    );
    const html = waybillToHtml(evil);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('sem footerNote não renderiza o rodapé', () => {
    const html = waybillToHtml(buildWaybill(RIDE, { ...COMPANY, footerNote: '' }, {}, NOW));
    expect(html).not.toContain('class="footer"');
  });
});

describe('getWaybillConfig', () => {
  afterEach(() => jest.restoreAllMocks());

  it('desligado por padrão + empresa vazia (nada chumbado)', async () => {
    jest.spyOn(systemConfig, 'getConfigValue').mockImplementation((async (_k: string, fb: unknown) => fb) as never);
    const cfg = await getWaybillConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.company).toEqual({ legalName: '', licenseNumber: '', footerNote: '' });
  });

  it('lê os valores configurados', async () => {
    jest.spyOn(systemConfig, 'getConfigValue').mockImplementation((async (key: string) => {
      switch (key) {
        case 'waybill_enabled': return true;
        case 'company_legal_name': return '2MT Motorsports LLC';
        case 'company_license_number': return 'TNC-12345';
        case 'waybill_footer_note': return 'nota';
        default: return '';
      }
    }) as never);
    const cfg = await getWaybillConfig('US-FL');
    expect(cfg.enabled).toBe(true);
    expect(cfg.company.legalName).toBe('2MT Motorsports LLC');
  });

  it('erro na config → desligado e vazio (não lança)', async () => {
    jest.spyOn(systemConfig, 'getConfigValue').mockRejectedValue(new Error('x') as never);
    const cfg = await getWaybillConfig();
    expect(cfg.enabled).toBe(false);
  });
});
