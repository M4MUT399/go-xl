// minAppVersion — a TRAVA DE VERSÃO MÍNIMA.
//
// ── O QUE ACONTECEU ────────────────────────────────────────────────────────
//
// Em 02/09/2026 um aparelho de teste ativo em campo estava rodando a 1.0.0 —
// build anterior a 11/08, de antes de as chaves do Google Maps serem separadas
// (246de87). O mapa dele aparecia em branco porque a chave compartilhada que
// aquele binário carrega não autoriza mais nada. Nada no app, no banco ou nas
// Edge Functions o impedia de continuar rodando.
//
// O mapa em branco foi só o sintoma visível. O caro é outro:
// `charge-ride/index.ts:466` cobra `rides.price` COMO O CLIENTE GRAVOU — o
// servidor não recalcula a tarifa, só a lê. Um passageiro em build velha cria a
// corrida com a tabela velha (sem os +$0,25/milha, sem os $7 do MCO) e o
// servidor cobra esse valor sem reclamar. Silenciosamente, e para sempre.
//
// ── AS DUAS METADES, E POR QUE UMA SÓ NÃO SERVE ────────────────────────────
//
// CLIENTE (este arquivo + UpdateRequiredScreen): mostra a tela de "atualize" e
// não deixa usar o app. É gentil e explica o que fazer — mas é INÚTIL contra o
// aparelho que já está velho hoje: a 1.0.0 não tem este código e nunca vai ter.
// A metade do cliente só protege quem for ficar velho a partir da próxima build.
//
// SERVIDOR (migration 0081): é a única metade com dentes. O trigger em `rides`
// lê o cabeçalho `x-goxl-version` que o cliente novo envia (src/lib/supabase.ts)
// e recusa o INSERT. Cliente velho não manda cabeçalho nenhum — e é exatamente
// esse o caso que precisa cair.
//
// ── FALHA PARA O LADO ABERTO, DE PROPÓSITO ─────────────────────────────────
//
// Se o app não conseguir descobrir a própria versão, ou a config não carregar,
// esta camada NÃO bloqueia. Um cliente que se auto-emparedou por não saber
// responder uma pergunta sobre si mesmo é pior que um cliente velho: vira
// tijolo sem recurso, e nem desinstalar e reinstalar resolve se a causa for a
// rede. Quem cobra a conta é o servidor, que sabe o que está recebendo.

/** Os idiomas que o app fala hoje (ver src/i18n/index.tsx). */
export type IdiomaTrava = 'en' | 'pt' | 'es';

export type TextoTrava = {
  titulo: string;
  corpo: string;
  botao: string;
};

export type ConfigTravaVersao = {
  /** Versão mínima aceita, no formato de `app.config.js` (ex.: '1.0.10'). */
  min: string;
  /** Liga a recusa no SERVIDOR (trigger da 0081). Desligado por padrão. */
  enforceServer: boolean;
  store: { android: string; ios: string };
  message: Partial<Record<IdiomaTrava, TextoTrava>>;
};

/**
 * O padrão é a trava DESLIGADA: `0.0.0` não é maior que versão nenhuma, então
 * `precisaAtualizar` sempre devolve false até alguém subir esse número.
 *
 * Isso não é timidez, é a ordem certa de implantação: a trava só pode subir
 * DEPOIS que a build que a contém estiver publicada e adotada. Ligar antes
 * emparedaria justamente quem está em dia.
 */
export const TRAVA_DESLIGADA: ConfigTravaVersao = {
  min: '0.0.0',
  enforceServer: false,
  store: {
    android: 'https://play.google.com/store/apps/details?id=com.goxl.app',
    ios: 'https://apps.apple.com/app/go-xl/id6781716394',
  },
  message: {},
};

