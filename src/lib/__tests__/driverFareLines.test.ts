import { driverFareLines } from '../driverFareLines';
import { translations, LANGUAGES } from '../../i18n/translations';

describe('driverFareLines — quando a linha aparece', () => {
  it('taxa de aeroporto cobrada → uma linha, com sinal de menos', () => {
    expect(driverFareLines({ airport_port_fee: 7 })).toEqual([
      { labelKey: 'requestRide.airportPortFee', value: '− $7.00' },
    ]);
  });

  it('valor quebrado é formatado com dois decimais', () => {
    expect(driverFareLines({ airport_port_fee: 12.5 })[0].value).toBe('− $12.50');
  });

  it('o Supabase devolve numeric como string — e isso tem de funcionar', () => {
    expect(driverFareLines({ airport_port_fee: '7.00' })[0].value).toBe('− $7.00');
  });
});

describe('driverFareLines — quando NÃO aparece', () => {
  // A esmagadora maioria das corridas não toca aeroporto. Uma linha "$0.00"
  // seria ruído em todas elas.
  it.each([
    ['zero', 0],
    ['ausente', undefined],
    ['nulo', null],
    ['lixo não numérico', 'abc'],
    ['negativo (não deveria existir, mas não se exibe "− $-3.00")', -3],
  ])('%s → lista vazia', (_caso, valor) => {
    expect(driverFareLines({ airport_port_fee: valor as never })).toEqual([]);
  });
});

describe('o rótulo existe de verdade', () => {
  // Sem isto, renomear a chave no translations.ts faria o motorista ver
  // "requestRide.airportPortFee" escrito na tela — o `t()` cai na própria
  // chave quando não acha tradução, e nenhum teste de render pegaria isso.
  const chave = driverFareLines({ airport_port_fee: 7 })[0].labelKey;

  it.each(LANGUAGES.map((l) => l.code))('traduzido em %s', (lang) => {
    const texto = translations[lang][chave];
    expect(typeof texto).toBe('string');
    expect(texto).not.toBe('');
    expect(texto).not.toBe(chave);
  });
});
