/**
 * Driver code (QR) — formato canônico e resolução PRÉ-AUTENTICAÇÃO.
 *
 * ── Por que este módulo existe (segurança) ────────────────────────────────
 * Até a migration 0067, um passageiro SEM conta resolvia o código do QR lendo
 * a view `public.profiles_public` direto pelo PostgREST, com a anon key que
 * vai embutida no binário (src/lib/supabase.ts:21). Essa view é
 * `security_invoker = off`, ou seja, ignora a RLS de `profiles`: quem tivesse
 * a chave conseguia `GET /rest/v1/profiles_public?select=*` e baixar
 * `id, full_name, avatar_url, rating, type, driver_code` de TODO usuário do
 * app — um diretório completo, mais a credencial de QR de todo motorista.
 *
 * A 0067 revoga `anon` dessa view. O único consumidor legítimo pré-login (o
 * Cadastro Expresso) passa a ir pela Edge Function `resolve-driver-code`
 * (verify_jwt = false), que roda com service_role, aceita SÓ um código e
 * devolve SÓ `{ id, full_name }` de um perfil `type = 'driver'` — nunca uma
 * listagem.
 *
 * ── Pureza / testabilidade ────────────────────────────────────────────────
 * `DRIVER_CODE_RE` e `normalizeDriverCode` são PUROS e não importam nada, para
 * continuarem testáveis no jest sem módulos nativos. `resolveDriverCode` fala
 * com a rede e por isso importa `./edgeFunction` de forma PREGUIÇOSA, dentro
 * da função — mesmo padrão já usado em `deferredDeepLink.ts` com
 * `expo-clipboard`. Sem isso, o import de `supabase.ts` arrastaria
 * `@react-native-async-storage/async-storage` para dentro do jest e quebraria
 * a suíte (é exatamente o modo de falha de scheduleConflict.test.ts).
 */

/**
 * Charset canônico dos códigos de QR: Crockford-ish, SEM I, O, 0 e 1 (evita
 * ambiguidade quando alguém digita o código à mão).
 *
 * ── UMA definição, não três (correção da iteração 4) ──────────────────────
 * Até aqui este literal existia em TRÊS arquivos: neste, em
 * `supabase/functions/resolve-driver-code/guard.ts` e — o que mais importava —
 * dentro de `codeFromId`, em `QRCodeScreen.tsx`, que é a única função que
 * ESCREVE `profiles.driver_code`. As duas primeiras cópias eram comparadas por
 * teste; a do ESCRITOR não era comparada com ninguém. Ou seja, a única cópia
 * que podia divergir em silêncio e emitir um código que o servidor rejeita era
 * exatamente a que ninguém vigiava.
 *
 * `codeFromId` mudou de casa para cá e passou a usar esta constante. Restam
 * duas cópias, não três, e a que sobra (guard.ts) é obrigatória — a Edge
 * Function roda em Deno e não importa de `src/` — e é comparada com esta em
 * `supabase/functions/resolve-driver-code/__tests__/guard.test.ts`.
 */
export const DRIVER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Formato canônico: 6 caracteres do alfabeto acima. */
export const DRIVER_CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

/** Quantas tentativas com sal antes de desistir. Ver `codeFromId`. */
export const MAX_CODE_ATTEMPTS = 8;

/**
 * Deriva o código de 6 caracteres do QR a partir do UUID do motorista.
 *
 * É a ÚNICA função que produz o valor gravado em `profiles.driver_code`
 * (src/screens/driver/QRCodeScreen.tsx). Mora aqui, e não na tela, por dois
 * motivos: elimina a terceira cópia do alfabeto, e torna a função testável —
 * importar a tela no Jest arrastaria `react-native-qrcode-svg` e o
 * AsyncStorage, que é o modo de falha de `scheduleConflict.test.ts`.
 *
 * ── NÃO É ÚNICA ───────────────────────────────────────────────────────────
 * O JSDoc original afirmava "Único porque UUIDs são únicos". Falso: a função
 * lê 6 bytes do UUID e aplica `byte % 32` em cada um — 128 bits de entrada
 * mapeados em 32^6 ≈ 2^30 saídas, ~98 bits DESCARTADOS. Unicidade da entrada
 * não sobrevive a uma função que não é injetiva. Pelo paradoxo do aniversário,
 * ~1.000 motoristas já dão ~0,05% de chance de colisão; ~10.000 dão ~4,5%.
 * Quem garante unicidade é o índice único da migration 0069 (seção C.2).
 *
 * ── O SAL ─────────────────────────────────────────────────────────────────
 * `attempt = 0` reproduz EXATAMENTE o algoritmo anterior — mesma janela de
 * bytes (índices 0..5), deslocamento zero. Isso não é detalhe: todo QR já
 * impresso continua resolvendo. `driverCode.test.ts` fixa vetores literais
 * para que essa propriedade não possa ser quebrada sem quebrar um teste.
 *
 * `attempt > 0` desliza a janela para bytes do UUID que a versão original
 * ignorava (ela usava só os 6 primeiros de 16) e soma um deslocamento dentro
 * do alfabeto. NÃO existe prova de que duas tentativas nunca coincidam — é uma
 * função de 32^6 saídas, então duas tentativas COLIDIREM é improvável, não
 * impossível (ver o teste). Se coincidirem, o custo é uma tentativa
 * desperdiçada: o `update` bate no mesmo 23505 e o laço segue para a próxima.
 */
