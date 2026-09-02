import { diagnoseMapsKey } from '../mapsDiagnostics';

/**
 * O que este teste PROVA e o que ele NÃO prova.
 *
 * PROVA: a leitura da config embutida classifica certo o caso "a chave não
 * entrou no build" — o único dos seis caminhos de mapa branco no Android que o
 * app enxerga de dentro (ver o cabeçalho de src/lib/mapsDiagnostics.ts).
 *
 * NÃO PROVA: que os aparelhos do dono estão nesse caso. Nenhum dos dois foi
 * acessado, nada foi reproduzido. `present` significa "a chave chegou ao build",
 * jamais "o mapa funciona": restrição de SHA-1 que não bate, API desabilitada no
 * Google Cloud e Play Services faltando produzem a MESMA tela branca com a
 * chave presente, e nada disso é observável daqui.
 */
describe('diagnoseMapsKey', () => {
  it('iOS e web não têm chave nativa de Android — nada a diagnosticar', () => {
    expect(diagnoseMapsKey('ios', undefined)).toBe('not_applicable');
    expect(diagnoseMapsKey('ios', 'AIzaSyTOTALMENTE-INVENTADA')).toBe('not_applicable');
    expect(diagnoseMapsKey('web', undefined)).toBe('not_applicable');
  });

  it('Android sem chave nenhuma no build: mapa branco garantido', () => {
    // É o que app.config.js:19-21 descreve: env não setada → campo undefined →
    // o app builda e sobe, e o mapa nativo não busca tile nenhum.
    expect(diagnoseMapsKey('android', undefined)).toBe('missing');
    expect(diagnoseMapsKey('android', null)).toBe('missing');
  });

  it('env definida como vazio conta como ausente', () => {
    // `EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY=` num .env produz string vazia, e o
    // resultado na tela é idêntico ao de não ter a variável.
    expect(diagnoseMapsKey('android', '')).toBe('missing');
    expect(diagnoseMapsKey('android', '   ')).toBe('missing');
  });

  it('valor não-string (config malformada) também é ausência', () => {
    expect(diagnoseMapsKey('android', 42)).toBe('missing');
    expect(diagnoseMapsKey('android', {})).toBe('missing');
  });

  it('chave presente é "present" — e isso NÃO quer dizer que o mapa carrega', () => {
    // Uma chave restrita ao SHA-1 do keystore de produção, num APK assinado com
    // outro keystore, chega aqui exatamente assim: presente e inútil.
    expect(diagnoseMapsKey('android', 'AIzaSyEXEMPLO-NAO-E-CHAVE-REAL')).toBe('present');
  });
});
