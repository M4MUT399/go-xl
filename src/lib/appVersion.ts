// appVersion — de onde o app sabe a própria versão.
//
// Fica separado de `minAppVersion.ts` (puro, testável) e de `supabase.ts`
// (importado por quase tudo) porque é a única parte IMPURA da trava: ela lê o
// manifesto embarcado. Isolando aqui, o teste da comparação de versões não
// precisa carregar módulo nativo nenhum.
//
// ── POR QUE `Constants.expoConfig.version` E NÃO `expo-application` ────────
//
// `expo-application.nativeApplicationVersion` leria a versão do PACOTE
// instalado, que é a fonte mais confiável — mas é um módulo nativo a mais no
// binário, e este valor já basta: `expoConfig.version` é gravado no bundle a
// partir de `app.config.js` no momento da build, que é exatamente o campo que
// a gente incrementa a cada release.
//
// ── A ARMADILHA QUE NÃO SE APLICA AQUI ────────────────────────────────────
//
// `@expo/config/build/Config.js:254` faz `delete configWithDefaultValues.exp
// .android.config` quando serializa a config pública. É por isso que
// `Constants.expoConfig.android.config` é SEMPRE undefined num app instalado —
// e foi o que fez um detector de chave do Maps virar alarme falso em campo, em
// 01/09/2026. O corte é cirúrgico: some `android.config` e `ios.config`, não a
// raiz. `version` sobrevive.
//
// Ainda assim, quem chama trata `null` como "não sei": ver a nota sobre falhar
// para o lado aberto em minAppVersion.ts.

import Constants from 'expo-constants';

/**
 * A versão desta build, ou `null` se o manifesto não trouxer nada legível.
 *
 * `null` NÃO é sinônimo de versão velha — é ausência de informação, e quem
 * decide o que fazer com isso é `precisaAtualizar`, que não bloqueia.
 */
export function versaoDoApp(): string | null {
  try {
    const v = Constants.expoConfig?.version;
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  } catch {
    return null;
  }
}

/**
 * O cabeçalho que todo request carrega para o servidor saber com quem está
 * falando (ver src/lib/supabase.ts e a migration 0081).
 *
 * O nome importa: o trigger no Postgres lê exatamente esta chave em
 * `current_setting('request.headers')`. Mudar aqui sem mudar lá desarma a
 * trava do servidor sem nenhum erro visível — por isso o valor é uma
 * constante exportada e testada, não uma string solta.
 */
export const CABECALHO_VERSAO = 'x-goxl-version';

/**
 * Cliente que não sabe a própria versão NÃO manda o cabeçalho. Isso é
 * deliberado: para o servidor, ausência e versão velha caem no mesmo balde
 * (ambos são "não posso confiar na tarifa que esse cliente calculou"), e mandar
 * uma string vazia só criaria um terceiro caso para o SQL tratar.
 */
export function cabecalhosDeVersao(): Record<string, string> {
  const v = versaoDoApp();
  return v ? { [CABECALHO_VERSAO]: v } : {};
}