export function codeFromId(id: string, attempt = 0): string {
  const hex = id.replace(/-/g, '');
  const bytes = hex.length / 2;
  let result = '';
  for (let i = 0; i < 6; i++) {
    const index = (i + attempt) % bytes;
    const byte = parseInt(hex.substring(index * 2, index * 2 + 2), 16);
    result += DRIVER_CODE_ALPHABET[(byte + attempt * (i + 1)) % DRIVER_CODE_ALPHABET.length];
  }
  return result;
}

/**
 * Normaliza um código vindo de qualquer origem não confiável (query string de
 * deep link, clipboard, install referrer) e devolve `null` se ele não estiver
 * no formato canônico.
 *
 * Normalizar aqui também conserta um bug latente do caminho de deep link: o
 * `AppNavigator` lia `parsed.queryParams?.driver` CRU e comparava com
 * `driver_code` no banco, que é case-sensitive — um link com o código em
 * minúsculas nunca casava.
 */
export function normalizeDriverCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const code = String(raw).trim().toUpperCase();
  return DRIVER_CODE_RE.test(code) ? code : null;
}

/** Identidade mínima de um motorista, devolvida pela Edge Function. */
export type ResolvedDriver = { id: string; full_name: string };

/**
 * Desfecho de uma resolução de código.
 *
 * ── Por que não é mais `ResolvedDriver | null` ────────────────────────────
 * Era, e o `null` colapsava dois desfechos que não têm nada em comum:
 *   • o código não existe / não é de motorista  → culpa do código;
 *   • a chamada não chegou a uma resposta (rede caída, timeout, 429 do rate
 *     limit, 503 do disjuntor do rate limiter)  → culpa nossa, e passageira.
 *
 * O `ExpressRegisterScreen` mostrava "Código inválido — peça um novo ao
 * motorista" nos DOIS casos. No segundo isso é falso e caro: manda o
 * passageiro descartar um QR que está perfeito, na frente do motorista, e some
 * com a única ação que resolveria (esperar alguns segundos e tentar de novo).
 * O 429 é o caso mais provável de todos, porque a função é pública e o teto
 * curto por origem é 8/min — uma família chegando junto no mesmo Wi-Fi de
 * hotel já basta.
 */
export type DriverCodeLookup =
  | { status: 'ok'; driver: ResolvedDriver }
  /** Formato inválido, código desconhecido, ou perfil que não é motorista. */
  | { status: 'not_found' }
  /** Não houve veredito: rede, timeout, 429 ou 5xx. Tentar de novo faz sentido. */
  | { status: 'unavailable' };

/**
 * Resolve um driver code para `{ id, full_name }` via Edge Function pública.
 *
 * Funciona COM ou SEM sessão — de propósito. O Cadastro Expresso chama isto
 * antes de `signUp()` (não há JWT nenhum), e o deep link de usuário já logado
 * chama depois. Usar o mesmo caminho nos dois casos remove qualquer
 * dependência de "a sessão já assentou?" no cold start.
 *
 * Distingue `not_found` de `unavailable` — ver `DriverCodeLookup`. Nenhum dos
 * dois vaza o erro bruto para a tela; o que muda é qual mensagem o chamador
 * tem direito de mostrar.
 *
 * `call` existe para o teste, e o motivo NÃO é estilo. O import preguiçoso de
 * `./edgeFunction` é a única forma de manter este módulo importável no jest
 * (senão `lib/supabase` arrasta o AsyncStorage), mas `await import()` LANÇA
 * dentro do jest-expo — "A dynamic import callback was invoked without
 * --experimental-vm-modules". Consequência: sem injeção, todo teste desta
 * função cairia no `catch` e "passaria" provando só o caminho de erro. É o
 * mesmo padrão de `TravelMinResolver` em scheduleConflict.ts:100, que existe
 * por esta mesma razão.
 */
export type PublicEdgeCaller = <T>(name: string, body: Record<string, unknown>) => Promise<T>;

const callViaEdgeFunction: PublicEdgeCaller = async (name, body) => {
  // Import preguiçoso: ver nota de pureza no topo do arquivo.
  const { callPublicEdgeFunction } = await import('./edgeFunction');
  return callPublicEdgeFunction(name, body);
};

export async function resolveDriverCode(
  raw: string | null | undefined,
  call: PublicEdgeCaller = callViaEdgeFunction,
): Promise<DriverCodeLookup> {
  const code = normalizeDriverCode(raw);
  if (!code) return { status: 'not_found' };

  try {
    const json = await call<{ driver: ResolvedDriver | null }>(
      'resolve-driver-code',
      { driver_code: code },
    );
    const driver = json?.driver ?? null;
    // 200 com `driver: null` é o veredito de "não achei" da função
    // (`notFound()`, index.ts:339). Aqui é `not_found` de verdade.
    if (!driver || typeof driver.id !== 'string' || !driver.id) return { status: 'not_found' };
    return {
      status: 'ok',
      driver: { id: driver.id, full_name: typeof driver.full_name === 'string' ? driver.full_name : '' },
    };
  } catch {
    // TODO caminho de exceção aqui é falha nossa, nunca veredito sobre o
    // código: `resolve-driver-code` responde 200 `{driver:null}` até para
    // código malformado (index.ts:339 `notFound()`, deliberadamente
    // indistinguível). O que cai neste `catch` é timeout do `withTimeout`,
    // rede caída, 429 `RATE_LIMITED`, 503 `RATE_LIMIT_UNAVAILABLE` ou 5xx.
    return { status: 'unavailable' };
  }
}
