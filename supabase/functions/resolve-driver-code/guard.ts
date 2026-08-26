// Guarda de fronteira da Edge Function PÚBLICA `resolve-driver-code`.
//
// Módulo PURO de propósito: sem `Deno.*`, sem rede, sem `crypto` (o hash fica
// no index.ts, que é async). Isso é o que permite testá-lo no Jest do app
// (supabase/functions/resolve-driver-code/__tests__/guard.test.ts) exatamente
// como `_shared/chargeCycle.ts` já é testado — o teste exercita ESTE código,
// não um mock dele.
//
// Duas decisões de segurança moram aqui:
//   1. o formato aceito pelo SERVIDOR (fronteira de confiança);
//   2. de onde sai a chave de bucket do rate limit.

// ─────────────────────────────────────────────────────────────────────────────
// 1. Formato
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Alfabeto canônico do driver code — Crockford-ish, SEM I, O, 0 e 1.
 *
 * Cópia literal de `src/lib/driverCode.ts:36` e de `codeFromId`
 * (src/screens/driver/QRCodeScreen.tsx:46-59), que é a ÚNICA função que grava
 * `profiles.driver_code`. É cópia e não import porque a Edge Function roda em
 * Deno e não pode importar de `src/`; o teste deste módulo compara os dois
 * literais para que a duplicação não possa divergir em silêncio.
 */
export const SERVER_DRIVER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Formato aceito pelo servidor: 6 símbolos DO ALFABETO CANÔNICO.
 *
 * ANTES era `^[A-Z0-9]{6}$`, que admitia I, O, 0 e 1 — quatro símbolos que
 * `codeFromId` nunca emite. O servidor é a fronteira de confiança e não pode
 * ser mais FROUXO que o client: cada símbolo a mais multiplica o espaço que um
 * enumerador precisa varrer... e o espaço que ele pode gastar do NOSSO rate
 * limit com códigos que sabidamente não existem. 36^6 = 2,18 bi contra
 * 32^6 = 1,07 bi: metade das tentativas viravam I/O de banco por nada.
 *
 * Custo desta mudança: um `driver_code` legado que não tenha saído de
 * `codeFromId` deixaria de resolver. Nenhum caminho do app grava esse campo
 * fora de QRCodeScreen.tsx:90 (conferido por grep em todo o repositório), e o
 * client JÁ recusa esses caracteres antes de chamar a função
 * (src/lib/driverCode.ts:39) — ou seja, um código assim já estava morto no
 * app; a mudança só para de gastar banco com ele.
 */
export const SERVER_DRIVER_CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

/**
 * Normaliza o `driver_code` vindo do corpo da requisição (não confiável).
 * Devolve `null` para qualquer coisa que não seja o formato canônico —
 * incluindo tipo errado, o que evita que `body.driver_code` ser um objeto vire
 * um `toUpperCase` em cima de `[object Object]`.
 */
