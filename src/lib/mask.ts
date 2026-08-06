// mask — utilitários PUROS de mascaramento de PII (dados pessoais sensíveis).
//
// Duas frentes:
//   • Exibição: maskEmail/maskPhone/maskName para mostrar o mínimo de um
//     contato de terceiros (ex.: suporte vendo dados de um usuário) sem expor
//     o dado inteiro.
//   • Telemetria: scrubPII redige/mascar campos sensíveis de um objeto ANTES de
//     ele ir para logs/monitoramento de falhas — nunca vazar PII para telemetria.
//
// Sem dependências de RN/Supabase → testável em unidade e reutilizável em
// qualquer camada (transversal).

/** Mascara um e-mail mantendo só a 1ª letra do local-part e o domínio. */
export function maskEmail(email: string): string {
  const s = String(email ?? '').trim();
  const at = s.indexOf('@');
  if (at <= 0) return s ? '•••' : '';
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  const head = local[0];
  return `${head}${'•'.repeat(Math.max(2, local.length - 1))}@${domain}`;
}

/** Mascara um telefone mantendo apenas os 2 últimos dígitos. */
export function maskPhone(phone: string): string {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length === 0) return '';
  if (digits.length <= 2) return '•'.repeat(digits.length);
  return `${'•'.repeat(digits.length - 2)}${digits.slice(-2)}`;
}

/** Reduz um nome a "Primeiro I." (primeiro nome + iniciais dos demais). */
export function maskName(name: string): string {
  const parts = String(name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  const first = parts[0];
  const initials = parts.slice(1).map((p) => `${p[0].toUpperCase()}.`).join(' ');
  return `${first} ${initials}`;
}

// Chaves cujo VALOR nunca deve aparecer em log/telemetria (segredo puro).
const SENSITIVE_KEY = /(pass(word)?|token|secret|ssn|cpf|cnpj|card|cvv|cvc|pin|authorization|api[_-]?key|access[_-]?key|client[_-]?secret)/i;
// Chaves de PII que podem ser MASCARADAS (mostra o mínimo) em vez de redigidas.
const EMAIL_KEY = /(e[-_]?mail)/i;
const PHONE_KEY = /(phone|telefone|celular|mobile|whatsapp)/i;
const NAME_KEY = /(full[_-]?name|nome|first[_-]?name|last[_-]?name|passenger[_-]?name|driver[_-]?name)/i;
const OTHER_PII_KEY = /(address|endereco|birth|dob|geo|lat|lng|latitude|longitude)/i;

const REDACTED = '[redacted]';
const MAX_DEPTH = 6;

/**
 * scrubPII — devolve uma cópia do valor com campos sensíveis redigidos e PII
 * mascarada, segura para logar/enviar a telemetria. Nunca lança; corta em
 * profundidade para evitar estruturas cíclicas/gigantes.
 */
export function scrubPII<T>(value: T, depth = 0): T {
  if (depth > MAX_DEPTH) return '[depth]' as unknown as T;
  if (value == null) return value;

  if (Array.isArray(value)) {
    return value.map((v) => scrubPII(v, depth + 1)) as unknown as T;
  }

  if (typeof value === 'object') {
    // Erros: preserva só mensagem/nome (o stack pode conter caminhos, sem PII).
    if (value instanceof Error) {
      return { name: value.name, message: value.message } as unknown as T;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(k)) {
        out[k] = REDACTED;
      } else if (typeof v === 'string' && EMAIL_KEY.test(k)) {
        out[k] = maskEmail(v);
      } else if (typeof v === 'string' && PHONE_KEY.test(k)) {
        out[k] = maskPhone(v);
      } else if (typeof v === 'string' && NAME_KEY.test(k)) {
        out[k] = maskName(v);
      } else if (OTHER_PII_KEY.test(k)) {
        out[k] = REDACTED;
      } else {
        out[k] = scrubPII(v, depth + 1);
      }
    }
    return out as unknown as T;
  }

  return value;
}
