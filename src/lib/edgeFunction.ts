import { supabase } from './supabase';
import { withTimeout } from './withTimeout';

/**
 * Chamada autenticada e com timeout às Supabase Edge Functions.
 *
 * Por que existe:
 *   O `supabase.functions.invoke` não tem timeout — em rede instável a tela
 *   fica girando para sempre (mesmo problema que resolvemos na lista de
 *   cartões). Este helper anexa o JWT da sessão e envolve tanto a leitura da
 *   sessão quanto o fetch em `withTimeout`, o padrão do projeto para evitar
 *   estados de carregamento infinitos.
 */

// Mesmo fallback embutido de lib/supabase.ts: se a env EXPO_PUBLIC_* não for
// injetada no build, não montamos uma URL quebrada ("/functions/v1/...").
const SUPABASE_URL =
  process.env.EXPO_PUBLIC_SUPABASE_URL?.trim() || 'https://zukydkodafdmhaulhxeh.supabase.co';

const DEFAULT_TIMEOUT_MS = 15000;
const SESSION_TIMEOUT_MS = 10000;

export function functionUrl(name: string): string {
  return `${SUPABASE_URL}/functions/v1/${name}`;
}

/**
 * Erro de Edge Function que PRESERVA o `code` estruturado devolvido pelo
 * servidor (ex.: 'KYC_PENDING', 'PAYOUT_IN_PROGRESS'). Sem isto o app só teria a
 * mensagem em texto e não poderia ramificar/localizar por código — era a razão
 * de o repasse mostrar sempre um erro genérico.
 */
export class EdgeFunctionError extends Error {
  code?: string;
  status: number;
  constructor(message: string, code: string | undefined, status: number) {
    super(message);
    this.name = 'EdgeFunctionError';
    this.code = code;
    this.status = status;
  }
}

export async function callEdgeFunction<T>(
  name: string,
  body: Record<string, unknown> = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const { data: { session } } = await withTimeout(
    supabase.auth.getSession(),
    SESSION_TIMEOUT_MS,
    'Não foi possível confirmar sua sessão. Tente novamente.',
  );
  if (!session) throw new Error('Sessão expirada. Faça login novamente.');

  const res = await withTimeout(
    fetch(functionUrl(name), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(body),
    }),
    timeoutMs,
    'Não foi possível conectar. Verifique sua conexão e tente novamente.',
  );

  const json = (await res.json()) as T & { error?: string; code?: string };
  if (!res.ok || json.error) {
    throw new EdgeFunctionError(
      json.error ?? 'Algo deu errado. Tente novamente.',
      json.code,
      res.status,
    );
  }
  return json;
}