export function normalizeServerDriverCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return SERVER_DRIVER_CODE_RE.test(code) ? code : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Origem da chave de bucket do rate limit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Quantos proxies que APENDAM em `X-Forwarded-For` existem entre o cliente e
 * este código.
 *
 * ── A correção ────────────────────────────────────────────────────────────
 * A versão anterior lia o elemento MAIS À ESQUERDA do header e o comentário
 * afirmava, como fato, que "o primeiro elemento é o cliente". Isso é FALSO
 * como regra geral: `X-Forwarded-For` é uma lista onde cada proxy que apenda
 * acrescenta À DIREITA o endereço do peer que ELE viu. O elemento mais à
 * esquerda é, portanto, o que o PRIMEIRO salto RECEBEU — ou seja, texto
 * escolhido pelo chamador sempre que algum proxy apenda em vez de
 * sobrescrever. Um atacante mandando `X-Forwarded-For: <aleatório>` a cada
 * requisição caía num bucket novo toda vez, `request_count` era sempre 1, e as
 * duas janelas passavam para sempre.
 *
 * O elemento confiável é o (N)-ésimo A PARTIR DA DIREITA, onde N é o número de
 * saltos que apendam. Com N = 1 a leitura fica correta nos DOIS regimes
 * plausíveis da plataforma:
 *   • o gateway SOBRESCREVE o header  → a lista tem 1 elemento, e ele é o
 *     cliente: índice `len - 1` acerta;
 *   • o gateway APENDA o peer que viu → a lista é `[...forjado, cliente]`, e
 *     `len - 1` acerta de novo, descartando tudo o que foi forjado à esquerda.
 *
 * ── HIPÓTESE, NÃO MEDIÇÃO ─────────────────────────────────────────────────
 * NADA disto foi observado contra o gateway real. Não há como observá-lo desta
 * máquina: exigiria um `curl` contra a função IMPLANTADA mandando um
 * `X-Forwarded-For` conhecido e ler de volta o que a função recebeu. O comando
 * exato está no rodapé de `index.ts`. Enquanto isso não for medido, a
 * suposição "N = 1" pode estar errada — e é justamente por isso que ela NÃO é
 * a única linha de defesa: existe um teto GLOBAL do endpoint (ver
 * `index.ts`, janela `:global`) que um atacante não consegue evadir forjando
 * header nenhum, porque o bucket dele não depende do chamador.
 *
 * ── AS DUAS DIREÇÕES DE ERRO, EXPLÍCITAS ──────────────────────────────────
 * Errar este número não é ruim "mais ou menos" — é ruim de dois jeitos
 * OPOSTOS, e quem for medir precisa saber o que cada sintoma significa:
 *
 *   • SALTOS DE MENOS (o real é 2, aqui está 1): com 2 saltos que apendam, a
 *     lista é `[...forjado, cliente, ipDoSalto1]` e o cliente está em
 *     `len - 2`. Lendo `len - 1` pegamos o ENDEREÇO DO PRÓPRIO PROXY, que é o
 *     mesmo para todo mundo: a frota inteira colapsa num bucket só. Sintoma:
 *     429 em massa na janela `:short`, com `bucketSource: "xff-trusted-hop"`
 *     — ou seja, 8 requisições por minuto PARA O APP INTEIRO.
 *   • SALTOS DE MAIS (o real é 1, aqui está 2): `len - 2` cai sobre um
 *     elemento que o CHAMADOR escreveu. A chave volta a ser escolhida pelo
 *     atacante, cada requisição vira bucket novo, e as janelas `:short` e
 *     `:long` param de valer — sobra só a `:global`. Sintoma: nenhum. É
 *     silencioso, e é por isso que a `:global` existe.
 *
 * Ou seja: errar para MENOS é uma queda de serviço barulhenta; errar para
 * MAIS é uma perda de controle silenciosa. Nenhum dos dois é detectável
 * daqui. Se a medição mostrar outro número de saltos, mude só esta constante.
 */
export const TRUSTED_PROXY_HOPS = 1;

/**
 * Headers de valor único que ALGUNS edges preenchem com o IP do cliente.
 *
 * ── POR QUE ELES NÃO SÃO MAIS CONSULTADOS POR PADRÃO (correção da it. 4) ──
 * A iteração 3 lia estes headers ANTES do X-Forwarded-For e confiava neles se
 * apenas SE PARECESSEM com um IP. Isso movia o defeito P0 um header para o
 * lado em vez de fechá-lo: `X-Real-IP` e `CF-Connecting-IP` são texto que o
 * chamador escreve na requisição, exatamente como o elemento mais à esquerda
 * do XFF. Se o gateway não os SOBRESCREVER, então
 *
 *     curl -X POST .../resolve-driver-code \
 *          -H 'X-Real-IP: 198.51.100.<aleatório>' -d '{"driver_code":"ABC234"}'
 *
 * devolve um bucket novo por requisição e anula as janelas `:short` (8/min) e
 * `:long` (60/h) — as mesmas que o anti-enumeração por origem depende. O
 * código gastava ~40 linhas duvidando do XFF e depois passava por cima de
 * toda essa dúvida num header que não questionava.
 *
 * "O edge preenche estes headers" é uma HIPÓTESE que ninguém mediu contra o
 * gateway do Supabase. Enquanto ela for hipótese, o caminho fica DESLIGADO: o
 * bucket sai só do XFF ancorado à direita, e o que não der é fallback.
 *
 * Para religar depois de MEDIR (ver o rodapé de `index.ts`), defina a variável
 * de ambiente na função implantada:
 *
 *     npx supabase secrets set GOXL_TRUST_SINGLE_VALUE_IP_HEADERS=1
 *
 * Sem a variável — que é o estado de fábrica — o caminho não existe.
 */
export const SINGLE_VALUE_IP_HEADERS = ['cf-connecting-ip', 'x-real-ip'] as const;

/** Nome da variável de ambiente que religa os headers de valor único. */
export const TRUST_SINGLE_VALUE_HEADERS_ENV = 'GOXL_TRUST_SINGLE_VALUE_IP_HEADERS';

/**
 * Interpreta a variável de ambiente acima. PURA, para que o teste possa fixar
 * o padrão (DESLIGADO) sem `Deno.env`.
 *
 * Só `'1'` e `'true'` ligam. Qualquer outra coisa — ausente, vazia, `'0'`,
 * `'false'`, `'yes'`, lixo — deixa desligado. Um valor ambíguo não pode
 * afrouxar um controle de segurança por acidente de digitação.
 */
