// Supabase Edge Function — resolve um driver code (QR) PRÉ-AUTENTICAÇÃO.
//
// ── Por que esta função existe ────────────────────────────────────────────
// O Cadastro Expresso (src/screens/passenger/ExpressRegisterScreen.tsx) roda
// para um passageiro que ainda NÃO tem conta: ele lê o QR de um motorista e o
// app precisa traduzir o código de 6 caracteres em `{ id, full_name }` para
// travar a 1ª corrida naquele motorista. Antes, isso era um SELECT direto na
// view `public.profiles_public` com a anon key embutida no binário
// (src/lib/supabase.ts:21).
//
// Essa view é `security_invoker = off` (0049:43), portanto lê `profiles` com o
// privilégio do DONO e ignora a RLS da tabela. Com `anon` tendo SELECT nela
// (default privilege do schema `public` no Supabase), qualquer pessoa com o
// binário podia rodar:
//
//     GET /rest/v1/profiles_public?select=*
//
// e baixar `id, full_name, avatar_url, rating, type, driver_code` de TODOS os
// passageiros e motoristas — um diretório completo do app, incluindo a
// credencial de QR de todo motorista (que o AppNavigator aceita para travar
// uma corrida). A migration 0067 revoga `anon` dessa view; esta função é o
// substituto de superfície mínima para o único fluxo pré-login que precisava
// dela.
//
// ── O que muda em termos de exposição ─────────────────────────────────────
//   ANTES: anon LISTA a base inteira (6 colunas × todos os usuários).
//   DEPOIS: anon faz LOOKUP de 1 código por vez e recebe 2 colunas
//           (`id`, `full_name`) de um perfil `type = 'driver'`. Não existe
//           caminho de listagem: sem código não há resposta, e a resposta
//           nunca inclui `driver_code`, avatar, nota, e-mail ou telefone.
//
// ── Anti-enumeração (o ponto que exige cuidado) ───────────────────────────
// Um endpoint público que confirma "este código existe e é do Fulano" é, por
// construção, um oráculo. O espaço de códigos é 32^6 ≈ 1,07 bilhão
// (`codeFromId`, QRCodeScreen.tsx:46-59 — alfabeto de 32 chars, 6 posições), e a
// densidade de códigos válidos é a razão entre nº de motoristas e esse espaço
// — hoje minúscula. Ainda assim, três camadas:
//
//   1. Guarda de formato: só o alfabeto CANÔNICO de 32 símbolos chega ao banco
//      (guard.ts). Mata varredura com lixo/SQL e recusa antes de qualquer I/O.
//   2. Rate limit em TRÊS janelas, em Postgres — não em memória: Edge Functions
//      rodam em instâncias efêmeras e paralelas, então contador em processo não
//      vale nada. Mesmo formato de bucket da migration 0051
//      (`check_admin_rate_limit`). Duas janelas por ORIGEM (curta e longa) e uma
//      terceira GLOBAL, do endpoint inteiro — ver abaixo por que a global é a
//      que não depende de nenhuma suposição sobre headers.
//   3. Resposta uniforme: código desconhecido, código de passageiro e código
//      malformado devolvem TODOS `{ driver: null }` com HTTP 200. O chamador
//      não distingue os casos.
//
// ── Por que existe uma janela GLOBAL (correção da iteração 3) ─────────────
// A chave de bucket por origem sai de headers de proxy, e NENHUMA suposição
// sobre esses headers pode ser verificada de dentro do repositório (ver o
// bloco `TRUSTED_PROXY_HOPS` em guard.ts). Se a suposição estiver errada, a
// chave volta a ser escolhida pelo chamador e o limite por origem vira zero.
// A janela `:global` usa uma chave CONSTANTE — nenhum header entra nela — e
// portanto continua valendo mesmo nesse cenário. Ela é o piso que sobra quando
// tudo o mais falha, e por isso o teto dela é dimensionado para o tráfego do
// endpoint inteiro, não para um usuário.
//
// LIMITE HONESTO: rate limit não impede um atacante com botnet ou pool de
// proxies de gastar a cota GLOBAL — o que ele consegue com isso é negar o
// Cadastro Expresso a outros, não baixar a base. Ele transforma "baixar a base
// inteira com uma requisição" em "gastar recursos distribuídos por bilhões de
// tentativas para achar poucos códigos" — que é a mudança de ordem de grandeza
// que interessa. A defesa definitiva seria assinar o QR (código + HMAC com
// validade), o que exige mudar QRCodeScreen e a landing goxl.app/qr — fora do
// escopo desta correção.
//
// Deploy:  npx supabase functions deploy resolve-driver-code
// Requer no config.toml:  [functions.resolve-driver-code] verify_jwt = false
//
// ORDEM DE DEPLOY — NÃO É OPCIONAL: a migration 0067 (que cria
// `check_public_lookup_rate_limit`) tem de estar APLICADA ANTES desta função
// ser implantada. A função agora se RECUSA a servir se a RPC não responder
// (ver `rateLimiterReady`), então implantar fora de ordem devolve 503 em vez
// de servir um endpoint público sem limite nenhum.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  bucketSourceFromHeaders,
  createBucketKindTelemetry,
  normalizeServerDriverCode,
  trustSingleValueHeadersFromEnv,
  TRUST_SINGLE_VALUE_HEADERS_ENV,
  type BucketSource,
} from './guard.ts';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