/**
 * Compara duas versões pelo NÚMERO de cada segmento, nunca como texto.
 *
 * Isto é o coração da coisa e é onde a implementação ingênua erra: como texto,
 * '1.0.10' < '1.0.9', porque '1' vem antes de '9'. Foi exatamente a transição
 * que acabamos de viver (1.0.9 → 1.0.10), e um `<` de string teria liberado a
 * build velha e travado a nova.
 *
 * Devolve -1 se `a` é anterior a `b`, 1 se posterior, 0 se equivalentes.
 *
 * Segmentos ausentes valem 0 ('1.0' == '1.0.0'). Sufixos não numéricos são
 * ignorados no segmento em que aparecem ('1.0.0-beta' == '1.0.0') — a GoXL não
 * publica pré-lançamento nas lojas, então tratar beta como igual é o
 * comportamento correto aqui e evita inventar uma ordem que ninguém usa.
 */
export function compararVersoes(a: string, b: string): -1 | 0 | 1 {
  const partes = (v: string): number[] =>
    String(v ?? '')
      .split('.')
      .map((seg) => {
        const casou = /^\d+/.exec(seg.trim());
        return casou ? parseInt(casou[0], 10) : 0;
      });

  const pa = partes(a);
  const pb = partes(b);
  const n = Math.max(pa.length, pb.length);

  for (let i = 0; i < n; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/** Uma string só é versão se tiver ao menos um dígito. */
export function versaoValida(v: string | null | undefined): boolean {
  return typeof v === 'string' && /\d/.test(v);
}

/**
 * A pergunta que a UI faz.
 *
 * Devolve `false` — ou seja, NÃO bloqueia — quando a versão atual é
 * desconhecida ou o mínimo é ilegível. Ver a nota sobre falhar para o lado
 * aberto no topo do arquivo.
 */
export function precisaAtualizar(
  atual: string | null | undefined,
  minima: string | null | undefined,
): boolean {
  if (!versaoValida(atual) || !versaoValida(minima)) return false;
  return compararVersoes(atual as string, minima as string) < 0;
}

/**
 * Normaliza o que veio do `system_config`, que é jsonb livre e pode chegar
 * torto. Campo ausente ou de tipo errado cai no padrão DESLIGADO — nunca numa
 * trava acidental.
 */
export function lerConfigTrava(bruto: unknown): ConfigTravaVersao {
  const o = (bruto ?? {}) as Partial<ConfigTravaVersao>;
  const store = (o.store ?? {}) as Partial<ConfigTravaVersao['store']>;
  return {
    min: versaoValida(o.min) ? (o.min as string) : TRAVA_DESLIGADA.min,
    enforceServer: o.enforceServer === true,
    store: {
      android: typeof store.android === 'string' && store.android
        ? store.android
        : TRAVA_DESLIGADA.store.android,
      ios: typeof store.ios === 'string' && store.ios
        ? store.ios
        : TRAVA_DESLIGADA.store.ios,
    },
    message: (o.message && typeof o.message === 'object' ? o.message : {}) as ConfigTravaVersao['message'],
  };
}

/**
 * O texto da tela, resolvido por idioma.
 *
 * A cópia vem da CONFIG, não de `src/i18n/translations.ts`. Duas razões, e as
 * duas são boas: o arquivo de traduções está travado neste projeto, e — mais
 * importante — o texto de "atualize o app" precisa poder mudar sem uma build
 * nova, que é justamente o que não se pode contar com quem está preso na velha.
 *
 * Precedência: idioma pedido → inglês (padrão oficial do app) → o `reserva`
 * embutido, que é o que sobra se ninguém preencheu a config ainda.
 */
export function textoDaTrava(
  cfg: ConfigTravaVersao,
  lang: IdiomaTrava,
  reserva: TextoTrava,
): TextoTrava {
  const escolhido = cfg.message?.[lang] ?? cfg.message?.en;
  return {
    titulo: escolhido?.titulo?.trim() || reserva.titulo,
    corpo: escolhido?.corpo?.trim() || reserva.corpo,
    botao: escolhido?.botao?.trim() || reserva.botao,
  };
}