export function trustSingleValueHeadersFromEnv(raw: string | null | undefined): boolean {
  const v = (raw ?? '').trim().toLowerCase();
  return v === '1' || v === 'true';
}

/** De onde a chave saiu — vai para o log, para que a suposição seja auditável. */
export type BucketSourceKind = 'single-header' | 'xff-trusted-hop' | 'shared-fallback';

export type BucketSource = {
  /** Texto que entra no hash. Nunca é logado cru. */
  value: string;
  kind: BucketSourceKind;
  /** Nome do header de onde veio, ou `null` no fallback. */
  header: string | null;
};

/**
 * Bucket compartilhado por TODO chamador cuja origem não foi possível
 * estabelecer. Deliberadamente um valor fixo: quem não tem origem
 * identificável divide um único balde.
 *
 * ── ATENÇÃO: ISTO É UMA ALAVANCA DE DoS, NÃO SÓ UM "MAIS ESTRITO" ─────────
 * A iteração 3 descrevia este balde como "degradar para mais estrito, nunca
 * mais frouxo" e parava aí. A frase é verdadeira e insuficiente: se o regime
 * de headers assumido NÃO se confirmar — que é exatamente a incerteza que
 * este arquivo admite em dois lugares —, então TODO chamador anônimo cai
 * aqui, e um atacante mandando 8 requisições por minuto esgota a janela
 * `:short` do balde compartilhado e NEGA o Cadastro Expresso ao planeta
 * inteiro. Sem atacante nenhum, 60 cadastros por hora no mundo já é um teto
 * de produto, não um controle de segurança.
 *
 * Por isso o balde compartilhado tem ORÇAMENTO PRÓPRIO, muito maior que o de
 * uma origem individual (`SHARED_FALLBACK_*` em `index.ts`), e o índice de
 * tráfego que cai aqui é emitido no log (ver `createBucketKindTelemetry`) —
 * essa fração É a medição que resolveria a dúvida sobre os headers.
 *
 * É também o caminho de um `curl` local em teste.
 */
export const SHARED_FALLBACK_BUCKET = 'shared:unidentified-origin';

/**
 * Aceita apenas o que se parece com um endereço IP (v4 ou v6, com ou sem
 * `[...]:porta`). Um elemento de XFF pode ser `unknown`, um nome obfuscado ou
 * lixo; nesses casos preferimos o fallback compartilhado a criar um bucket
 * novo com o texto do atacante.
 */
function looksLikeIp(candidate: string): boolean {
  const v = candidate.replace(/^\[|\]$/g, '').replace(/\]:\d+$/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(v)) {
    return v.split(':')[0].split('.').every((o) => Number(o) <= 255);
  }
  return /^[0-9a-f:]+$/i.test(v) && v.includes(':') && v.length >= 3;
}

/** Normaliza para comparar `1.2.3.4:5678` e `[::1]:443` com a forma sem porta. */
function stripPort(candidate: string): string {
  const bracketed = candidate.match(/^\[(.+)\](?::\d+)?$/);
  if (bracketed) return bracketed[1].toLowerCase();
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(candidate)) return candidate.split(':')[0];
  return candidate.toLowerCase();
}

export type BucketSourceOptions = {
  /** Saltos que apendam em XFF. Ver `TRUSTED_PROXY_HOPS`. */
  trustedHops?: number;
  /**
   * Religa `SINGLE_VALUE_IP_HEADERS`. PADRÃO `false` — e o padrão é a decisão
   * de segurança, não um detalhe: enquanto ninguém MEDIR que o edge sobrescreve
   * esses headers, confiar neles é confiar em texto do chamador.
   */
  trustSingleValueHeaders?: boolean;
};

/**
 * Deriva a origem do bucket a partir dos headers da requisição.
 *
 * `getHeader` em vez de `Request` para manter o módulo puro e testável sem
 * `fetch`/`Headers` no Jest. O index.ts passa `(n) => req.headers.get(n)`.
 *
 * Regra, em ordem:
 *   1. o elemento `len - trustedHops` do `X-Forwarded-For`, se a lista for
 *      longa o bastante E o elemento for um IP;
 *   2. bucket compartilhado.
 *
 * O passo 1 NUNCA lê da esquerda: se a lista for mais curta que o número de
 * saltos confiáveis, isso significa que o header não passou pelos saltos que
 * supomos existir — e a resposta certa é o fallback, não "então pega o
 * primeiro".
 *
 * Os headers de VALOR ÚNICO (`x-real-ip`, `cf-connecting-ip`) NÃO são
 * consultados a menos que `trustSingleValueHeaders` seja explicitamente
 * ligado. Ver o bloco de `SINGLE_VALUE_IP_HEADERS`: eles são tão forjáveis
 * quanto o elemento mais à esquerda do XFF, e consultá-los primeiro era um
 * curto-circuito que anulava toda a ancoragem à direita logo abaixo.
 *
 * Quando ligados, eles vêm DEPOIS do XFF, não antes: se o XFF ancorado à
 * direita produziu um IP, esse caminho já passou pelo raciocínio de saltos, e
 * não há motivo para preferir sobre ele um header sobre o qual sabemos menos.
 */