/**
 * Confiar em `X-Real-IP`/`CF-Connecting-IP` — DESLIGADO por padrão.
 *
 * Lido uma vez por instância. Ver `guard.ts`: estes headers são escritos pelo
 * chamador tanto quanto o elemento mais à esquerda do XFF, e ninguém mediu que
 * o gateway do Supabase os sobrescreve. Ligar sem medir devolve ao atacante a
 * escolha da chave de bucket.
 */
const TRUST_SINGLE_VALUE_HEADERS = trustSingleValueHeadersFromEnv(
  Deno.env.get(TRUST_SINGLE_VALUE_HEADERS_ENV),
);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const JSON_HEADERS = { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

/** Janela curta: rajada de um scan legítimo (retry, duplo toque). */
const SHORT_WINDOW_SECONDS = 60;
const SHORT_WINDOW_MAX     = 8;

/** Janela longa: teto sustentado por origem, contra varredura lenta. */
const LONG_WINDOW_SECONDS = 3600;
const LONG_WINDOW_MAX     = 60;

/**
 * Janela GLOBAL do endpoint — chave constante, nenhum header entra nela.
 *
 * Dimensionamento: a frota é de Orlando e o Cadastro Expresso é um evento raro
 * por passageiro (uma vez, ao ler o QR). 300 lookups por minuto é ordens de
 * grandeza acima do tráfego legítimo e ainda assim limita um enumerador a
 * ~432 mil tentativas por dia contra um espaço de 32^6 ≈ 1,07 bilhão — ou seja,
 * ~2.500 anos para varrer o espaço, e isso ASSUMINDO que ele consiga gastar a
 * cota global inteira (o que nega o serviço a outros e é ruidoso).
 *
 * Este teto é o único aqui que NEGA TODO MUNDO quando estoura, então a ordem em
 * que ele é conferido importa mais que o número — ver o bloco de janelas no
 * handler. Nenhum destes valores foi medido contra tráfego real; são escolhas
 * dimensionadas por argumento, e o que os corrigirá é a telemetria de produção.
 */
const GLOBAL_WINDOW_SECONDS = 60;
const GLOBAL_WINDOW_MAX     = 300;
const GLOBAL_BUCKET_KEY     = 'global:resolve-driver-code';

/**
 * Orçamento do BALDE COMPARTILHADO — o de quem não teve origem identificada.
 *
 * ── O defeito que isto corrige (iteração 4) ───────────────────────────────
 * Antes, o balde compartilhado usava o MESMO teto de uma origem individual:
 * 8/min e 60/h. Só que ele não representa uma origem, e sim TODAS as origens
 * que não deram para identificar — e, no regime em que os headers assumidos
 * não chegam (a incerteza que `guard.ts` admite duas vezes), isso é o tráfego
 * inteiro. Consequências, as duas ruins:
 *
 *   • DoS de uma linha: 8 requisições por minuto de um único atacante
 *     esgotavam a janela e negavam o Cadastro Expresso a todo mundo.
 *   • Teto de produto: 60 cadastros expressos por hora NO MUNDO.
 *
 * Os tetos abaixo são deliberadamente próximos (e abaixo) dos da janela
 * `:global`. A leitura correta é: quando a origem não é identificável, o
 * controle que de fato vale é o GLOBAL, e o balde compartilhado passa a ser
 * uma segunda camada quase redundante — e não um gargalo mais apertado que o
 * teto do endpoint inteiro. Continuar mais estrito que a `:global` seria
 * transformar "não sei de onde veio" em "então nego o serviço".
 *
 * A fração de tráfego que cai aqui é logada (`BUCKET_SOURCE_MIX`): se ela for
 * alta, o número que precisa mudar não é este, é a suposição de headers.
 */
const SHARED_FALLBACK_SHORT_MAX = 240;
const SHARED_FALLBACK_LONG_MAX  = 3600;

/**
 * Amostra da telemetria de `BucketSourceKind`. 200 requisições é grande o
 * bastante para a fração significar alguma coisa e pequeno o bastante para uma
 * instância efêmera chegar lá antes de ser reciclada.
 */
const bucketKindTelemetry = createBucketKindTelemetry(200);

/**
 * Tamanho do espaço de chaves de bucket por origem. Precisa ser MENOR que o
 * `p_max_buckets` de `check_public_lookup_rate_limit` (default 5000) — ver o
 * JSDoc de `hashBucket`.
 *
 * 4096 e não 5000 porque potência de dois: `65536 % 4096 = 0`, então os 16 bits
 * lidos do digest mapeiam em 4096 slots SEM viés de módulo. Com 5000 os 536
 * primeiros slots receberiam o dobro do tráfego dos demais, e um atacante que
 * saiba disso escolhe a metade cheia.
 */
const BUCKET_KEY_SPACE = 4096;

/**
 * Hash da origem do bucket. O identificador é HASHEADO (SHA-256) antes de virar
 * linha no banco: o objetivo é contar requisições, não montar um registro de
 * endereços IP de quem escaneia QR.
 *
 * De ONDE sai o identificador — e por que não do primeiro elemento de
 * `X-Forwarded-For` — está documentado em `guard.ts`. Resumo: o elemento mais à
 * esquerda é escolhido pelo chamador; ler dali fazia cada requisição cair num
 * bucket novo e anulava as duas janelas.
 *
 * ── POR QUE O ESPAÇO DE CHAVES É FINITO (correção da iteração 5) ──────────
 * A versão anterior devolvia 32 hex chars — 2^64 chaves possíveis. Isso era
 * inofensivo enquanto a janela `:global` vinha PRIMEIRO, porque ela barrava o
 * atacante antes de qualquer bucket por origem ser criado. Ao inverter a ordem
 * (a global agora é a última, ver a nota em `Deno.serve`), a criação de bucket
 * passou a acontecer ANTES de qualquer teto global — e a cardinalidade virou a
 * alavanca.
 *
 * `check_public_lookup_rate_limit` (0069 B.2.0) nega quando o número de buckets
 * DISTINTOS de uma (função, janela) chega a `p_max_buckets` = 5000, e este
 * chamador usa o default. Com chave livre, ~5.000 requisições com valores de
 * header distintos dentro de um mesmo minuto enchem `resolve-driver-code:short`
 * e a partir daí TODA origem nova recebe `false` → 429. A inversão de ordem
 * teria trocado um vetor de negação global por outro.
 *
 * Com 4096 < 5000 o teto é inalcançável POR CONSTRUÇÃO: o `insert` só roda para
 * uma chave inédita, e não existem 5000 chaves.
 *
 * O QUE SE PERDE, explicitamente: um bucket deixa de ser uma origem e passa a
 * ser uma CLASSE de origens. Duas origens que caiam no mesmo slot dividem o teto
 * de 8/min, e para N origens ativas na janela o número esperado de pares em
 * colisão é N²/(2·4096) — com N NÃO MEDIDO aqui; quem responde qual é o N real
 * é a telemetria de produção, não este comentário. Em troca, o raio de uma
 * origem hostil cai de "nega o endpoint inteiro" para "nega 1/4096 das origens".
 *
 * Efeito colateral bom: 12 bits não são mais um pseudônimo reversível de um IP.
 * 64 bits eram — dado o hash e um palpite de IP, dava para confirmar o palpite.
 */
async function hashBucket(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`goxl:${value}`));
  const bytes = new Uint8Array(digest);
  const slot = (((bytes[0] << 8) | bytes[1]) % BUCKET_KEY_SPACE).toString(16).padStart(3, '0');
  return `b${slot}`;
}

