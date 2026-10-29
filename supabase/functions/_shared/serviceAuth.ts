// AUTORIZAÇÃO de chamadas service-role, PURA e testável — sem I/O, sem globais
// do Deno (mesmo padrão de _shared/payout.ts, _shared/chargeCycle.ts e
// _shared/staleRideSweep.ts: roda igual na Edge Function e no Jest do app).
//
// ─────────────────────────────────────────────────────────────────────────────
// O BURACO QUE ISTO FECHA
// ─────────────────────────────────────────────────────────────────────────────
// A checagem de service-role em uso no repositório DECODIFICA o JWT e lê o
// campo `role`:
//
//     const payload = token.split('.')[1];
//     JSON.parse(atob(payload)).role === 'service_role'
//
// `atob` não verifica assinatura NENHUMA — é base64, não criptografia. A única
// coisa que tornava essa checagem defensável era a premissa de que o gateway do
// Supabase já tinha validado a assinatura antes de a requisição chegar aqui. Mas
// o hábito da casa é publicar as funções com `--no-verify-jwt`
// (refund-ride:31, dispatch-engine:22, run-weekly-payouts:25, tip-ride:3,
// send-ride-push:19), e com essa flag o gateway NÃO valida assinatura alguma.
//
// Com as duas coisas juntas, qualquer pessoa monta
//
//     Authorization: Bearer x.<base64 de {"role":"service_role"}>.x
//
// e passa. Numa função que estorna cobranças, isso é dinheiro saindo da conta a
// pedido de um desconhecido, em lote e repetível.
//
// ─────────────────────────────────────────────────────────────────────────────
// POR QUE COMPARAR COM A CHAVE, E NÃO VALIDAR A ASSINATURA AQUI
// ─────────────────────────────────────────────────────────────────────────────
// O chamador destas funções agendadas NÃO é um usuário: é o cron do Postgres
// mandando a `service_role_key` lida do Vault (0035, 0068). O segredo já está
// nos dois lados. Comparar o token recebido com `SUPABASE_SERVICE_ROLE_KEY` é
// exatamente a pergunta que importa — "quem chamou tem a chave?" — e ela é
// respondida CORRETAMENTE tanto com `--no-verify-jwt` quanto sem, que é o ponto:
// a autorização deixa de depender de uma flag de deploy invisível no código.
//
// De quebra, funciona igual para o formato legado (`eyJ...`, um JWT) e para o
// formato novo de chave do Supabase (`sb_secret_...`, que não é JWT nenhum e
// para o qual a decodificação de payload acima simplesmente não faz sentido).
//
// LIMITE CONHECIDO, declarado: isto autentica "o chamador tem a chave de
// serviço", não "o chamador é o cron". Qualquer coisa que já tenha a
// service_role_key também passa — mas essa coisa já podia escrever direto no
// banco, então não há escalada de privilégio nenhuma nisso.

/**
 * Comparação de strings em TEMPO CONSTANTE em relação ao conteúdo.
 *
 * `a === b` em JS sai no primeiro byte diferente, e a diferença de tempo entre
 * "errou no primeiro caractere" e "errou no último" vaza o segredo byte a byte
 * para quem consiga medir. Aqui todo o laço roda sempre, sobre o MAIOR dos dois
 * comprimentos, acumulando as diferenças em XOR.
 *
 * O comprimento em si não é escondido (`a.length !== b.length` entra no
 * acumulador em vez de sair cedo) — e não precisa ser: o tamanho da chave de
 * serviço do Supabase é público.
 *
 * Comparamos por CÓDIGO DE UNIDADE (`charCodeAt`) e não por byte de UTF-8: as
 * chaves do Supabase são ASCII, e `charCodeAt` de uma posição fora da string é
 * `NaN`, que estragaria o XOR — por isso o `|| 0`.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  // `diff` já começa carregando a diferença de comprimento: sem isto, 'abc' e
  // 'abc\0' (que dão charCode 0 na posição extra) colidiriam.
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** Tira o prefixo `Bearer ` (case-insensitive) e os espaços das pontas. */
export function bearerToken(authorizationHeader: string | null | undefined): string {
  return (authorizationHeader ?? '').replace(/^Bearer\s+/i, '').trim();
}

/**
 * O chamador apresentou a CHAVE DE SERVIÇO deste projeto?
 *
 * Uma chave configurada vazia (env ausente na Edge Function) devolve `false`
 * para QUALQUER token, inclusive o token vazio — o contrário transformaria um
 * segredo não configurado em "todo mundo é service-role", que é o pior desfecho
 * possível de um erro de configuração.
 */
export function isServiceRoleCaller(
  authorizationHeader: string | null | undefined,
  serviceRoleKey: string | null | undefined,
): boolean {
  const key = (serviceRoleKey ?? '').trim();
  if (key.length === 0) return false;

  const token = bearerToken(authorizationHeader);
  if (token.length === 0) return false;

  return timingSafeEqual(token, key);
}
