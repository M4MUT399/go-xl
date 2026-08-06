// errorReporting — costura ÚNICA de monitoramento de falhas (transversal).
//
// Hoje só escreve no console (logs nativos do dispositivo). Mas centraliza o
// ponto de integração: quando plugarmos um crash reporter (ex.: Sentry), basta
// um setErrorReporter(...) no bootstrap — nenhum call-site muda. Todo contexto
// passa por scrubPII antes de sair, então PII nunca vaza para telemetria.
import { scrubPII } from './mask';

export type ErrorContext = Record<string, unknown>;

export type Breadcrumb = { message: string; data?: ErrorContext; at: number };

export type ReportEvent = {
  level: 'error' | 'warning';
  message: string;
  error?: unknown;
  context?: ErrorContext;
  breadcrumbs: Breadcrumb[];
};

/** Sink plugável (ex.: envio ao Sentry). null → só console. */
export type ErrorSink = (event: ReportEvent) => void;

const MAX_BREADCRUMBS = 25;

let sink: ErrorSink | null = null;
const trail: Breadcrumb[] = [];

/** Registra (ou remove, com null) o destino externo de telemetria de falhas. */
export function setErrorReporter(fn: ErrorSink | null): void {
  sink = fn;
}

/** Extrai uma mensagem legível de qualquer erro. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Deixa uma "migalha" de contexto (com PII removida) para acompanhar falhas. */
export function addBreadcrumb(message: string, data?: ErrorContext): void {
  trail.push({ message, data: data ? scrubPII(data) : undefined, at: Date.now() });
  if (trail.length > MAX_BREADCRUMBS) trail.shift();
}

/** Limpa as migalhas acumuladas (ex.: ao trocar de usuário/sessão). */
export function clearBreadcrumbs(): void {
  trail.length = 0;
}

function emit(level: 'error' | 'warning', error: unknown, context?: ErrorContext): void {
  const safeContext = context ? scrubPII(context) : undefined;
  const message = errorMessage(error);

  // Sempre no console: em dev aparece na hora; em prod vai aos logs nativos.
  const line = `[${level}] ${message}`;
  if (level === 'error') console.error(line, safeContext ?? '');
  else console.warn(line, safeContext ?? '');

  if (sink) {
    try {
      sink({ level, message, error, context: safeContext, breadcrumbs: [...trail] });
    } catch {
      // Um reporter quebrado nunca pode derrubar o app.
    }
  }
}

/** Reporta uma falha (nível error) com contexto opcional já sanitizado. */
export function reportError(error: unknown, context?: ErrorContext): void {
  emit('error', error, context);
}

/** Reporta um aviso (nível warning) — falha não fatal/recuperável. */
export function reportWarning(error: unknown, context?: ErrorContext): void {
  emit('warning', error, context);
}
