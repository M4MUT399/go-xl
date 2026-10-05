/**
 * A telemetria do motorista que o passageiro está vendo ainda é VERDADE?
 *
 * ── O CASO QUE ORIGINOU ESTE ARQUIVO ───────────────────────────────────────
 *
 * 26/09/2026, relatado pelo motorista Fabricio: "eu chego na localização e o
 * GPS no passageiro fala que eu tô 5 milhas de distância". No mesmo dia, o
 * passageiro Jeff escreveu ao motorista: *"Not sure if the app is correct but
 * it is saying you are going to be really late?? Like 11:30. My plane boards at
 * 12:30."* O motorista chegaria 11:03. O voo quase foi perdido por um número
 * que o app mostrou com toda a confiança.
 *
 * A causa primária é de publicação: quem escreve `rides.driver_lat/lng/eta` é um
 * efeito dentro da `DriverNavigateScreen`, que só roda com a tela em primeiro
 * plano — e o motorista navega pelo Waze, deixando o Go XL em segundo plano.
 * Isso se resolve com as flags `nav_background_location_v1` e
 * `nav_publish_cadence`.
 *
 * Mas há um segundo defeito, independente, e é este arquivo: mesmo quando a
 * publicação para, a `ActiveRideScreen` **continua apresentando o último número
 * como se fosse fresco**. Ela só marca `telemetryStale` quando a CONSULTA FALHA;
 * uma linha congelada lida com sucesso passa por atual. Ou seja: a tela não
 * distingue "o motorista está parado no semáforo" de "o motorista parou de
 * publicar há seis minutos" — e as duas coisas exigem reações opostas do
 * passageiro.
 *
 * Nenhuma flag conserta isso. Enquanto existir qualquer caminho em que a
 * telemetria para (sem sinal, app encerrado, permissão negada), o número velho
 * precisa se ANUNCIAR como velho.
 *
 * ── POR QUE 90 SEGUNDOS ────────────────────────────────────────────────────
 *
 * As cadências de publicação são: 4 s de heartbeat em primeiro plano
 * (`nav_publish_cadence`) e 15 s em segundo plano
 * (`DEFAULT_BACKGROUND_PUBLISH_GATE`). 90 s é seis vezes a pior delas — folga
 * suficiente para túnel, elevador de garagem e troca de torre sem acusar falso,
 * e MUITO abaixo dos minutos que produzem as cinco milhas do relato.
 */

/** A partir de quanto tempo sem publicar a telemetria deixa de ser confiável. */
export const STALE_AFTER_MS = 90_000;

export type TelemetryFreshness =
  /** Dado recente: pode ser apresentado como está. */
  | { stale: false }
  /** Dado velho ou desconhecido: a tela precisa dizer isso. */
  | { stale: true; reason: 'query_failed' | 'aged' | 'unknown'; ageMs?: number };

export interface TelemetrySnapshot {
  /** `rides.driver_telemetry_at` — quando o motorista publicou pela última vez. */
  driver_telemetry_at?: string | null;
  driver_lat?: number | null;
  driver_lng?: number | null;
}

/**
 * Decide se o que está na tela ainda vale.
 *
 * `queryFailed` continua mandando: se nem conseguimos ler, não há o que
 * avaliar. Fora isso, quem decide é a IDADE do último fix.
 *
 * ── O FALLBACK PARA O APP ANTIGO DO MOTORISTA ──────────────────────────────
 *
 * `driver_telemetry_at` só passa a ser gravado pela build que introduz esta
 * regra. Enquanto houver motorista com build anterior, a coluna vem NULA — e
 * aí não dá para medir idade. Nesse caso comparamos a posição com a anterior:
 * se ela não mudou desde a última observação, usamos o tempo em que estamos
 * olhando para a MESMA coordenada.
 *
 * Isso é inferência, não medição: um motorista genuinamente parado por 90 s
 * (semáforo longo, fila de embarque) é marcado como velho sem estar. Preferimos
 * esse erro ao contrário — um "~" a mais faz o passageiro olhar de novo; um ETA
 * confiante e errado faz ele perder o voo.
 */
export function telemetryFreshness(
  snapshot: TelemetrySnapshot,
  nowMs: number,
  opts: { queryFailed?: boolean; unchangedSinceMs?: number | null } = {},
): TelemetryFreshness {
  if (opts.queryFailed) return { stale: true, reason: 'query_failed' };

  const publicado = snapshot.driver_telemetry_at ? Date.parse(snapshot.driver_telemetry_at) : NaN;

  if (Number.isFinite(publicado)) {
    // Relógio do aparelho adiantado em relação ao servidor daria idade negativa.
    // Tratamos como fresco: a culpa é do relógio, não do motorista.
    const ageMs = Math.max(0, nowMs - publicado);
    return ageMs > STALE_AFTER_MS ? { stale: true, reason: 'aged', ageMs } : { stale: false };
  }

  // Sem carimbo: o app do motorista é anterior a esta regra. Caímos na inferência.
  if (opts.unchangedSinceMs != null) {
    const ageMs = Math.max(0, nowMs - opts.unchangedSinceMs);
    return ageMs > STALE_AFTER_MS ? { stale: true, reason: 'aged', ageMs } : { stale: false };
  }

  // Sem carimbo E sem histórico (primeira leitura): não afirmamos nada. Não é
  // "fresco", é "não sei" — e `unknown` deixa a tela escolher não prometer.
  if (snapshot.driver_lat == null || snapshot.driver_lng == null) {
    return { stale: true, reason: 'unknown' };
  }
  return { stale: false };
}

/** Quanto tempo faz, em minutos inteiros, para a tela dizer ao passageiro. */
export function staleMinutes(ageMs: number | undefined): number {
  if (!ageMs || !Number.isFinite(ageMs)) return 0;
  return Math.max(1, Math.floor(ageMs / 60_000));
}