/**
 * Só o que esta função precisa do client — evita amarrar a assinatura aos
 * genéricos de `SupabaseClient`, que mudam entre versões do supabase-js e
 * fazem o `deno check` reclamar de tipos que não têm relação com a lógica.
 */
type RpcCaller = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{
    data: unknown;
    error: { message: string } | null;
  }>;
};

/** Resultado das três janelas. `unavailable` NÃO é "permitido". */
type RateLimitVerdict = 'allowed' | 'exceeded' | 'unavailable';

/**
 * Incrementa uma janela e diz se ainda cabe.
 *
 * ── FALHA FECHADA (correção da iteração 3) ────────────────────────────────
 * A versão anterior devolvia `true` (permitido) quando a RPC dava erro, com um
 * `console.warn`. Isso não era um caso de borda teórico: a RPC
 * `check_public_lookup_rate_limit` só existe na migration 0067, esta função lê
 * `profiles` com `service_role` e funciona perfeitamente sem ela, e nada
 * acoplava o deploy da função à aplicação da migration. Implantar a função
 * antes da migration produzia um endpoint público, ANÔNIMO e SEM LIMITE
 * NENHUM — nas três janelas ao mesmo tempo — enquanto todo teste funcional
 * continuava verde e o único sinal era um `warn` no log.
 *
 * Agora o erro é um veredito próprio, e o chamador responde 503. O tradeoff é
 * explícito: se a tabela de rate limit cair, o Cadastro Expresso para. Isso é
 * preferível a um oráculo de enumeração aberto que ninguém percebe.
 *
 * ── E SE A RPC LANÇAR EM VEZ DE DEVOLVER `{error}` (correção da it. 4) ────
 * O `supabase-js` devolve `{ data, error }` no caminho normal, mas a chamada é
 * um `fetch`: DNS caído, TLS, timeout, JSON inválido e AbortError chegam aqui
 * como EXCEÇÃO, não como `error`. Antes, essa exceção subia até o `try` que
 * envolve o handler inteiro — cujo `catch` responde `200 {"driver":null}`.
 * Resultado: o controle de rate limit sumia e o usuário via "código inválido",
 * um diagnóstico ERRADO para uma indisponibilidade de infraestrutura. Fechava
 * quanto a DADOS (não vazava perfil), mas mentia sobre a causa e escondia a
 * falha do rate limiter atrás de uma resposta de sucesso.
 *
 * O `try/catch` abaixo é o estreitamento: a exceção é tratada NA FRONTEIRA da
 * RPC e vira o mesmo veredito `unavailable` do erro estruturado → 503.
 */
