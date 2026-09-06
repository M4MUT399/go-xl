// Detecção de conflito entre corridas AGENDADAS de um mesmo motorista.
//
// Regra (pedido do produto): o motorista NÃO pode aceitar um agendamento que se
// sobreponha a outro que ele já confirmou. O cálculo considera:
//   • a duração da rota da corrida já confirmada (scheduled_for + duration_min);
//   • o tempo de DESLOCAMENTO do destino de uma até a origem da outra (OSRM);
//   • uma FOLGA fixa de 20 minutos entre todo o processo, para não atrasar o
//     segundo agendamento.
//
// A função-núcleo `slotsConflict` é PURA e sem rede (fácil de testar). O
// orquestrador `checkScheduleConflict` injeta um resolvedor de tempo de
// deslocamento (default = OSRM via getRoute), então também é testável com stub.

/** Folga fixa, em minutos, exigida entre o fim de uma corrida e o início da próxima. */
export const SCHEDULE_BUFFER_MIN = 20;

/**
 * Janela mínima atribuída a um agendamento cuja duração não é conhecida.
 *
 * Sem ela, uma corrida sem `duration_min` viraria um INSTANTE, e dois
 * agendamentos para 09:00 e 09:01 não se sobreporiam — passariam pela regra e o
 * passageiro ficaria marcado em dois carros ao mesmo tempo. 15 min é o piso
 * conservador: erra para o lado de avisar.
 */
export const MIN_RIDE_WINDOW_MIN = 15;

export interface LatLng {
  lat: number;
  lng: number;
}

export interface SchedSlot {
  id: string;
  /** Início agendado, em epoch ms. */
  startMs: number;
  /** Duração da rota da própria corrida, em minutos. */
  durationMin: number;
  origin: LatLng;
  destination: LatLng;
}

/** Corrida mínima aceita pelos orquestradores (compatível com RideRecord). */
export interface RideLike {
  id: string;
  scheduled_for?: string;
  duration_min?: number;
  origin_lat: number;
  origin_lng: number;
  destination_lat: number;
  destination_lng: number;
}

export interface ConflictResult {
  conflict: boolean;
  /** Id da corrida já confirmada que gera o conflito. */
  withRideId?: string;
  /** scheduled_for (ISO) da corrida conflitante — usado na mensagem ao motorista. */
  withScheduledFor?: string;
}

/**
 * Núcleo PURO: dados dois slots já ORDENADOS no tempo (`first.startMs <=
 * second.startMs`) e o tempo de deslocamento do DESTINO de `first` até a ORIGEM
 * de `second`, decide se há conflito.
 *
 * Conflita quando o motorista não consegue: concluir `first`, deslocar-se até a
 * origem de `second` e ainda começar `second` com `bufferMin` de folga.
 */
export function slotsConflict(
  first: SchedSlot,
  second: SchedSlot,
  travelMin: number,
  bufferMin: number = SCHEDULE_BUFFER_MIN,
): boolean {
  const firstEndMs = first.startMs + first.durationMin * 60_000;
  const requiredSecondStartMs = firstEndMs + (travelMin + bufferMin) * 60_000;
  return second.startMs < requiredSecondStartMs;
}

/**
 * Resolvedor de tempo de deslocamento (em minutos) entre dois pontos.
 * Injetável para testes; o default usa OSRM (getRoute) com fallback haversine.
 */
export type TravelMinResolver = (from: LatLng, to: LatLng) => Promise<number>;

/** Distância em linha reta (km) — usada só como fallback se o OSRM falhar. */
function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

/**
 * Estimativa de deslocamento por fallback quando o OSRM não responde. Aplica um
 * fator de 1,3 sobre a linha reta (aproxima a malha viária) a ~35 km/h urbano.
 */
export function fallbackTravelMin(from: LatLng, to: LatLng): number {
  const roadKm = haversineKm(from, to) * 1.3;
  return Math.max(1, Math.round((roadKm / 35) * 60));
}

// Import tardio: `./routing` puxa a cadeia de AsyncStorage, que não existe fora
// do runtime nativo. No topo, ele derrubava a suíte inteira deste arquivo.
const osrmTravelMin: TravelMinResolver = async (from, to) => {
  const { getRoute } = await import('./routing');
  const r = await getRoute(from, to);
  return r?.durationMin ?? fallbackTravelMin(from, to);
};

/** Converte uma corrida em SchedSlot; devolve null se não houver horário válido. */
async function toSlot(ride: RideLike, resolve: TravelMinResolver): Promise<SchedSlot | null> {
  if (!ride.scheduled_for) return null;
  const startMs = new Date(ride.scheduled_for).getTime();
  if (Number.isNaN(startMs)) return null;

  const origin: LatLng = { lat: ride.origin_lat, lng: ride.origin_lng };
  const destination: LatLng = { lat: ride.destination_lat, lng: ride.destination_lng };

  // Se a corrida não tem duração gravada, estima a rota origem→destino.
  const durationMin =
    ride.duration_min && ride.duration_min > 0
      ? ride.duration_min
      : await resolve(origin, destination);

  return { id: ride.id, startMs, durationMin, origin, destination };
}