export function bucketSourceFromHeaders(
  getHeader: (name: string) => string | null,
  options: BucketSourceOptions = {},
): BucketSource {
  const trustedHops = options.trustedHops ?? TRUSTED_PROXY_HOPS;

  const parts = (getHeader('x-forwarded-for') ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const index = parts.length - Math.max(1, trustedHops);
  if (index >= 0) {
    const candidate = parts[index];
    if (looksLikeIp(candidate)) {
      return { value: stripPort(candidate), kind: 'xff-trusted-hop', header: 'x-forwarded-for' };
    }
  }

  if (options.trustSingleValueHeaders === true) {
    for (const header of SINGLE_VALUE_IP_HEADERS) {
      const raw = (getHeader(header) ?? '').trim();
      if (raw && looksLikeIp(raw)) {
        return { value: stripPort(raw), kind: 'single-header', header };
      }
    }
  }

  return { value: SHARED_FALLBACK_BUCKET, kind: 'shared-fallback', header: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Telemetria da fração de tráfego sem origem identificável
// ─────────────────────────────────────────────────────────────────────────────

/** Relatório emitido a cada `sampleSize` requisições de UMA instância. */
export type BucketKindReport = {
  sample: number;
  counts: Record<BucketSourceKind, number>;
  /** Fração em `shared-fallback`, entre 0 e 1. */
  sharedFallbackRatio: number;
  /** `true` quando a fração cruza o limiar — é o que a regra de alerta casa. */
  alert: boolean;
};

/**
 * Limiar acima do qual a fração de `shared-fallback` deixa de ser ruído.
 *
 * Um `curl` local, um health check e um cliente exótico caem no fallback e são
 * normais. Metade do tráfego caindo lá não é: significa que o regime de
 * headers assumido por este arquivo NÃO é o regime real.
 */
export const SHARED_FALLBACK_ALERT_RATIO = 0.5;

/**
 * Contador em memória da distribuição de `BucketSourceKind`.
 *
 * ── O QUE ISTO É, E O QUE NÃO É ───────────────────────────────────────────
 * NÃO é um controle de segurança e NÃO é uma métrica confiável de frota: uma
 * Edge Function roda em instâncias efêmeras e paralelas, então cada instância
 * enxerga só a própria fatia e o contador zera quando ela é reciclada.
 *
 * O que ele É: a única forma de fazer chegar a um humano, pelos logs, a
 * resposta da pergunta que este módulo não consegue responder sozinho — "o
 * gateway entrega os headers que a gente supôs?". Uma linha por amostra, com
 * a fração de cada `kind`. Se `shared-fallback` domina, `TRUSTED_PROXY_HOPS`
 * e o parágrafo inteiro sobre XFF estão descrevendo um mundo que não existe, e
 * as janelas por origem não estão limitando ninguém.
 *
 * Fábrica em vez de estado de módulo para que o teste exercite ESTA lógica sem
 * um singleton que vaze entre casos.
 */
export function createBucketKindTelemetry(sampleSize = 200) {
  const size = Math.max(1, Math.floor(sampleSize));
  let counts: Record<BucketSourceKind, number> = {
    'single-header': 0,
    'xff-trusted-hop': 0,
    'shared-fallback': 0,
  };
  let seen = 0;

  return {
    /** Devolve um relatório a cada `sampleSize` chamadas; `null` no resto. */
    record(kind: BucketSourceKind): BucketKindReport | null {
      counts[kind] += 1;
      seen += 1;
      if (seen < size) return null;

      const ratio = counts['shared-fallback'] / seen;
      const report: BucketKindReport = {
        sample: seen,
        counts,
        sharedFallbackRatio: ratio,
        alert: ratio >= SHARED_FALLBACK_ALERT_RATIO,
      };
      counts = { 'single-header': 0, 'xff-trusted-hop': 0, 'shared-fallback': 0 };
      seen = 0;
      return report;
    },
  };
}
