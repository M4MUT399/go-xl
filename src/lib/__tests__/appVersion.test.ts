/**
 * O cabeçalho `x-goxl-version` é o ÚNICO canal por onde o servidor descobre com
 * que build está falando. Se ele parar de sair, o trigger da migration 0081
 * passa a ver todo mundo como "sem versão" — e, com a trava ligada, derruba o
 * app inteiro. Um erro aqui não aparece como exceção: aparece como app morto em
 * campo.
 */

const mockConstants: { expoConfig: { version?: unknown } | null } = { expoConfig: { version: '1.0.10' } };
jest.mock('expo-constants', () => ({
  __esModule: true,
  get default() { return mockConstants; },
}));

import { CABECALHO_VERSAO, cabecalhosDeVersao, versaoDoApp } from '../appVersion';

describe('versaoDoApp', () => {
  it('lê a versão do manifesto', () => {
    mockConstants.expoConfig = { version: '1.0.10' };
    expect(versaoDoApp()).toBe('1.0.10');
  });

  it('apara espaços', () => {
    mockConstants.expoConfig = { version: '  1.0.10  ' };
    expect(versaoDoApp()).toBe('1.0.10');
  });

  // `null` significa "não sei", não "versão velha". Quem decide o que fazer com
  // isso é precisaAtualizar, que NÃO bloqueia.
  it.each([
    ['manifesto sem version', { version: undefined }],
    ['version vazia', { version: '   ' }],
    ['version não-string', { version: 42 }],
  ])('devolve null com %s', (_nome, cfg) => {
    mockConstants.expoConfig = cfg as { version?: unknown };
    expect(versaoDoApp()).toBeNull();
  });

  it('devolve null sem expoConfig nenhum', () => {
    mockConstants.expoConfig = null;
    expect(versaoDoApp()).toBeNull();
  });
});

describe('cabecalhosDeVersao', () => {
  // O nome é contrato com o SQL: a 0081 lê exatamente esta chave em
  // current_setting('request.headers'). Mudar aqui sem mudar lá desarma a trava
  // do servidor SEM nenhum erro visível.
  it('o nome do cabeçalho é o que a migration 0081 lê', () => {
    expect(CABECALHO_VERSAO).toBe('x-goxl-version');
  });

  it('carimba a versão quando ela é conhecida', () => {
    mockConstants.expoConfig = { version: '1.0.10' };
    expect(cabecalhosDeVersao()).toEqual({ 'x-goxl-version': '1.0.10' });
  });

  // Sem versão, NENHUM cabeçalho — nem string vazia. Para o servidor, ausência
  // e versão velha caem no mesmo balde; mandar '' criaria um terceiro caso.
  it('não manda cabeçalho quando a versão é desconhecida', () => {
    mockConstants.expoConfig = null;
    expect(cabecalhosDeVersao()).toEqual({});
  });
});
