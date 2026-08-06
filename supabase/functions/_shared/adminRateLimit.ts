// Rate limit compartilhado pelas 3 Edge Functions administrativas
// (admin-driver-verification, admin-commission-tiers, admin-waybills) —
// Item 9 (admin/backend), sub-item 1.
//
// Por que aqui e não em cada função: mesmo limite/mesma forma de checar nas
// 3, então fica num módulo único (padrão do projeto — ver _shared/payout.ts,
// _shared/tripShare.ts). Diferente dos outros módulos de _shared, este faz
// I/O (chama a função SQL check_admin_rate_limit via RPC), porque o estado do
// contador PRECISA sobreviver entre invocações da Edge Function — não dá pra
// manter isso em memória (ver migration 0051_admin_rate_limit.sql).
//
// Uso típico dentro de uma Edge Function, logo após confirmar is_admin:
//   const limited = await checkAdminRateLimit(admin, user.id, 'admin-waybills');
//   if (!limited.allowed) return json({ error: limited.message }, 429);

// deno-lint-ignore no-explicit-any
type SupabaseClientLike = { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: any; error: any }> };

export interface RateLimitResult {
  allowed: boolean;
  message: string;
}

/** Limite padrão: 30 requisições por admin por função a cada 60s. Um painel
 * administrativo interno não deveria chegar nem perto disso em uso normal —
 * o valor está aqui pra barrar loop/bug/abuso, não pra restringir uso legítimo. */
export const DEFAULT_MAX_REQUESTS = 30;
export const DEFAULT_WINDOW_SECONDS = 60;

export async function checkAdminRateLimit(
  client: SupabaseClientLike,
  adminId: string,
  functionName: string,
  maxRequests: number = DEFAULT_MAX_REQUESTS,
  windowSeconds: number = DEFAULT_WINDOW_SECONDS,
): Promise<RateLimitResult> {
  const { data, error } = await client.rpc('check_admin_rate_limit', {
    p_admin_id: adminId,
    p_function_name: functionName,
    p_max_requests: maxRequests,
    p_window_seconds: windowSeconds,
  });

  if (error) {
    // Falha ao checar o limite (ex.: função SQL indisponível) não deve
    // derrubar a função admin inteira — loga a intenção via retorno
    // permissivo. O contrário (bloquear tudo se o RPC falhar) transformaria
    // uma proteção de abuso num ponto único de indisponibilidade.
    return { allowed: true, message: '' };
  }

  if (data === false) {
    return {
      allowed: false,
      message: 'Limite de requisições excedido. Aguarde um minuto e tente novamente.',
    };
  }

  return { allowed: true, message: '' };
}
