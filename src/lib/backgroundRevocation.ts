// backgroundRevocation — regra PURA que extrai, de um payload de push recebido
// EM BACKGROUND, o id da corrida cuja oferta foi revogada (Camada 2, Android-
// first). Isolada de expo-notifications/TaskManager de propósito: pura e
// testável sem mocks nativos — o mesmo espírito de rideRevocation.ts.
//
// Por que "defensiva/recursiva": o formato do payload entregue à task de
// background NÃO é estável entre plataformas/versões do expo-notifications.
// Dependendo do caminho (FCM data-only no Android, content-available no iOS, ou
// o objeto Notification do Expo), o `{ type, rideId }` pode aparecer no topo,
// dentro de `notification.request.content.data`, dentro de `data`, ou até
// serializado como string JSON em `dataString`/`body`. Em vez de casar um
// formato único e frágil, varremos a árvore até achar um nó que se declare
// `type: 'offer_revoked'` com um id — best-effort por natureza, então robustez
// vale mais que precisão.

/** Tipo do push silencioso de revogação (data-only) enviado aos demais motoristas. */
export const OFFER_REVOKED_TYPE = 'offer_revoked';

/** Profundidade máxima da varredura — evita loop em refs cíclicas/payloads gigantes. */
const MAX_DEPTH = 6;

/** Chaves cujo valor-string pode ser um JSON aninhado (formatos Android/FCM). */
const JSON_STRING_KEYS = new Set(['dataString', 'data', 'body']);

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function walk(node: unknown, depth: number): string | null {
  if (node == null || depth > MAX_DEPTH || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  // Este nível descreve a revogação?
  if (obj.type === OFFER_REVOKED_TYPE) {
    const id = obj.rideId ?? obj.ride_id;
    if (typeof id === 'string' && id.length > 0) return id;
  }

  for (const key of Object.keys(obj)) {
    const child = obj[key];
    if (child && typeof child === 'object') {
      const found = walk(child, depth + 1);
      if (found) return found;
    } else if (typeof child === 'string' && JSON_STRING_KEYS.has(key)) {
      // Alguns transportes entregam o `data` como string JSON — tenta abrir.
      const found = walk(safeParse(child), depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Retorna o id da corrida revogada se o payload for um evento `offer_revoked`
 * com um rideId válido; caso contrário `null` (não é revogação, ou sem id).
 */
export function extractRevokedRideId(payload: unknown): string | null {
  return walk(payload, 0);
}