async function checkWindow(
  admin: RpcCaller,
  bucketKey: string,
  windowName: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<RateLimitVerdict> {
  let data: unknown;
  let error: { message: string } | null;
  try {
    ({ data, error } = await admin.rpc('check_public_lookup_rate_limit', {
      p_bucket_key:     bucketKey,
      p_function_name:  windowName,
      p_max_requests:   maxRequests,
      p_window_seconds: windowSeconds,
    }));
  } catch (e) {
    console.error(
      '[ALERT][resolve-driver-code] RATE_LIMIT_THREW',
      JSON.stringify({ window: windowName, message: (e as Error)?.message ?? String(e) }),
    );
    return 'unavailable';
  }

  if (error) {
    // `console.error` com prefixo estável e único: é ISTO que uma regra de
    // alerta em cima dos logs da função deve casar. Um `warn` genérico se
    // perde no ruído — foi exatamente o que escondeu o defeito anterior.
    console.error(
      '[ALERT][resolve-driver-code] RATE_LIMIT_UNAVAILABLE',
      JSON.stringify({ window: windowName, message: error.message }),
    );
    return 'unavailable';
  }
  return data === false ? 'exceeded' : 'allowed';
}

/**
 * Sonda de PARTIDA: prova, uma vez por instância, que a RPC de rate limit
 * existe e responde. Enquanto ela não passar, a função não serve nada.
 *
 * Por que uma sonda e não só a falha-fechada por requisição: a falha-fechada já
 * cobre o caso, mas a sonda torna o RISCO DE ORDEM DE DEPLOY estrutural e
 * visível — a instância anuncia no log, na primeira requisição, que está
 * inservível porque a migration não foi aplicada, em vez de espalhar o mesmo
 * erro por dentro de cada lookup.
 *
 * Ela usa uma janela própria com teto altíssimo para não consumir cota real; o
 * que interessa é se a chamada ERRA ou não. O resultado é memorizado por
 * instância enquanto for sucesso; um fracasso NÃO é memorizado, para que a
 * instância volte a servir sozinha assim que a migration for aplicada.
 */
let readyProbe: Promise<boolean> | null = null;

async function rateLimiterReady(admin: RpcCaller): Promise<boolean> {
  if (readyProbe) return readyProbe;
  const probe = (async () => {
    let error: { message: string } | null;
    try {
      // Mesmo estreitamento de `checkWindow`: a sonda não pode deixar uma
      // exceção de rede subir até o catch do handler, que responde 200.
      ({ error } = await admin.rpc('check_public_lookup_rate_limit', {
        p_bucket_key:     'startup-probe',
        p_function_name:  'resolve-driver-code:probe',
        p_max_requests:   1_000_000_000,
        p_window_seconds: 3600,
      }));
    } catch (e) {
      console.error(
        '[ALERT][resolve-driver-code] STARTUP_PROBE_THREW',
        JSON.stringify({ message: (e as Error)?.message ?? String(e) }),
      );
      readyProbe = null;
      return false;
    }
    if (error) {
      console.error(
        '[ALERT][resolve-driver-code] STARTUP_PROBE_FAILED',
        JSON.stringify({
          message: error.message,
          hint: 'check_public_lookup_rate_limit ausente? aplique a migration 0067 ANTES de implantar esta função.',
        }),
      );
      readyProbe = null; // não memoriza fracasso: reavalia na próxima requisição
      return false;
    }
    return true;
  })();
  readyProbe = probe;
  return probe;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: JSON_HEADERS,
    });
  }

  // Resposta padrão para TODO caminho de "não resolvido" — indistinguível
  // entre código malformado, inexistente e de passageiro.
  const notFound = () => new Response(JSON.stringify({ driver: null }), { headers: JSON_HEADERS });

  /** Controle indisponível → não serve. Ver `checkWindow`. */
  const unavailable = () =>
    new Response(JSON.stringify({ error: 'Service unavailable', code: 'RATE_LIMIT_UNAVAILABLE' }), {
      status: 503, headers: { ...JSON_HEADERS, 'Retry-After': '30' },
    });

  const tooMany = (retryAfterSeconds: number) =>
    new Response(JSON.stringify({ error: 'Too many requests', code: 'RATE_LIMITED' }), {
      status: 429, headers: { ...JSON_HEADERS, 'Retry-After': String(retryAfterSeconds) },
    });

  try {
    const body = await req.json().catch(() => ({})) as { driver_code?: unknown };

    // 1) Guarda de formato — antes de qualquer I/O e antes do rate limit, para
    //    que varredura com lixo não consuma nem banco nem bucket. O alfabeto é
    //    o CANÔNICO (guard.ts), igual ao do client: o servidor é a fronteira de
    //    confiança e não pode ser mais frouxo do que ela.
    const code = normalizeServerDriverCode(body.driver_code);
    if (!code) return notFound();

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // 2) Sonda de partida: sem rate limiter provado, este endpoint público não
    //    abre. Torna o risco de ORDEM DE DEPLOY (função antes da 0067)
    //    estrutural em vez de silencioso.
    if (!(await rateLimiterReady(admin))) return unavailable();

    const source: BucketSource = bucketSourceFromHeaders((n) => req.headers.get(n), {
      trustSingleValueHeaders: TRUST_SINGLE_VALUE_HEADERS,
    });
    const bucketKey = await hashBucket(source.value);

    // 2.1) Telemetria da distribuição de origens. É ISTO que responde, pelos
    //      logs de produção, a pergunta que nenhum teste consegue responder:
    //      "os headers que `guard.ts` supõe chegam mesmo?". Uma fração alta de
    //      `shared-fallback` significa que NÃO — e que as janelas por origem
    //      não estão limitando ninguém em particular.
    const mix = bucketKindTelemetry.record(source.kind);
    if (mix) {
      const line = JSON.stringify({
        sample: mix.sample,
        counts: mix.counts,
        sharedFallbackRatio: Number(mix.sharedFallbackRatio.toFixed(3)),
        trustSingleValueHeaders: TRUST_SINGLE_VALUE_HEADERS,
      });
      if (mix.alert) {
        // Prefixo estável para regra de alerta. Ver `SHARED_FALLBACK_ALERT_RATIO`.
        console.error('[ALERT][resolve-driver-code] BUCKET_SOURCE_MIX_DEGRADED', line);
      } else {
        console.log('[resolve-driver-code] BUCKET_SOURCE_MIX', line);
      }
    }

    // 3) Rate limit nas TRÊS janelas. Sequencial de propósito: a primeira que
    //    barrar evita o custo das seguintes.
    //
    //    O balde COMPARTILHADO tem orçamento próprio: ele não é uma origem, é
    //    "todas as origens que não deu para separar". Aplicar nele o teto de um
    //    indivíduo transformava qualquer atacante numa alavanca de negação de
    //    serviço global — ver `SHARED_FALLBACK_SHORT_MAX`.
    //
    // ── A GLOBAL É A ÚLTIMA, E ISSO MUDOU (iteração 5) ────────────────────────
    // Ela vinha PRIMEIRA, com a justificativa de ser a única que não depende de
    // suposição sobre headers de proxy. A justificativa está certa e a ordem
    // estava errada, porque contar primeiro significa contar TAMBÉM o que as
    // janelas por origem iam recusar. Com `GLOBAL_WINDOW_MAX = 300` por 60 s, um
    // único atacante gastava a cota do endpoint INTEIRO a 5 req/s — requisições
    // que a janela curta (8/min por origem) teria recusado na 9ª — e negava o
    // Cadastro Expresso a todo mundo, no mundo todo, por uma linha de shell.
    // O controle contra enumeração virava o gatilho de negação de serviço.
    //
    // Invertida a ordem, a janela global só conta o que JÁ passou por um
    // controle por origem. O mesmo atacante, de uma origem identificável,
    // contribui com no máximo 8/min para os 300 — precisaria de ~38 origens
    // distintas para o mesmo estrago que antes custava uma.
    //
    // ⚠️ RESIDUAL, e é honesto nomear: no regime `shared-fallback` (headers
    // assumidos não chegam) todo o tráfego cai num balde só, com teto de 240/min
    // — abaixo dos 300 globais, então nesse regime a inversão não protege muita
    // coisa. Quem responde se estamos nesse regime é a telemetria
    // `BUCKET_SOURCE_MIX` acima, e o número a mudar então não é nenhum destes
    // tetos: é a suposição de headers de `guard.ts`.
    const isShared = source.kind === 'shared-fallback';
    const shortMax = isShared ? SHARED_FALLBACK_SHORT_MAX : SHORT_WINDOW_MAX;
    const longMax  = isShared ? SHARED_FALLBACK_LONG_MAX  : LONG_WINDOW_MAX;

    const windows: Array<[string, number, number]> = [
      [bucketKey,         shortMax,          SHORT_WINDOW_SECONDS],
      [bucketKey,         longMax,           LONG_WINDOW_SECONDS],
      [GLOBAL_BUCKET_KEY, GLOBAL_WINDOW_MAX, GLOBAL_WINDOW_SECONDS],
    ];
    const names = ['resolve-driver-code:short', 'resolve-driver-code:long', 'resolve-driver-code:global'];

    for (let i = 0; i < windows.length; i++) {
      const [key, max, seconds] = windows[i];
      const verdict = await checkWindow(admin, key, names[i], max, seconds);
      if (verdict === 'unavailable') return unavailable();
      if (verdict === 'exceeded') {
        // Log da ORIGEM da chave (nunca o IP, nunca o hash): é o que permite a
        // um humano descobrir se a suposição de `TRUSTED_PROXY_HOPS` está certa
        // — um pico de `shared-fallback` significa que o header assumido não
        // chega, e um pico só na janela `:global` significa que a chave por
        // origem está sendo evadida.
        console.warn(
          '[resolve-driver-code] RATE_LIMITED',
          JSON.stringify({ window: names[i], bucketSource: source.kind, header: source.header }),
        );
        return tooMany(seconds);
      }
    }

    // 4) Lookup com service_role, em `profiles` direto (não na view): SÓ as
    //    duas colunas que a tela usa, e SÓ se o perfil for de motorista.
    //
    //    `order + limit(1)` e NÃO `.maybeSingle()`: até a 0069 não havia
    //    UNIQUE em `profiles.driver_code` (a 0007:6 cria um índice comum), e
    //    `codeFromId` joga um UUID de 128 bits em 32^6 ≈ 2^30 códigos — colisão
    //    é possível, não impossível. Com `.maybeSingle()`, a PRIMEIRA colisão
    //    fazia o PostgREST devolver erro e o Cadastro Expresso quebrava para os
    //    DOIS motoristas, devolvendo `{driver:null}` sem nenhum sinal. Agora
    //    resolve de forma determinística (menor `id`) e loga o fato.
    const { data, error } = await admin
      .from('profiles')
      .select('id, full_name')
      .eq('driver_code', code)
      .eq('type', 'driver')
      .order('id', { ascending: true })
      .limit(2);

    // Erro de BANCO não é veredito sobre o código. `notFound()` aqui fazia o
    // client dizer "Código inválido — peça um novo ao motorista" quando o que
    // aconteceu foi PostgREST fora do ar, pool esgotado ou a coluna ausente
    // (0069 não aplicada). O passageiro descartava um QR perfeito, na frente do
    // motorista, e a única ação que resolvia — tentar de novo em alguns
    // segundos — sumia da tela. `DriverCodeLookup.unavailable`
    // (src/lib/driverCode.ts) existe exatamente para este desfecho.
    //
    // Isto NÃO reabre o oráculo de enumeração: 503 aqui não distingue código
    // existente de inexistente — depende só da saúde do banco, que é a mesma
    // para os dois. O `notFound()` indistinguível continua valendo para todo
    // caminho que teve veredito de verdade.
    if (error) {
      console.error(
        '[ALERT][resolve-driver-code] LOOKUP_FAILED',
        JSON.stringify({ message: error.message }),
      );
      return unavailable();
    }

    const rows = (data ?? []) as { id: string; full_name: string | null }[];
    if (rows.length === 0) return notFound();
    if (rows.length > 1) {
      // Alertável: significa que a 0069 não foi aplicada (ou foi aplicada com
      // duplicatas pré-existentes) e dois motoristas dividem um código de QR.
      console.error('[ALERT][resolve-driver-code] DRIVER_CODE_COLLISION', JSON.stringify({ code }));
    }

    const driver = rows[0];
    return new Response(
      JSON.stringify({ driver: { id: driver.id, full_name: driver.full_name ?? '' } }),
      { headers: JSON_HEADERS },
    );
  } catch (e) {
    // Mesmo raciocínio do `if (error)` do lookup: NADA que chegue aqui é um
    // veredito sobre o código. A entrada malformada já foi consumida antes —
    // `req.json()` tem `.catch()` próprio e `normalizeServerDriverCode` é uma
    // regex pura sobre `unknown`, que devolve `null` em vez de lançar. O que
    // sobra para este catch é exceção de infraestrutura (rede até o PostgREST,
    // TLS, AbortError) ou bug nosso; nos dois casos a resposta honesta é "não
    // sei", não "o código é inválido".
    console.error(
      '[ALERT][resolve-driver-code] UNEXPECTED_ERROR',
      JSON.stringify({ message: (e as Error)?.message ?? String(e) }),
    );
    return unavailable();
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// O QUE NÃO FOI MEDIDO — e o comando exato que mede
// ═════════════════════════════════════════════════════════════════════════════
//
// 1) COMPORTAMENTO DO GATEWAY COM `X-Forwarded-For`. Esta é a suposição que
//    sustenta as janelas `:short` e `:long`, e ela NÃO é observável de dentro
//    do repositório — só contra a função IMPLANTADA. Para medir, implante uma
//    vez com este `console.log` temporário no topo do handler:
//
//        console.log('XFF', JSON.stringify({
//          xff:  req.headers.get('x-forwarded-for'),
//          real: req.headers.get('x-real-ip'),
//          cf:   req.headers.get('cf-connecting-ip'),
//        }));
//
//    e chame de fora forjando um valor conhecido EM CADA UM dos três headers
//    (forjar só o XFF não responde nada sobre os outros dois — foi esse o furo
//    da iteração 3):
//
//        curl -s -X POST "$SUPABASE_URL/functions/v1/resolve-driver-code" \
//          -H "Content-Type: application/json" \
//          -H "X-Forwarded-For: 203.0.113.99" \
//          -H "X-Real-IP: 203.0.113.98" \
//          -H "CF-Connecting-IP: 203.0.113.97" \
//          -d '{"driver_code":"ZZZZZZ"}'
//
//    LEITURA DO RESULTADO — `xff`:
//      • `xff: "203.0.113.99, <ip real>"`  → o gateway APENDA;
//        `TRUSTED_PROXY_HOPS = 1` está CORRETO.
//      • `xff: "<ip real>"`                → o gateway SOBRESCREVE;
//        `TRUSTED_PROXY_HOPS = 1` está CORRETO.
//      • `xff: "<a, b, ip real>"` com 3 elementos e só o último real → são 2
//        saltos que apendam: `TRUSTED_PROXY_HOPS` tem de virar 2. Ver as DUAS
//        direções de erro em `guard.ts`.
//      • `xff: "203.0.113.99"` e nada mais → o gateway REPASSA sem tocar; a
//        chave por origem é forjável e SÓ a janela `:global` vale. Nesse caso,
//        baixe `GLOBAL_WINDOW_MAX` e force `SHARED_FALLBACK_BUCKET`.
//
//    LEITURA DO RESULTADO — `real` / `cf` (a pergunta que ficou EM ABERTO):
//      • vierem `203.0.113.98` / `203.0.113.97` — os valores QUE EU MANDEI —
//        então o gateway REPASSA esses headers e eles são lixo forjável.
//        MANTENHA `GOXL_TRUST_SINGLE_VALUE_IP_HEADERS` desligado. Era este o
//        cenário em que a iteração 3 ficava sem NENHUMA janela por origem.
//      • vier o IP real (diferente do que mandei) → o gateway SOBRESCREVE, o
//        header é confiável, e só então vale ligar:
//            npx supabase secrets set GOXL_TRUST_SINGLE_VALUE_IP_HEADERS=1
//      • não vier nada → não existem neste gateway; deixe desligado.
//
//    ENQUANTO NINGUÉM RODAR ISSO, o estado de fábrica é: headers de valor único
//    IGNORADOS, chave só do XFF ancorado à direita, e `:global` como a única
//    janela que não depende de suposição nenhuma.
//
// 1b) SEM DEPLOY EXTRA: a linha `BUCKET_SOURCE_MIX` já sai no log de produção a
//     cada 200 requisições, com a fração que caiu em `shared-fallback`. Fração
//     alta = os headers supostos NÃO chegam. É a mesma medição, de graça.
//
// 2) QUE A FALHA-FECHADA DE FATO DEVOLVE 503. Verificável só com a função
//    implantada e a 0067 NÃO aplicada (ou com a RPC renomeada num clone de
//    staging). Esperado: HTTP 503 + `{"code":"RATE_LIMIT_UNAVAILABLE"}` e a
//    linha `[ALERT][resolve-driver-code] STARTUP_PROBE_FAILED` no log.
//
// 3) QUE AS TRÊS JANELAS CONTAM. Exige Postgres. Comando no rodapé da 0067.
//
// Nada disto é provável por teste unitário: um teste que mocasse a RPC estaria
// afirmando o próprio mock. O que É testado em `__tests__/guard.test.ts` é a
// parte pura e determinística — formato aceito e de qual elemento do header a
// chave sai —, que é código real, não simulação.
