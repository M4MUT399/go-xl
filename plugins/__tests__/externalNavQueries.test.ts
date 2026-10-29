const { addExternalNavQueries } = require('../externalNavQueries');

/**
 * O <queries> DO ANDROIDMANIFEST.
 *
 * O plugin roda só no `expo prebuild`, dentro do EAS Build — ninguém vê o
 * resultado até uma build sair errada. O que dá para provar aqui, sem Expo e
 * sem Gradle, é a única coisa que o plugin faz: a forma exata do XML e o fato
 * de ele MESCLAR no bloco que o Expo já escreve, em vez de substituí-lo.
 *
 * Os objetos abaixo estão no formato do xml2js (o mesmo que os mods do Expo
 * entregam), escritos à mão.
 */

// `google.navigation`, não `comgooglemaps`: o segundo é o esquema do Google
// Maps de iOS e declará-lo aqui não torna app nenhum visível ao canOpenURL.
const INTENT_GMAPS = {
  action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
  data: [{ $: { 'android:scheme': 'google.navigation' } }],
};
const INTENT_WAZE = {
  action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
  data: [{ $: { 'android:scheme': 'waze' } }],
};

describe('addExternalNavQueries', () => {
  it('cria o bloco <queries> com um intent VIEW por esquema', () => {
    const manifesto: any = { manifest: { application: [{}] } };
    addExternalNavQueries(manifesto);
    expect(manifesto.manifest.queries).toEqual([{ intent: [INTENT_GMAPS, INTENT_WAZE] }]);
  });

  it('preserva o que o Expo já tinha posto em <queries>', () => {
    const intentAlheio = {
      action: [{ $: { 'android:name': 'android.intent.action.VIEW' } }],
      data: [{ $: { 'android:scheme': 'https' } }],
    };
    const manifesto: any = { manifest: { queries: [{ intent: [intentAlheio] }] } };
    addExternalNavQueries(manifesto);
    expect(manifesto.manifest.queries[0].intent).toEqual([intentAlheio, INTENT_GMAPS, INTENT_WAZE]);
  });

  it('é idempotente — prebuild rodado duas vezes não duplica esquema', () => {
    const manifesto: any = { manifest: {} };
    addExternalNavQueries(manifesto);
    addExternalNavQueries(manifesto);
    expect(manifesto.manifest.queries[0].intent).toEqual([INTENT_GMAPS, INTENT_WAZE]);
  });

  it('bloco <queries> vazio (sem intent) é aproveitado, não descartado', () => {
    const manifesto: any = { manifest: { queries: [{}] } };
    addExternalNavQueries(manifesto);
    expect(manifesto.manifest.queries).toHaveLength(1);
    expect(manifesto.manifest.queries[0].intent).toEqual([INTENT_GMAPS, INTENT_WAZE]);
  });

  it('manifesto irreconhecível volta intacto em vez de explodir a build', () => {
    expect(addExternalNavQueries(null)).toBeNull();
    expect(addExternalNavQueries({} as any)).toEqual({});
  });

  it('NÃO declara o esquema de iOS — peso morto no manifesto esconde o defeito', () => {
    const manifesto: any = { manifest: {} };
    addExternalNavQueries(manifesto);
    const esquemas = manifesto.manifest.queries[0].intent.flatMap((i: any) =>
      i.data.map((d: any) => d.$['android:scheme']),
    );
    expect(esquemas).toEqual(['google.navigation', 'waze']);
    expect(esquemas).not.toContain('comgooglemaps');
  });
});