/**
 * Verifica se `candidate` conflita com QUALQUER corrida de `existing` (as já
 * confirmadas pelo motorista). Retorna o primeiro conflito encontrado.
 */
export async function checkScheduleConflict(
  candidate: RideLike,
  existing: RideLike[],
  bufferMin: number = SCHEDULE_BUFFER_MIN,
  resolve: TravelMinResolver = osrmTravelMin,
): Promise<ConflictResult> {
  const cand = await toSlot(candidate, resolve);
  if (!cand) return { conflict: false };

  for (const ex of existing) {
    if (ex.id === candidate.id) continue;
    const other = await toSlot(ex, resolve);
    if (!other) continue;

    // Ordena no tempo e mede o deslocamento no sentido correto:
    // do DESTINO da que acontece antes até a ORIGEM da que acontece depois.
    const [first, second] =
      cand.startMs <= other.startMs ? [cand, other] : [other, cand];
    const travelMin = await resolve(first.destination, second.origin);

    if (slotsConflict(first, second, travelMin, bufferMin)) {
      return { conflict: true, withRideId: ex.id, withScheduledFor: ex.scheduled_for };
    }
  }

  return { conflict: false };
}

// ═══════════════════════════════════════════════════════════════════════════
// LADO DO PASSAGEIRO — regra diferente, de propósito
// ═══════════════════════════════════════════════════════════════════════════
//
// O passageiro PODE ter quantos agendamentos quiser. A única coisa que ele não
// pode é estar em dois carros ao mesmo tempo — então o que barra um agendamento
// novo é a SOBREPOSIÇÃO com outro dele, e nada além disso.
//
// Por que não reusar `checkScheduleConflict` (a do motorista): aquela regra
// existe para proteger a AGENDA de quem dirige — soma o deslocamento entre o
// destino de uma corrida e a origem da próxima, mais 20 min de folga, porque é o
// mesmo carro atendendo as duas. Aplicada ao passageiro, ela recusaria coisas
// perfeitamente legítimas: ir ao aeroporto às 08:00 e ter outra corrida marcada
// para as 11:00 do outro lado da cidade não é conflito nenhum — ele voa, ou pega
// um Uber, ou o problema é dele. Além disso ela consulta o OSRM, e uma regra que
// depende da rede recusaria agendamento por instabilidade de internet.
//
// Esta é pura, sem rede e sem folga: janelas [início, início + duração] que se
// cruzam conflitam; encostar não conflita (uma corrida que termina 10:00 e outra
// que começa 10:00 passa).

/** Corrida do passageiro, na forma mínima que a regra precisa. */
export interface PassengerRideLike {
  id?: string;
  scheduled_for?: string | null;
  duration_min?: number | null;
}

/** Janela ocupada por uma corrida, em epoch ms; `null` se não dá para ler o horário. */
function janelaDaCorrida(ride: PassengerRideLike): { startMs: number; endMs: number } | null {
  if (!ride.scheduled_for) return null;
  const startMs = new Date(ride.scheduled_for).getTime();
  if (!Number.isFinite(startMs)) return null;
  const dur = ride.duration_min && ride.duration_min > 0 ? ride.duration_min : MIN_RIDE_WINDOW_MIN;
  return { startMs, endMs: startMs + dur * 60_000 };
}

/**
 * O agendamento novo bate no horário de algum que o passageiro já tem?
 *
 * Devolve o PRIMEIRO conflito encontrado — é o que a tela precisa nomear para a
 * mensagem ("você já tem uma corrida marcada para as 14:30").
 *
 * Uma corrida existente sem horário legível é IGNORADA em vez de recusar o
 * agendamento novo: dado faltando não é motivo para impedir alguém de marcar
 * viagem. Já um CANDIDATO sem horário legível não tem como ser comparado com
 * nada, e a resposta honesta ali é "não sei de conflito" — quem barra data
 * inválida é a validação da tela, antes desta função.
 */
export function passengerScheduleConflict(
  candidate: PassengerRideLike,
  existing: readonly PassengerRideLike[],
): ConflictResult {
  const nova = janelaDaCorrida(candidate);
  if (!nova) return { conflict: false };

  for (const ex of existing) {
    // A própria corrida (numa reavaliação) não conflita consigo mesma.
    if (candidate.id && ex.id === candidate.id) continue;
    const outra = janelaDaCorrida(ex);
    if (!outra) continue;

    // Sobreposição estrita: `<` nos dois lados deixa passar o caso de encostar.
    if (nova.startMs < outra.endMs && outra.startMs < nova.endMs) {
      return { conflict: true, withRideId: ex.id, withScheduledFor: ex.scheduled_for ?? undefined };
    }
  }

  return { conflict: false };
}
