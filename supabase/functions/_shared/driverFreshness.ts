// driverFreshness — a JANELA DE FRESCOR de um fix de GPS de motorista.
//
// ── POR QUE ISTO É COMPARTILHADO E NÃO UMA CONSTANTE EM CADA FUNÇÃO ────────
//
// `is_online` NÃO prova que o motorista está lá. Ninguém desliga a flag quando
// o app morre: ela só cai por trigger de escrita (0038:29, 0059:337) ou pelo
// webhook do Stripe (stripe-webhook:658) — matar o app não escreve nada. E o
// publicador de fundo (nav/backgroundLocationTask.ts:92) sai cedo quando não há
// corrida ativa, então um motorista OCIOSO com o app em segundo plano para de
// publicar. O espelho fica `true` para sempre.
//
// Em produção, em 02/09/2026, isso era visível a olho nu: das 8 linhas de
// `driver_locations`, 7 diziam `is_online = true` e 6 delas não eram tocadas
// havia entre 8 e 55 dias.
//
// Três lugares precisam decidir "quem está online DE VERDADE", e eles estavam
// discordando:
//
//   • `nearby_online_drivers` (0069:646) ....... 10 min  ✔
//   • `dispatch-engine` loadPool ............... 10 min  ✔
//   • `send-ride-push` onlineDriverIds ......... SEM FILTRO  ✘
//
// O terceiro fazia o telefone de motorista parado desde julho tocar a cada
// corrida pedida. Não afetava despacho nem cobrança — quem autoriza é o
// `charge-ride` —, mas é barulho em quem não está trabalhando, e é o tipo de
// divergência que só piora: constante copiada em três lugares fica igual até a
// primeira vez que alguém mexe em dois.
//
// ── POR QUE 10 MINUTOS E NÃO 2 ─────────────────────────────────────────────
//
// É a janela que `nearby_online_drivers` já usa (0069:646) — divergir faria o
// mapa do passageiro e o despacho discordarem sobre quem existe. E 2 min
// derrubaria motorista VIVO: `useLocation` observa com `distanceInterval: 15` e
// `timeInterval: 5000` (useLocation.ts:106-107), mas o `timeInterval` é ignorado
// no iOS, então um motorista PARADO — na fila do MCO, exatamente o caso
// premium — pode passar minutos sem emitir fix.
//
// Errar para o lado do fantasma custa latência; errar para o outro custa a
// corrida. Por isso a janela é larga, e por isso ela é UMA.
//
// Se mudar aqui, mude também em `nearby_online_drivers` (0069:646): o SQL não
// consegue importar este módulo, então aquela é a única cópia que sobra.

/** Idade máxima de um fix para o motorista contar como presente. */
export const DRIVER_FIX_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * O corte, em ISO, para usar direto num `.gt('updated_at', …)` do PostgREST.
 *
 * `agoraMs` é injetável só para o teste poder fixar o relógio; em produção
 * ninguém passa nada.
 */
export function cortePorFrescorIso(agoraMs: number = Date.now()): string {
  return new Date(agoraMs - DRIVER_FIX_MAX_AGE_MS).toISOString();
}

/**
 * Um fix com este carimbo ainda conta? Espelha exatamente o `.gt(...)` acima —
 * `gt` é ESTRITO, então um fix exatamente na borda dos 10 min NÃO conta.
 *
 * Entrada inválida (null, vazio, data impossível) devolve `false`: linha sem
 * carimbo legível é fantasma, e o lado seguro do erro é não tocar o telefone
 * de quem não está lá.
 */
export function fixEstaFresco(updatedAt: string | null | undefined, agoraMs: number = Date.now()): boolean {
  if (!updatedAt) return false;
  const t = Date.parse(updatedAt);
  if (!Number.isFinite(t)) return false;
  return t > agoraMs - DRIVER_FIX_MAX_AGE_MS;
}

// ── O LEQUE DO PUSH E O RAIO DE 50 MILHAS (26/10/2026) ─────────────────────
//
// Medido em produção: de 12 pedidos imediatos em outubro, 10 foram oferecidos a
// ZERO motoristas (ride_push_offers vazio). Motivo: até a build que publica GPS
// com o motorista ocioso em segundo plano (backgroundLocationTask, modo
// "online"), quem fica online e põe o celular no bolso para de carimbar
// `updated_at` — e em 10 min some do leque. O PUSH é justamente o que existe
// para alcançar esse motorista; exigir dele um fix de 10 min anula o push.
//
// Por isso o leque do PUSH usa uma janela própria, larga, e um corte
// GEOGRÁFICO no lugar do corte de tempo: motorista online com último fix nas
// últimas 12 h (o mesmo teto de `driving_limit_hours`) e a até 50 milhas do
// embarque. O fantasma de 50 dias que motivou o filtro de frescor continua de
// fora. Mapa do passageiro e motor v2 seguem com a janela de 10 min — eles
// mostram/ranqueiam POSIÇÃO, e posição velha ali é mentira; aqui ela só decide
// quem recebe o toque. Quem autoriza o aceite segue sendo o `charge-ride`.

/** Idade máxima do último fix para um motorista online ainda receber o PUSH. */
export const PUSH_FANOUT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

/** Raio de despacho: 50 milhas, em km. */
export const DISPATCH_RADIUS_KM = 50 * 1.609344;

/** Corte em ISO para o leque do push (ver PUSH_FANOUT_MAX_AGE_MS). */
export function cortePushIso(agoraMs: number = Date.now()): string {
  return new Date(agoraMs - PUSH_FANOUT_MAX_AGE_MS).toISOString();
}

/** Distância em km (haversine) — mesma fórmula de dispatchEngine/airportFees. */
export function distanciaKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * O motorista está dentro do raio de despacho? Sem coordenada de um dos lados
 * não há como medir — aí ele FICA no leque (errar para o lado de tocar um
 * telefone a mais custa menos que perder a corrida).
 */
export function dentroDoRaio(
  embarque: { lat: number | null; lng: number | null } | null,
  motorista: { lat: number | null; lng: number | null },
  raioKm: number = DISPATCH_RADIUS_KM,
): boolean {
  if (!embarque || embarque.lat == null || embarque.lng == null) return true;
  if (motorista.lat == null || motorista.lng == null) return true;
  return distanciaKm({ lat: embarque.lat, lng: embarque.lng }, { lat: motorista.lat, lng: motorista.lng }) <= raioKm;
}
