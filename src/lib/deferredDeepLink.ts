/**
 * Deferred deep linking do QR de motorista (paridade Uber "invite install").
 *
 * Problema: um passageiro que **não** tem o app lê o QR de um motorista. O QR
 * aponta para uma landing https (goxl.app/qr?driver=CODE) que manda para a loja.
 * Depois do download, o app precisa saber QUAL motorista originou a instalação
 * para travar a 1ª corrida nele — mas um deep link normal (`goxl://ride?driver=`)
 * se perde entre o clique na loja e o primeiro open.
 *
 * Solução DIY (sem SDK de terceiros): a landing grava o código na **área de
 * transferência** (`goxl-ride:CODE`) no gesto do usuário, antes de redirecionar
 * para a loja. No primeiríssimo open, o app lê o clipboard uma única vez e
 * recupera o código.
 *
 * Este módulo é **puro** (sem React nem rede) na parte de parsing — testável em
 * unidade. A leitura do clipboard (impura) fica isolada em `readDeferredDriverCode`.
 *
 * Nota iOS: ler o clipboard exibe o banner "colado da área de transferência".
 * É aceitável aqui porque acontece uma vez só, logo após uma instalação que o
 * próprio usuário iniciou lendo o QR.
 *
 * `expo-clipboard` é importado de forma **preguiçosa** dentro da função impura
 * (não no topo) para que os parsers puros deste módulo continuem testáveis em
 * unidade sem o módulo nativo no ambiente do jest.
 */

/** Prefixo que identifica um payload de driver code na área de transferência. */
export const DEFERRED_CLIP_PREFIX = 'goxl-ride:';

/** Mesmo charset de `codeFromId` (QRCodeScreen) — Crockford-ish, sem I/O/0/1. */
const DRIVER_CODE_RE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;

/**
 * Extrai um driver code de um conteúdo de clipboard, se e só se ele seguir o
 * formato `goxl-ride:CODE` com CODE no charset/comprimento canônicos.
 * Devolve `null` para qualquer outro conteúdo (o usuário pode ter copiado
 * qualquer coisa antes de abrir o app — nunca confiar cegamente no clipboard).
 */
export function parseClipboardPayload(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith(DEFERRED_CLIP_PREFIX)) return null;
  const code = trimmed.slice(DEFERRED_CLIP_PREFIX.length).trim().toUpperCase();
  return DRIVER_CODE_RE.test(code) ? code : null;
}

/**
 * Extrai um driver code de uma string de install-referrer do Android
 * (ex.: `utm_source=goxl_qr&goxl_driver=ABC123`). Fonte alternativa/futura ao
 * clipboard — hoje não há lib de referrer instalada, mas o parser fica pronto
 * para plugar quando/se `react-native-play-install-referrer` (ou similar) for
 * adicionado. Puro e testável.
 */
export function parseInstallReferrer(ref: string | null | undefined): string | null {
  if (!ref) return null;
  // Aceita tanto "a=b&goxl_driver=CODE" quanto o referrer inteiro url-encoded.
  let decoded = ref;
  try {
    decoded = decodeURIComponent(ref);
  } catch {
    // referrer malformado → usa como veio
  }
  const params = new URLSearchParams(decoded.replace(/^\?/, ''));
  const raw = params.get('goxl_driver') ?? params.get('driver');
  if (!raw) return null;
  const code = raw.trim().toUpperCase();
  return DRIVER_CODE_RE.test(code) ? code : null;
}

/**
 * Lê o clipboard **uma vez** e devolve o driver code diferido, se houver.
 * Best-effort: qualquer falha (permissão/plataforma) é engolida e devolve
 * `null`. Impura (fala com o SO) — fora dos testes unitários.
 */
export async function readDeferredDriverCode(): Promise<string | null> {
  try {
    const Clipboard = await import('expo-clipboard');
    const hasContent = await Clipboard.hasStringAsync();
    if (!hasContent) return null;
    const raw = await Clipboard.getStringAsync();
    return parseClipboardPayload(raw);
  } catch (e) {
    console.warn('[deferredDeepLink] falha ao ler clipboard:', (e as Error)?.message);
    return null;
  }
}
