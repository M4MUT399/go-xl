import { useState, useEffect, useCallback, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import { supabase } from '../lib/supabase';
import { dismissRideNotifications } from '../lib/notifications';
import { KM_TO_MILES, formatCurrency } from '../lib/format';
import { getSurgeInfo } from '../lib/surge';
import { calculateSplit } from '../lib/split';
import { estimateTollAmount } from '../lib/tolls';
import { estimateAirportFees } from '../lib/airportFees';
import { getRoute } from '../lib/routing';
import { logRideOfferEvent } from '../lib/rideOfferEvents';
import { canReceiveNewRideOffer } from '../lib/rideDispatch';
import { resolveRevocation, type RideRevokeReason } from '../lib/rideRevocation';
import { offerAlertManager } from '../lib/offerAlertManager';
import { arriveOffer, resolveOffer, queueHasOffer } from '../lib/offerQueue';
import { decideOfferAction, livePendingOffers, type OfferRow } from '../lib/dispatchClientBridge';
import { getConfig } from '../lib/systemConfig';
import { useFeatureFlag } from './useFeatureFlag';
import { reportError } from '../lib/errorReporting';
import { withTimeout } from '../lib/withTimeout';
import type { Ride, RideStatus, Location, RideRecord } from '../types';
export type { SurgeInfo } from '../lib/surge';
export type { RideRevokeReason } from '../lib/rideRevocation';

const SUPABASE_URL     = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const CHARGE_RIDE_URL  = `${SUPABASE_URL}/functions/v1/charge-ride`;
const REFUND_RIDE_URL  = `${SUPABASE_URL}/functions/v1/refund-ride`;
const TIP_RIDE_URL     = `${SUPABASE_URL}/functions/v1/tip-ride`;

/** Cobra o cartão do passageiro via Edge Function (off-session). */
async function chargeRide(rideId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    // getSession e fetch NÃO têm timeout nativo — sem os withTimeout abaixo, uma
    // rede ruim deixava o aceite pendurado para sempre (tela travada no Android).
    const { data: { session } } = await withTimeout(
      supabase.auth.getSession(),
      8000,
      'Não foi possível validar sua sessão. Verifique a conexão.'
    );
    const res = await withTimeout(
      fetch(CHARGE_RIDE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session?.access_token ?? ''}`,
        },
        body: JSON.stringify({ rideId }),
      }),
      20000,
      'A cobrança demorou demais. Tente novamente.'
    );
    const json = await res.json() as { success?: boolean; already_paid?: boolean; error?: string };
    if (json.success || json.already_paid) return { ok: true };
    return { ok: false, error: json.error ?? 'Pagamento recusado' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Reaplica a divisão de receita de uma corrida com a fatia REAL do motorista que
 * a assumiu (profiles.driver_share_percent), decidida no onboarding — 85% para os
 * 100 primeiros motoristas, 80% do 101º em diante.
 *
 * Por que aqui e não no pedido: no `requestRide`/`scheduleRide` o motorista ainda
 * é desconhecido (pool aberto), então o split é gravado com o padrão. Quando um
 * motorista aceita, seu `driver_id` passa a existir e recalculamos driver_amount/
 * platform_fee com a fatia dele. O passageiro paga sempre o mesmo `price`; isto só
 * ajusta quanto o motorista recebe no repasse semanal.
 *
 * Fire-and-forget (best-effort): se o motorista ainda não tem faixa definida
 * (share == null) ou algo falhar, o split padrão já gravado permanece — nunca
 * bloqueia o aceite nem o pagamento.
 */
async function applyDriverSplit(rideId: string, driverId: string): Promise<void> {
  try {
    const [{ data: prof }, { data: ride }] = await Promise.all([
      supabase.from('profiles').select('driver_share_percent').eq('id', driverId).single(),
      supabase.from('rides').select('price, toll_amount, airport_port_fee').eq('id', rideId).single(),
    ]);
    const share = (prof as { driver_share_percent: number | null } | null)?.driver_share_percent;
    if (share == null) return; // sem faixa definida — mantém o split padrão gravado
    const r = ride as { price: number | null; toll_amount: number | null; airport_port_fee: number | null } | null;
    if (!r) return;
    const toll = Number(r.toll_amount) || 0;
    const venueFee = Number(r.airport_port_fee) || 0;
    // O split incide só sobre a tarifa (pedágio é pass-through ao motorista; taxa
    // de aeroporto/porto é regulatória e fica com a plataforma).
    const fare = Math.round(((Number(r.price) || 0) - toll - venueFee) * 100) / 100;
    const split = calculateSplit(fare, Number(share));
    const driverAmount = Math.round((split.driverAmount + toll) * 100) / 100;
    const platformFee = Math.round((split.platformFee + venueFee) * 100) / 100;
    await supabase
      .from('rides')
      .update({ driver_amount: driverAmount, platform_fee: platformFee })
      .eq('id', rideId);
  } catch (e) {
    reportError(e, { op: 'applyDriverSplit', rideId });
  }
}

/** Cobra gorjeta do passageiro via Edge Function (off-session). */
export async function tipRide(rideId: string, amountCents: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(TIP_RIDE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session?.access_token ?? ''}`,
      },
      body: JSON.stringify({ rideId, amountCents }),
    });
    const json = await res.json() as { success?: boolean; already_tipped?: boolean; error?: string };
    if (json.success || json.already_tipped) return { ok: true };
    return { ok: false, error: json.error ?? 'Erro ao processar gorjeta' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/** Extorna o pagamento de uma corrida via Edge Function. */
async function refundRide(rideId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const res = await fetch(REFUND_RIDE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session?.access_token ?? ''}`,
      },
      body: JSON.stringify({ rideId }),
    });
    const json = await res.json() as { success?: boolean; no_charge?: boolean; error?: string };
    if (json.success) return { ok: true };
    return { ok: false, error: json.error ?? 'Erro ao extornar' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Chama a Edge Function `send-ride-push` — todo o envio de push de corrida
 * (leitura de push_token e chamada à API do Expo) roda no servidor, com
 * templates fixos por `kind`. O client nunca mais lê push_token de outro
 * usuário nem manda título/corpo livre; só `kind` + `rideId` (+ ids-alvo no
 * broadcast). Best-effort: falhas são engolidas, nunca bloqueiam o fluxo de
 * corrida (mesma filosofia do antigo sendPushAsync).
 */
async function invokeRidePush(body: {
  kind: string;
  rideId: string;
  driverIds?: string[];
  exceptDriverId?: string;
}): Promise<void> {
  try {
    await supabase.functions.invoke('send-ride-push', { body });
  } catch (e) {
    reportError(e, { op: 'invokeRidePush', kind: body.kind });
  }
}

/**
 * PR-c (motor v2): entrega a corrida ao SERVIDOR como fonte da verdade. Chama a
 * Edge Function `dispatch-engine` (action=create), que cria o `trip_request`,
 * roda o núcleo puro para ofertar ao(s) motorista(s) por ETA e persiste em
 * `ride_offers` (+ push best-effort). Retorna `true` se o motor assumiu a
 * distribuição; `false` se a flag `dispatch_engine_v2` está OFF no servidor
 * (`{ skipped: true }`) ou se houve erro — nesse caso o chamador cai no fluxo
 * legado (`notifyOnlineDrivers`), garantindo que a corrida nunca fique sem
 * distribuição. Best-effort quanto a exceções (mesma filosofia de invokeRidePush).
 */
async function dispatchEngineCreate(rideId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.functions.invoke('dispatch-engine', {
      body: { action: 'create', rideId },
    });
    if (error) {
      reportError(error, { op: 'dispatchEngineCreate', rideId });
      return false;
    }
    // { skipped: true } → flag OFF no servidor: o chamador usa o legado.
    return !(data && (data as { skipped?: boolean }).skipped);
  } catch (e) {
    reportError(e, { op: 'dispatchEngineCreate', rideId });
    return false;
  }
}

async function notifyOnlineDrivers(
  destination: string,
  price: number,
  destinationCoords?: { lat: number; lng: number },
  rideId?: string
) {
  const { data: online } = await supabase
    .from('driver_locations')
    .select('driver_id')
    .eq('is_online', true);

  let driverIds = ((online as { driver_id: string }[]) ?? []).map((d) => d.driver_id);
  if (driverIds.length === 0) return;

  // Não incomoda motoristas já a caminho/em corrida com outro passageiro —
  // salvo se o destino desta nova chamada for igual (ou a até 1km) do
  // destino final da corrida ativa deles, ou se faltarem <=5min para
  // terminá-la (mesma regra usada no realtime — ver canReceiveNewRideOffer).
  const { data: busyRows } = await supabase
    .from('rides')
    .select('driver_id, status, destination_lat, destination_lng, destination_address, driver_eta_min')
    .in('driver_id', driverIds)
    .in('status', ['accepted', 'driver_en_route', 'in_progress']);

  const busyByDriver = new Map<string, { status: string; destination_lat?: number; destination_lng?: number; destination_address?: string; driver_eta_min?: number }>();
  for (const r of (busyRows as { driver_id?: string; status: string; destination_lat?: number; destination_lng?: number; destination_address?: string; driver_eta_min?: number }[]) ?? []) {
    if (r.driver_id) busyByDriver.set(r.driver_id, r);
  }

  driverIds = driverIds.filter((id) =>
    canReceiveNewRideOffer(busyByDriver.get(id) ?? null, {
      destination_address: destination,
      destination_lat: destinationCoords?.lat,
      destination_lng: destinationCoords?.lng,
    })
  );
  if (driverIds.length === 0 || !rideId) return;

  // Título/corpo agora são templates fixos no servidor — a Edge Function
  // busca destination/price direto na linha de `rides`, o client só informa
  // QUEM notificar (o filtro de disponibilidade acima continua client-side).
  await invokeRidePush({ kind: 'new_ride_broadcast', rideId, driverIds });
}

/** Notifica apenas o motorista vinculado ao QR code (não transmite para todos). */
async function notifySpecificDriver(driverId: string, destination: string, price: number, rideId?: string) {
  if (!rideId) return;
  await invokeRidePush({ kind: 'new_ride_direct', rideId });
}

/** Notifica o motorista vinculado ao QR code sobre um AGENDAMENTO (não uma corrida imediata). */
async function notifySpecificDriverScheduled(driverId: string, destination: string, price: number, scheduledFor: Date, rideId: string) {
  await invokeRidePush({ kind: 'new_ride_scheduled_direct', rideId });
}

/**
 * Broadcast direto para o motorista específico (não precisa de push token).
 * Usado como fallback confiável no Expo Go / desenvolvimento.
 */
async function broadcastToDriver(driverId: string, ride: object) {
  const channelName = `driver-notify-${driverId}`;
  const ch = supabase.channel(channelName);

  await new Promise<void>((resolve) => {
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        ch.send({
          type: 'broadcast',
          event: 'new_qr_ride',
          payload: { ride },
        }).then(() => { supabase.removeChannel(ch); resolve(); })
          .catch(() => { supabase.removeChannel(ch); resolve(); });
      }
    });
    setTimeout(() => { supabase.removeChannel(ch); resolve(); }, 5000);
  });
}

async function notifyPassenger(passengerId: string, rideId: string, price?: number, etaMin?: number | null) {
  await invokeRidePush({ kind: 'ride_accepted', rideId });
}

/**
 * Envia um Broadcast Supabase diretamente para o canal do passageiro.
 * Não depende de WAL, RLS ou push token — basta o passageiro ter o app aberto.
 */
async function broadcastToPassenger(passengerId: string, rideId: string) {
  const channelName = `pax-notify-${passengerId}`;
  const ch = supabase.channel(channelName);

  await new Promise<void>((resolve) => {
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        ch.send({
          type: 'broadcast',
          event: 'schedule_confirmed',
          payload: { rideId },
        }).then(() => {
          supabase.removeChannel(ch);
          resolve();
        }).catch(() => {
          supabase.removeChannel(ch);
          resolve();
        });
      }
    });

    // timeout de segurança: se não conectar em 5s, desiste
    setTimeout(() => { supabase.removeChannel(ch); resolve(); }, 5000);
  });
}

/**
 * Avisa o passageiro que a corrida foi aceita pelo motorista.
 * Usa Broadcast (não depende de WAL/RLS/push) no canal pax-notify-${passengerId}.
 */
async function broadcastRideAccepted(passengerId: string, ride: object) {
  const channelName = `pax-notify-${passengerId}`;
  const ch = supabase.channel(channelName);

  await new Promise<void>((resolve) => {
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        ch.send({
          type: 'broadcast',
          event: 'ride_accepted',
          payload: { ride },
        }).then(() => {
          supabase.removeChannel(ch);
          resolve();
        }).catch(() => {
          supabase.removeChannel(ch);
          resolve();
        });
      }
    });
    setTimeout(() => { supabase.removeChannel(ch); resolve(); }, 5000);
  });
}

/**
 * Mecanismo ÚNICO de revogação de oferta de corrida (Tarefas 3 e 4).
 *
 * Emite no canal compartilhado `ride-offers` o evento `ride_offer_revoked` com
 * o motivo. Qualquer motorista que tenha essa corrida como oferta pendente
 * (card + som de chamada) a remove NA HORA — parando o alarme imediatamente:
 *   • 'taken'     → outro motorista aceitou (dispatch em leque).
 *   • 'cancelled' → o passageiro cancelou.
 *   • 'expired'   → o agendamento venceu sem motorista.
 *
 * `by` (opcional) identifica o motorista que aceitou, para ele não se
 * auto-limpar nem duplicar o log de auditoria no caso 'taken'.
 *
 * Continua emitindo TAMBÉM o evento legado `ride_taken` (apenas no aceite) para
 * builds antigas em campo, que só escutam esse evento, pararem o som — sem
 * duplicar lógica: os dois eventos saem da MESMA função.
 */
export async function broadcastRideRevoked(rideId: string, reason: RideRevokeReason, by?: string) {
  // Camada 2 (background/lockscreen): além do broadcast Realtime — que só chega a
  // quem tem o app EM FOREGROUND — dispara um push SILENCIOSO de revogação para
  // os motoristas online, acordando (Android) a task de background que dispensa
  // o card fantasma da bandeja. Fire-and-forget: não bloqueia o broadcast nem o
  // fluxo de aceite, e falhas são engolidas dentro do helper.
  void pushSilentRevokeToOnlineDrivers(rideId, reason === 'taken' ? by : undefined);

  const ch = supabase.channel('ride-offers');
  await new Promise<void>((resolve) => {
    ch.subscribe((status) => {
      if (status !== 'SUBSCRIBED') return;
      const done = () => { supabase.removeChannel(ch); resolve(); };
      ch.send({ type: 'broadcast', event: 'ride_offer_revoked', payload: { rideId, reason, by } })
        .then(() =>
          reason === 'taken'
            ? ch.send({ type: 'broadcast', event: 'ride_taken', payload: { rideId, by } })
            : undefined
        )
        .then(done)
        .catch(done);
    });
    setTimeout(() => { supabase.removeChannel(ch); resolve(); }, 5000);
  });
}

/**
 * Envia o push SILENCIOSO de revogação (Camada 2) aos motoristas online, exceto
 * `exceptDriverId` (o vencedor, no caso 'taken' — ele não precisa dispensar nada
 * e já está saindo do pool). Reaproveita o mesmo caminho de descoberta de tokens
 * do `notifyOnlineDrivers`: driver_locations(is_online) → profiles.push_token.
 *
 * Best-effort e nunca lança: a revogação também trafega por Realtime (foreground)
 * e pelo backstop de 1,5s (reabertura) — este push só cobre o buraco de
 * background/lockscreen, onde o JS de foreground está suspenso.
 */
async function pushSilentRevokeToOnlineDrivers(rideId: string, exceptDriverId?: string) {
  if (!rideId) return;
  try {
    const { data: online } = await supabase
      .from('driver_locations')
      .select('driver_id')
      .eq('is_online', true);

    const driverIds = ((online as { driver_id: string }[]) ?? [])
      .map((d) => d.driver_id)
      .filter((id) => id !== exceptDriverId);
    if (driverIds.length === 0) return;

    await invokeRidePush({ kind: 'silent_revoke', rideId, driverIds, exceptDriverId });
  } catch (e) {
    reportError(e, { op: 'pushSilentRevokeToOnlineDrivers' });
  }
}

/**
 * Reabre uma corrida ao pool de motoristas livres.
 *
 * Usado quando um aceite é abortado DEPOIS de já termos silenciado os demais
 * motoristas otimisticamente (ex.: a cobrança do cartão falhou). Um UPDATE que
 * mantém status='requesting' re-dispara a subscription realtime
 * (filter status=eq.requesting) nos motoristas livres, fazendo o card de
 * chamada — e o som — voltarem para quem havia sido silenciado.
 *
 * As guardas .eq('status','requesting').is('driver_id', null) garantem que só
 * reabrimos uma corrida REALMENTE ainda aberta: se outro motorista já a travou
 * ('accepted'), o UPDATE casa zero linhas e vira no-op — nunca ressuscita uma
 * corrida já dada a alguém.
 */
export async function reofferRide(rideId: string) {
  try {
    await supabase
      .from('rides')
      .update({ status: 'requesting' as RideStatus })
      .eq('id', rideId)
      .eq('status', 'requesting')
      .is('driver_id', null);
  } catch (e) {
    reportError(e, { op: 'reofferRide', rideId });
  }
}

/**
 * Avisa DIRETAMENTE o motorista já designado que o passageiro cancelou uma
 * corrida ACEITA — no canal pessoal dele (`driver-notify-${driverId}`), evento
 * `ride_cancelled`. Entrega confiável em foreground sem depender de
 * postgres_changes (instável no Expo Go). O motorista que estiver navegando
 * mostra o aviso "Corrida cancelada pelo passageiro" e volta ao início.
 */
async function broadcastRideCancelledToDriver(driverId: string, rideId: string) {
  const ch = supabase.channel(`driver-notify-${driverId}`);
  await new Promise<void>((resolve) => {
    ch.subscribe((status) => {
      if (status !== 'SUBSCRIBED') return;
      const done = () => { supabase.removeChannel(ch); resolve(); };
      ch.send({ type: 'broadcast', event: 'ride_cancelled', payload: { rideId } })
        .then(done).catch(done);
    });
    setTimeout(() => { supabase.removeChannel(ch); resolve(); }, 5000);
  });
}

async function notifyPassengerScheduleConfirmed(passengerId: string, rideId: string) {
  await invokeRidePush({ kind: 'schedule_confirmed', rideId });
}

/** Avisa o passageiro que o motorista NÃO confirmou o agendamento travado por QR. */
async function notifyPassengerScheduleRejected(passengerId: string, rideId: string) {
  await invokeRidePush({ kind: 'schedule_rejected', rideId });
}

/** Notifica o passageiro (push) que a corrida foi concluída. */
export async function notifyPassengerRideCompleted(passengerId: string, rideId: string, price?: number) {
  await invokeRidePush({ kind: 'ride_completed', rideId });
}

// ── Tarifa GoXL — espelha a Uber XL (Orlando, FL) + 10% ─────────────────────
// Referência Uber XL Orlando: base $3,00 · $1,21/milha · $0,20/min · mínimo
// $8,90 · booking fee $3,00. Decisão de produto: GoXL cobra exatamente 10%
// acima da tarifa Uber equivalente. O surge (pico) incide sobre a parte
// metrada (base + distância + tempo). A quantidade de motoristas GoXL online
// NÃO entra no preço — só horário (pico) e local (taxas de aeroporto/porto, P6).
const UBER_XL_BASE_FARE   = 3.0;   // USD
const UBER_XL_PER_MILE    = 1.21;  // USD por milha
const UBER_XL_PER_MINUTE  = 0.2;   // USD por minuto
const UBER_XL_BOOKING_FEE = 3.0;   // USD (taxa de serviço/booking)
const UBER_XL_MIN_FARE    = 8.9;   // USD (piso da parte metrada)
const GOXL_MARKUP         = 1.1;   // +10% sobre a Uber
const AVG_SPEED_MPH       = 30;    // p/ estimar tempo quando não há rota

export function estimatePrice(distanceKm: number, durationMin = 0, surgeMultiplier = 1.0) {
  const miles = distanceKm * KM_TO_MILES;
  const minutes = Math.max(0, durationMin);
  // Parte metrada, com surge de pico e piso do mínimo da Uber.
  const metered = UBER_XL_BASE_FARE + miles * UBER_XL_PER_MILE + minutes * UBER_XL_PER_MINUTE;
  const surged = Math.max(metered * surgeMultiplier, UBER_XL_MIN_FARE);
  const uberEquivalent = surged + UBER_XL_BOOKING_FEE;
  // GoXL = tarifa Uber equivalente + 10%.
  return Math.round(uberEquivalent * GOXL_MARKUP * 100) / 100;
}

export function estimateDuration(distanceKm: number) {
  const miles = distanceKm * KM_TO_MILES;
  return Math.ceil((miles / AVG_SPEED_MPH) * 60);
}

const ACTIVE_RIDE_STATUSES: RideStatus[] = ['requesting', 'accepted', 'driver_en_route', 'in_progress'];

export function usePassengerRide(passengerId: string | undefined, jurisdiction: string = 'global') {
  const [activeRide, setActiveRide] = useState<Ride | null>(null);
  const [loadingActive, setLoadingActive] = useState(true);
  // A HomeScreen (aba, sempre montada) e as telas FindingDriver/ActiveRide
  // (empilhadas por cima) podem usar este hook ao mesmo tempo. Dois canais
  // Supabase com o MESMO tópico colidem, então cada instância usa um sufixo
  // único para manter subscriptions independentes.
  const channelIdRef = useRef(`passenger-ride-${Math.random().toString(36).slice(2)}`);

  // Busca a corrida em andamento mais recente do passageiro.
  // A subscription realtime abaixo só entrega mudanças FUTURAS, então sem
  // este fetch inicial a corrida "sumia" ao sair e voltar para a tela — era
  // exatamente o bug relatado pelo testador do Android.
  const refreshActiveRide = useCallback(async () => {
    if (!passengerId) return;
    const { data } = await supabase
      .from('rides')
      .select('*')
      .eq('passenger_id', passengerId)
      .in('status', ACTIVE_RIDE_STATUSES)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    setActiveRide((data as Ride) ?? null);
  }, [passengerId]);

  useEffect(() => {
    if (!passengerId) { setLoadingActive(false); return; }

    let cancelled = false;
    setLoadingActive(true);
    refreshActiveRide().finally(() => { if (!cancelled) setLoadingActive(false); });

    const channel = supabase
      .channel(channelIdRef.current)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'rides',
          filter: `passenger_id=eq.${passengerId}`,
        },
        (payload) => {
          const ride = payload.new as Ride;
          if (ACTIVE_RIDE_STATUSES.includes(ride.status)) {
            setActiveRide(ride);
          } else {
            setActiveRide(null);
          }
        }
      )
      .subscribe();

    // Ao voltar para o primeiro plano, o realtime pode ter perdido eventos
    // enquanto o app estava em background — re-busca para garantir consistência.
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refreshActiveRide();
    });

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
      appStateSub.remove();
    };
  }, [passengerId, refreshActiveRide]);

  const requestRide = useCallback(async (
    origin: Location,
    destination: Location,
    routeInfo?: { distanceKm: number; durationMin: number },
    options?: { lockedDriverId?: string }
  ): Promise<Ride | null> => {
    if (!passengerId) return null;

    const distanceKm = routeInfo?.distanceKm ?? haversineDistance(
      { lat: origin.lat, lng: origin.lng },
      { lat: destination.lat, lng: destination.lng }
    );
    const { multiplier } = await getSurgeInfo();
    const duration = routeInfo?.durationMin ?? estimateDuration(distanceKm);
    const fare = estimatePrice(distanceKm, duration, multiplier);
    // Pedágio (P5): 0 por padrão. Repassado integralmente ao motorista — o split
    // 80/20 incide só sobre a tarifa, então toll=0 mantém o comportamento atual.
    const { amount: toll } = await estimateTollAmount({
      origin: { lat: origin.lat, lng: origin.lng },
      destination: { lat: destination.lat, lng: destination.lng },
      distanceKm,
    });
    // Taxa de aeroporto/porto (P6): 0 por padrão. Regulatória → recolhida pela
    // plataforma (entra no platform_fee), não no motorista.
    const { total: venueFee } = await estimateAirportFees(
      { lat: origin.lat, lng: origin.lng },
      { lat: destination.lat, lng: destination.lng },
    );
    const price = Math.round((fare + toll + venueFee) * 100) / 100;
    const split = calculateSplit(fare);
    const driverAmount = Math.round((split.driverAmount + toll) * 100) / 100;
    const platformFee = Math.round((split.platformFee + venueFee) * 100) / 100;

    const insertPayload = {
      passenger_id: passengerId,
      origin_lat: origin.lat,
      origin_lng: origin.lng,
      origin_address: origin.address,
      destination_lat: destination.lat,
      destination_lng: destination.lng,
      destination_address: destination.address,
      status: 'requesting' as RideStatus,
      price,
      distance_km: distanceKm,
      duration_min: duration,
      toll_amount: toll,
      airport_port_fee: venueFee,
      driver_amount: driverAmount,
      platform_fee: platformFee,
      // QR: pré-vincula o motorista; ele ainda precisa aceitar
      ...(options?.lockedDriverId ? { driver_id: options.lockedDriverId } : {}),
    };

    const { error: insertError } = await supabase
      .from('rides')
      .insert(insertPayload);

    if (insertError) {
      reportError(insertError, { op: 'requestRide.insert', passengerId });
      return null;
    }

    // SELECT separado — evita problema de RLS no RETURNING pós-insert
    const { data, error: selectError } = await supabase
      .from('rides')
      .select('*')
      .eq('passenger_id', passengerId)
      .eq('status', 'requesting')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (selectError || !data) {
      reportError(selectError, { op: 'requestRide.select', passengerId });
      return null;
    }

    setActiveRide(data as Ride);
    if (options?.lockedDriverId) {
      // Corrida travada por QR: exclusiva do motorista dono do QR — segue sempre
      // no fluxo legado (o motor v2 é para o pool aberto).
      // Broadcast in-app (confiável mesmo sem push token no Expo Go)
      broadcastToDriver(options.lockedDriverId, data);
      // Push remoto como reforço (funciona em produção)
      notifySpecificDriver(options.lockedDriverId, destination.address, price, (data as Ride).id);
    } else {
      // Pool aberto: com `dispatch_engine_v2` LIGADA, o servidor assume a
      // distribuição (dispatch-engine create → ride_offers). Se a flag estiver
      // OFF (ou der erro), cai no leque legado — sem nunca deixar a corrida sem
      // distribuição.
      const useV2 = await getConfig('dispatch_engine_v2', jurisdiction);
      const handledByEngine = useV2 ? await dispatchEngineCreate((data as Ride).id) : false;
      if (!handledByEngine) {
        notifyOnlineDrivers(destination.address, price, { lat: destination.lat, lng: destination.lng }, (data as Ride).id);
      }
    }
    return data as Ride;
  }, [passengerId, jurisdiction]);

  const scheduleRide = useCallback(async (
    origin: Location,
    destination: Location,
    scheduledFor: Date,
    routeInfo?: { distanceKm: number; durationMin: number },
    options?: { lockedDriverId?: string }
  ): Promise<Ride | null> => {
    if (!passengerId) return null;

    const distanceKm = routeInfo?.distanceKm ?? haversineDistance(
      { lat: origin.lat, lng: origin.lng },
      { lat: destination.lat, lng: destination.lng }
    );
    const duration = routeInfo?.durationMin ?? estimateDuration(distanceKm);
    const fare = estimatePrice(distanceKm, duration);
    // Pedágio (P5): mesma regra do requestRide — pass-through ao motorista, 0 por padrão.
    const { amount: toll } = await estimateTollAmount({
      origin: { lat: origin.lat, lng: origin.lng },
      destination: { lat: destination.lat, lng: destination.lng },
      distanceKm,
    });
    // Taxa de aeroporto/porto (P6): regulatória → recolhida pela plataforma, 0 por padrão.
    const { total: venueFee } = await estimateAirportFees(
      { lat: origin.lat, lng: origin.lng },
      { lat: destination.lat, lng: destination.lng },
    );
    const price = Math.round((fare + toll + venueFee) * 100) / 100;
    const split = calculateSplit(fare);
    const driverAmount = Math.round((split.driverAmount + toll) * 100) / 100;
    const platformFee = Math.round((split.platformFee + venueFee) * 100) / 100;

    const insertPayload = {
      passenger_id: passengerId,
      origin_lat: origin.lat,
      origin_lng: origin.lng,
      origin_address: origin.address,
      destination_lat: destination.lat,
      destination_lng: destination.lng,
      destination_address: destination.address,
      status: 'scheduled' as RideStatus,
      price,
      distance_km: distanceKm,
      duration_min: duration,
      toll_amount: toll,
      airport_port_fee: venueFee,
      scheduled_for: scheduledFor.toISOString(),
      driver_amount: driverAmount,
      platform_fee: platformFee,
      // QR: pré-vincula o motorista; ele ainda precisa aceitar/recusar o agendamento
      ...(options?.lockedDriverId ? { driver_id: options.lockedDriverId } : {}),
    };

    const { error: insertError } = await supabase
      .from('rides')
      .insert(insertPayload);

    if (insertError) {
      reportError(insertError, { op: 'scheduleRide.insert', passengerId });
      return null;
    }

    // SELECT separado — evita problema de RLS no RETURNING pós-insert (mesmo
    // padrão do requestRide). O insert com .select().single() falhava aqui:
    // a policy permite INSERT mas o RETURNING (SELECT implícito) não retornava
    // a linha, quebrando o .single() e fazendo o agendamento "dar erro".
    const { data, error: selectError } = await supabase
      .from('rides')
      .select('*')
      .eq('passenger_id', passengerId)
      .eq('status', 'scheduled')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (selectError || !data) {
      reportError(selectError, { op: 'scheduleRide.select', passengerId });
      return null;
    }
    if (options?.lockedDriverId) {
      // Broadcast in-app (confiável mesmo sem push token no Expo Go)
      broadcastToDriver(options.lockedDriverId, data);
      // Push remoto como reforço (funciona em produção)
      notifySpecificDriverScheduled(options.lockedDriverId, destination.address, price, scheduledFor, (data as Ride).id);
    } else {
      // Notifica motoristas online imediatamente — igual ao requestRide
      notifyOnlineDrivers(destination.address, price, { lat: destination.lat, lng: destination.lng }, (data as Ride).id);
    }
    return data as Ride;
  }, [passengerId]);

  const cancelRide = useCallback(async (rideId: string) => {
    // Descobre se já havia motorista designado ANTES do update — para avisá-lo
    // diretamente (canal pessoal) que a corrida aceita foi cancelada.
    const { data: rideRow } = await supabase
      .from('rides')
      .select('driver_id')
      .eq('id', rideId)
      .maybeSingle();
    const assignedDriverId = (rideRow as { driver_id: string | null } | null)?.driver_id ?? null;

    // Extorna o pagamento se a corrida já tiver sido cobrada
    await refundRide(rideId);

    // Cancelamento atômico: só marca como cancelada se ainda não terminou/cancelou.
    // `.select().maybeSingle()` só retorna linha quando o UPDATE realmente afetou
    // algo — assim só emitimos a revogação quando o cancelamento de fato ocorreu.
    const { data: updated } = await supabase
      .from('rides')
      .update({ status: 'cancelled' as RideStatus })
      .eq('id', rideId)
      .not('status', 'in', '(completed,cancelled)')
      .select('id')
      .maybeSingle();
    setActiveRide(null);

    if (updated) {
      // Tarefa 4: para o alarme de TODOS os motoristas que tenham essa corrida
      // como oferta pendente (som + card somem na hora).
      broadcastRideRevoked(rideId, 'cancelled');
      // Se um motorista já havia ACEITO, avisa-o diretamente para interromper a
      // navegação e voltar ao início ("Corrida cancelada pelo passageiro").
      if (assignedDriverId) {
        broadcastRideCancelledToDriver(assignedDriverId, rideId);
        // Push real (best-effort) — cobre o caso do app do motorista em
        // segundo plano/fechado, quando o broadcast acima não chega porque
        // não há WebSocket conectado na tela de navegação.
        invokeRidePush({ kind: 'ride_cancelled_by_passenger', rideId });
      }
      // PR-c: motor v2 — encerra o `trip_request` no servidor e revoga as ofertas
      // pendentes (para o tick não continuar a distribuir uma corrida cancelada).
      // Best-effort e no-op se a flag estiver OFF (o servidor responde { skipped }).
      const useV2 = await getConfig('dispatch_engine_v2', jurisdiction);
      if (useV2) {
        const { data: tr } = await supabase
          .from('trip_requests').select('id').eq('ride_id', rideId).maybeSingle();
        const tripRequestId = (tr as { id: string } | null)?.id;
        if (tripRequestId) {
          try {
            await supabase.functions.invoke('dispatch-engine', { body: { action: 'cancel', tripRequestId } });
          } catch (e) {
            reportError(e, { op: 'cancelRide.v2', rideId });
          }
        }
      }
    }
  }, [jurisdiction]);

  return { activeRide, loadingActive, refreshActiveRide, requestRide, scheduleRide, cancelRide };
}

export function useScheduledRides(passengerId: string | undefined, jurisdiction: string = 'global') {
  const [rides, setRides] = useState<RideRecord[]>([]);
  const [loading, setLoading] = useState(true);
  // Debounce de reivindicação: evita que um duplo-toque dispare duas chamadas
  // simultâneas de claim para a MESMA corrida (idempotência no cliente, além da
  // garantia atômica no banco). Guardado por rideId.
  const claimingRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    if (!passengerId) return;
    setLoading(true);
    const { data } = await supabase
      .from('rides')
      .select('*')
      .eq('passenger_id', passengerId)
      .eq('status', 'scheduled')
      .order('scheduled_for', { ascending: true });
    setRides((data as RideRecord[]) ?? []);
    setLoading(false);
  }, [passengerId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const activate = useCallback(async (rideId: string): Promise<Ride | null> => {
    // Verifica se já tem motorista pré-confirmado
    const { data: current } = await supabase
      .from('rides').select('driver_id,destination_address,price').eq('id', rideId).single();
    const preAssigned = !!(current as { driver_id?: string })?.driver_id;

    const nextStatus: RideStatus = preAssigned ? 'accepted' : 'requesting';
    const extra = preAssigned ? { accepted_at: new Date().toISOString() } : {};

    const { data } = await supabase
      .from('rides')
      .update({ status: nextStatus, ...extra })
      .eq('id', rideId)
      .select()
      .single();
    await refresh();

    if (data) {
      const ride = data as Ride;
      if (preAssigned) {
        // Notifica o motorista pré-confirmado
        notifyPassenger(ride.passenger_id, ride.id); // reutiliza lógica de push
      } else {
        // Pool aberto (agendada ativada agora → requesting): mesma regra do
        // requestRide — motor v2 quando ligado, com fallback ao leque legado.
        const dest = ride.destination_address ?? ride.destination?.address ?? 'Destino';
        const destLat = ride.destination_lat ?? ride.destination?.lat;
        const destLng = ride.destination_lng ?? ride.destination?.lng;
        const useV2 = await getConfig('dispatch_engine_v2', jurisdiction);
        const handledByEngine = useV2 ? await dispatchEngineCreate(ride.id) : false;
        if (!handledByEngine) {
          notifyOnlineDrivers(dest, Number(ride.price) || 0, destLat != null && destLng != null ? { lat: destLat, lng: destLng } : undefined, ride.id);
        }
      }
    }
    return (data as Ride) ?? null;
  }, [refresh, jurisdiction]);

  const claimScheduledRide = useCallback(async (rideId: string, driverId: string): Promise<boolean> => {
    // Debounce por rideId: se já há um claim desta corrida em andamento, ignora
    // o segundo toque (não dispara segunda chamada de rede).
    if (claimingRef.current.has(rideId)) return false;
    claimingRef.current.add(rideId);
    try {
      const { data, error } = await supabase
        .from('rides')
        // accepted_at marca a decisão do motorista — reivindicar do pool aberto
        // já É a confirmação, então grava junto (mesma semântica usada pelo
        // fluxo de agendamento travado por QR, ver confirmQrScheduledRide).
        .update({ driver_id: driverId, accepted_at: new Date().toISOString() })
        .eq('id', rideId)
        // Reivindica se ainda sem motorista OU se já é DESTE motorista
        // (idempotência: um segundo toque do mesmo motorista devolve sucesso,
        // em vez do falso "já confirmada por outro"). Um agendamento de OUTRO
        // motorista não casa — e o trigger do banco (0042) barra reatribuição.
        .or(`driver_id.is.null,driver_id.eq.${driverId}`)
        .eq('status', 'scheduled')
        // .select().single() é essencial aqui: sem RETURNING, um UPDATE que não
        // bate em nenhuma linha (corrida já reivindicada por outro motorista, ou
        // bloqueada por RLS) volta com error=null e 0 linhas afetadas — ou seja,
        // "sucesso" falso-positivo. Checar `data` é o único jeito de detectar isso.
        .select()
        .maybeSingle();

      if (error || !data) return false;

      const ride = data as Ride;
      // Reaplica a fatia deste motorista ao split (driver_id agora é conhecido).
      applyDriverSplit(rideId, driverId);
      // Remove o card da aba "Agenda" e do popup dos DEMAIS motoristas na hora.
      broadcastRideRevoked(rideId, 'taken', driverId);
      // Avisa o passageiro — mesma notificação usada pela confirmação via popup
      // (confirmScheduledRide), que até então só disparava por aquele caminho.
      broadcastToPassenger(ride.passenger_id, ride.id);
      notifyPassengerScheduleConfirmed(ride.passenger_id, ride.id);

      return true;
    } finally {
      claimingRef.current.delete(rideId);
    }
  }, []);

  const cancel = useCallback(async (rideId: string) => {
    // Cancelamento atômico: só cancela se a corrida ainda não terminou/cancelou.
    // `.select().maybeSingle()` retorna a linha só quando o UPDATE realmente bateu,
    // então detectamos "cancelei agora" vs. "já estava finalizada" — sem isso um
    // UPDATE que não afeta nada volta como sucesso e emitiríamos revogação à toa.
    const { data: updated } = await supabase
      .from('rides')
      .update({ status: 'cancelled' as RideStatus })
      .eq('id', rideId)
      .not('status', 'in', '(completed,cancelled)')
      .select('id')
      .maybeSingle();
    await refresh();
    // Para o alarme de TODOS os motoristas que tenham esse agendamento como oferta.
    if (updated) broadcastRideRevoked(rideId, 'cancelled');
  }, [refresh]);

  return { rides, loading, refresh, activate, cancel, claimScheduledRide };
}

export function useDriverRide(driverId: string | undefined, jurisdiction: string = 'global') {
  // PR-a (dispatch concorrente): fila FIFO de ofertas imediatas. A CABEÇA
  // (offerQueue[0]) é a chamada que o motorista vê/ouve agora; as demais ficam
  // aguardando sem serem canceladas. Com a flag `dispatch_multi_offer_fix`
  // DESLIGADA, `arriveOffer`/`resolveOffer` reduzem a fila a no máximo 1 item —
  // reproduzindo exatamente o slot único legado (`setPendingRide`).
  const multiOffer = useFeatureFlag('dispatch_multi_offer_fix', jurisdiction);
  const multiOfferRef = useRef(multiOffer);
  multiOfferRef.current = multiOffer;

  // PR-c: motor v2 no servidor. Com a flag LIGADA, o card do pool aberto passa a
  // ser dirigido pela tabela `ride_offers` (não mais pelo leque em `rides`).
  // Enquanto OFF, tudo abaixo é no-op e o fluxo legado segue idêntico.
  const engineV2 = useFeatureFlag('dispatch_engine_v2', jurisdiction);
  const engineV2Ref = useRef(engineV2);
  engineV2Ref.current = engineV2;
  // Mapeia trip_request_id ↔ ride_id para não refazer a resolução a cada evento
  // (o aceite v2 precisa do trip_request_id; a revogação precisa do ride_id).
  const tripReqByRideRef = useRef<Map<string, string>>(new Map());
  const rideByTripReqRef = useRef<Map<string, string>>(new Map());

  const [offerQueue, setOfferQueue] = useState<Ride[]>([]);
  const pendingRide = offerQueue.length > 0 ? offerQueue[0] : null;
  // Espelho síncrono da fila para leitura dentro de handlers/intervals.
  const offerQueueRef = useRef<Ride[]>([]);
  useEffect(() => { offerQueueRef.current = offerQueue; }, [offerQueue]);

  // Remove uma oferta por id (de qualquer posição da fila) — se era a cabeça, a
  // próxima assume automaticamente. Idempotente (id ausente = no-op).
  const dismissOffer = useCallback((rideId: string) => {
    setOfferQueue((q) => resolveOffer(q, rideId));
  }, []);

  // PR-c: notifica o SERVIDOR da recusa/expiração desta oferta para promover o
  // próximo candidato IMEDIATAMENTE (motor v2 → dispatch-engine action=reject).
  // No-op quando a flag está OFF ou quando não há trip_request conhecido (fluxo
  // legado / QR). Best-effort: o `tick` do servidor também expira/promove sozinho.
  const rejectServerOffer = useCallback(async (rideId: string) => {
    if (!engineV2Ref.current) return;
    let tripRequestId = tripReqByRideRef.current.get(rideId);
    if (!tripRequestId) {
      const { data: tr } = await supabase
        .from('trip_requests').select('id').eq('ride_id', rideId).maybeSingle();
      tripRequestId = (tr as { id: string } | null)?.id ?? undefined;
    }
    if (!tripRequestId) return;
    try {
      await supabase.functions.invoke('dispatch-engine', { body: { action: 'reject', tripRequestId } });
    } catch (e) {
      reportError(e, { op: 'rejectServerOffer', rideId });
    }
  }, []);

  // Shim compatível com a API antiga `setPendingRide`:
  //   • setPendingRide(ride) → enfileira (FIFO; substitui quando flag off).
  //   • setPendingRide(null) → resolve a CABEÇA atual (promove a próxima).
  // Callers que sabem o id devem preferir `dismissOffer(id)` (por-id, idempotente).
  const setPendingRide = useCallback((r: Ride | null) => {
    if (r) setOfferQueue((q) => arriveOffer(q, r, multiOfferRef.current));
    else setOfferQueue((q) => (q.length > 0 ? q.slice(1) : q));
  }, []);

  const [pendingScheduledRide, setPendingScheduledRide] = useState<Ride | null>(null);
  const [activeRide, setActiveRide] = useState<Ride | null>(null);
  // Corrida que o motorista já tinha em andamento e precisa "retomar" —
  // populada apenas pelo fetch inicial (abaixo) quando o app é aberto/
  // relançado com uma corrida accepted/driver_en_route/in_progress no banco
  // mas nenhuma tela de navegação ativa (app foi morto/crashou no meio da
  // corrida). Consumida por GlobalDriverRideOverlay para navegar de volta.
  const [resumableRide, setResumableRide] = useState<Ride | null>(null);
  const clearResumableRide = useCallback(() => setResumableRide(null), []);
  const channelId = useRef(Math.random().toString(36).slice(2)).current;
  const pendingRideIdRef = useRef<string | null>(null);
  const pendingScheduledRideIdRef = useRef<string | null>(null);
  const activeRideRef = useRef<Ride | null>(null);
  // Dedupe de revogações: broadcastRideRevoked emite DOIS eventos no aceite
  // (ride_offer_revoked + ride_taken legado). Sem isto, uma mesma revogação
  // registraria o log de auditoria duas vezes. Chave = `${rideId}:${reason}`.
  const handledRevocations = useRef<Set<string>>(new Set());

  // Mantém ref sincronizada para usar dentro de setInterval sem stale closure
  useEffect(() => {
    pendingRideIdRef.current = pendingRide?.id ?? null;
    if (__DEV__) console.log(`[${Platform.OS}][dispatch] pendingRide agora =`, pendingRide?.id ?? 'null');
  }, [pendingRide?.id]);

  useEffect(() => {
    pendingScheduledRideIdRef.current = pendingScheduledRide?.id ?? null;
  }, [pendingScheduledRide?.id]);

  // Mantém ref da corrida ativa sincronizada — usada para decidir, fora de
  // qualquer closure de handler, se uma NOVA chamada de corrida pode chegar
  // ao motorista (ver canReceiveNewRideOffer): uma vez que ele inicia o
  // deslocamento de uma corrida (agendada ou não), fica bloqueado para novas
  // chamadas até faltar <=5min para terminar, salvo destino igual/perto (1km).
  useEffect(() => {
    activeRideRef.current = activeRide;
  }, [activeRide]);

  // ─── OfferAlertManager: fechar o card sob ordem do dono único do alerta ──────
  // O singleton (watchdog de 20s, revogação, etc.) pode decidir encerrar uma
  // oferta. Quando isso ocorre para a corrida imediata pendente, ele chama este
  // callback para zerar o `pendingRide` — mantendo o card em sincronia com o som
  // (o som já foi parado pelo próprio stopAll). Só age se ainda for a MESMA
  // corrida, para não apagar uma nova oferta que tenha entrado no meio-tempo.
  useEffect(() => {
    // O singleton, ao levar uma corrida a TERMINAL (stopAll), pede para fechar o
    // card daquele id. Removemos POR ID de qualquer posição da fila — se era a
    // cabeça, a próxima oferta assume; se era da cauda (revogada), some sem
    // tocar a que está tocando. Idempotente.
    return offerAlertManager.registerForceClose((rideId) => {
      dismissOffer(rideId);
    });
  }, [dismissOffer]);

  // Descarta o popup de agendamento automaticamente quando o horário passa
  useEffect(() => {
    if (!pendingScheduledRide?.scheduled_for) return;
    const scheduledAt = new Date(pendingScheduledRide.scheduled_for).getTime();
    const msUntilExpiry = scheduledAt - Date.now();
    if (msUntilExpiry <= 0) {
      setPendingScheduledRide(null);
      return;
    }
    const timer = setTimeout(() => setPendingScheduledRide(null), msUntilExpiry);
    return () => clearTimeout(timer);
  }, [pendingScheduledRide?.scheduled_for]);

  // ─── Retomada de corrida ativa ────────────────────────────────────────────
  // Se o app for aberto/relançado (crash, kill manual, etc.) enquanto o
  // motorista tem uma corrida accepted/driver_en_route/in_progress no banco,
  // a tela DriverNavigate nunca é remontada sozinha — sem isto, a corrida
  // fica "presa" (passageiro esperando, motorista sem navegação ativa).
  // Aqui buscamos essa corrida e expomos via `resumableRide` para que
  // GlobalDriverRideOverlay possa navegar de volta automaticamente.
  useEffect(() => {
    if (!driverId) return;
    supabase
      .from('rides')
      .select('*')
      .eq('driver_id', driverId)
      .in('status', ['accepted', 'driver_en_route', 'in_progress'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setActiveRide(data as Ride);
          setResumableRide(data as Ride);
        }
      });
  }, [driverId]);

  // ─── Fetch inicial ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!driverId) return;

    // Corrida QR pendente já criada (caso motorista abra o app depois do passageiro)
    supabase
      .from('rides')
      .select('*')
      .eq('driver_id', driverId)
      .eq('status', 'requesting')
      .maybeSingle()
      .then(({ data }) => {
        if (
          data &&
          !offerAlertManager.isTombstoned((data as Ride).id) &&
          canReceiveNewRideOffer(activeRideRef.current, data as Ride)
        ) {
          setPendingRide(data as Ride);
        }
      });

    (async () => {
      // Agendamento travado por QR aguardando a decisão deste motorista — tem
      // prioridade sobre o pool aberto e NÃO respeita a janela de 1h (o
      // passageiro escolheu este motorista especificamente e precisa de uma
      // resposta o quanto antes).
      const { data: qrScheduled } = await supabase
        .from('rides')
        .select('*')
        .eq('driver_id', driverId)
        .eq('status', 'scheduled')
        .is('accepted_at', null)
        .order('scheduled_for', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (qrScheduled) {
        setPendingScheduledRide(qrScheduled as Ride);
        return;
      }

      // Corrida agendada disponível no pool aberto — apenas dentro da janela de 1h
      const now = new Date();
      const windowEnd = new Date(now.getTime() + 60 * 60 * 1000);
      const { data: poolRide } = await supabase
        .from('rides')
        .select('*')
        .eq('status', 'scheduled')
        .is('driver_id', null)
        .gte('scheduled_for', now.toISOString())
        .lte('scheduled_for', windowEnd.toISOString())
        .order('scheduled_for', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (poolRide) setPendingScheduledRide(poolRide as Ride);
    })();
  }, [driverId]);

  // ─── Polling: verifica corrida QR a cada 4s ─────────────────────────────────
  // Garante entrega mesmo quando realtime não dispara (ex.: sem REPLICA IDENTITY FULL)
  useEffect(() => {
    if (!driverId) return;

    const interval = setInterval(async () => {
      const { data } = await supabase
        .from('rides')
        .select('*')
        .eq('driver_id', driverId)
        .eq('status', 'requesting')
        .maybeSingle();

      if (
        data &&
        (data as Ride).id !== pendingRideIdRef.current &&
        !offerAlertManager.isTombstoned((data as Ride).id) &&
        canReceiveNewRideOffer(activeRideRef.current, data as Ride)
      ) {
        setPendingRide(data as Ride);
      }
    }, 4000);

    return () => clearInterval(interval);
  }, [driverId]);

  // ─── Polling: PARA o som/card se a chamada pendente já não está disponível ───
  // Backstop robusto para o dispatch em leque. Quando OUTRO motorista aceita uma
  // corrida do pool aberto, os postgres_changes filtrados NÃO disparam para os
  // demais (a corrida deixou de casar `status=requesting` e o `driver_id` agora é
  // de outro), então parar o alarme depende só do broadcast `ride_offer_revoked`
  // — que é efêmero e pode se perder (realtime instável). Este polling confere
  // direto no banco: se a corrida pendente saiu de 'requesting' (foi aceita ou
  // cancelada) ou foi travada para OUTRO motorista, limpa o card AQUI — parando o
  // som — mesmo que o broadcast nunca chegue. É o par "de saída" do polling de
  // entrada acima: um traz a chamada, este a retira quando deixa de ser válida.
  useEffect(() => {
    if (!driverId) return;

    // Uma única verificação: a chamada pendente ainda é uma oferta válida? Se
    // não, limpa o card (e para o som). Compartilhada pelo interval de 1,5s e
    // pelo gatilho de retorno ao primeiro plano abaixo.
    const checkPendingStillValid = async () => {
      const pendingId = pendingRideIdRef.current;
      if (!pendingId) return;

      const { data, error } = await supabase
        .from('rides')
        .select('id,status,driver_id')
        .eq('id', pendingId)
        .maybeSingle();
      // Falha de rede: mantém o estado atual (não silencia por engano).
      if (error) {
        if (__DEV__) console.log(`[${Platform.OS}][backstop] erro no poll, MANTÉM som:`, error.message);
        return;
      }

      // A oferta só continua válida se a corrida ainda está 'requesting' e não foi
      // travada para outro motorista. `data` null = corrida sumiu/ficou invisível
      // (aceita por outro, cancelada) → também deixa de valer.
      const stillOffered =
        !!data &&
        data.status === 'requesting' &&
        (!data.driver_id || data.driver_id === driverId);

      if (__DEV__) {
        console.log(
          `[${Platform.OS}][backstop] poll ride=${pendingId} status=${data?.status ?? 'NULL(rls/sumiu)'} ` +
          `driver=${data?.driver_id ?? 'null'} stillOffered=${stillOffered}`
        );
      }

      // Só limpa se AINDA é a mesma chamada (evita apagar uma nova que entrou
      // entre o disparo do fetch e a sua resposta).
      if (!stillOffered && pendingRideIdRef.current === pendingId) {
        if (__DEV__) console.log(`[${Platform.OS}][backstop] LIMPANDO card/som — oferta não é mais válida`);
        // Encerra o alarme e LAPIDA o id (o forceClose remove da fila e promove a
        // próxima). dismissOffer explícito é defensivo caso o callback ainda não
        // esteja registrado. Remove só ESTA oferta — as demais da fila seguem.
        offerAlertManager.stopAll(pendingId, 'expired');
        dismissOffer(pendingId);
        // Backstop também para a notificação da bandeja, caso o broadcast tenha
        // se perdido e ela ainda esteja lá.
        dismissRideNotifications(pendingId);
      }
    };

    const interval = setInterval(checkPendingStillValid, 1500);

    // Poll IMEDIATO ao voltar para o primeiro plano. Em background o SO congela
    // o setInterval acima, então um motorista com o celular no bolso durante o
    // dispatch reabre o app com o card/som ainda tocando por uma corrida que já
    // foi de outro — e teria de esperar o próximo tick de 1,5s para calar. Aqui a
    // checagem roda no exato instante do retorno, cortando o som fantasma na
    // hora (mesmo mecanismo que refreshActiveRide usa no lado do passageiro).
    const appStateSub = AppState.addEventListener('change', (state) => {
      if (state === 'active') checkPendingStillValid();
    });

    return () => {
      clearInterval(interval);
      appStateSub.remove();
    };
  }, [driverId]);

  // ─── Polling: verifica agendamento QR-travado aguardando decisão a cada 4s ──
  // Mesmo motivo do polling acima — garante entrega mesmo sem realtime, já que
  // este caso NÃO depende da janela de 1h (precisa aparecer assim que criado).
  useEffect(() => {
    if (!driverId) return;

    const interval = setInterval(async () => {
      const { data } = await supabase
        .from('rides')
        .select('*')
        .eq('driver_id', driverId)
        .eq('status', 'scheduled')
        .is('accepted_at', null)
        .order('scheduled_for', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (data && (data as Ride).id !== pendingScheduledRideIdRef.current) {
        setPendingScheduledRide(data as Ride);
      }
    }, 4000);

    return () => clearInterval(interval);
  }, [driverId]);

  // ─── Realtime ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!driverId) return;

    const channel = supabase
      .channel(`driver-ride-${driverId}-${channelId}`)
      // Corridas normais (sem motorista pré-fixado)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'rides',
          filter: `status=eq.requesting`,
        },
        (payload) => {
          const ride = payload.new as Ride;
          // PR-c: com o motor v2 ligado, a oferta do POOL ABERTO chega por
          // `ride_offers` (assinatura dedicada abaixo), não pelo leque em `rides`.
          // Corrida travada por QR (driver_id = este motorista) continua no legado.
          if (engineV2Ref.current && !ride.driver_id) return;
          if (
            (!ride.driver_id || ride.driver_id === driverId) &&
            !offerAlertManager.isTombstoned(ride.id) &&
            canReceiveNewRideOffer(activeRideRef.current, ride)
          ) {
            setPendingRide(ride);
          }
        }
      )
      // Nova corrida agendada — aparece como card de pedido apenas se estiver na janela de 1h
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'rides',
          filter: `status=eq.scheduled`,
        },
        (payload) => {
          const ride = payload.new as Ride;
          if (ride.driver_id === driverId) {
            // Agendamento travado por QR para ESTE motorista — avisa sempre,
            // sem restrição de janela de 1h (ele precisa decidir já).
            setPendingScheduledRide(ride);
            return;
          }
          if (!ride.driver_id && ride.scheduled_for) {
            const now = Date.now();
            const scheduledAt = new Date(ride.scheduled_for).getTime();
            const inWindow = scheduledAt >= now && scheduledAt <= now + 60 * 60 * 1000;
            if (inWindow) setPendingScheduledRide(ride);
          }
        }
      )
      // Corridas agendadas ativadas chegam como UPDATE (scheduled→requesting)
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'rides',
          filter: `status=eq.requesting`,
        },
        (payload) => {
          const ride = payload.new as Ride;
          // PR-c: pool aberto (agendada ativada → requesting) é dirigido pelo
          // motor v2 via `ride_offers` quando a flag está ligada.
          if (engineV2Ref.current) return;
          if (
            !ride.driver_id &&
            !offerAlertManager.isTombstoned(ride.id) &&
            canReceiveNewRideOffer(activeRideRef.current, ride)
          ) {
            setPendingRide(ride);
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'rides',
          filter: `driver_id=eq.${driverId}`,
        },
        (payload) => {
          const ride = payload.new as Ride;
          if (['accepted', 'driver_en_route', 'in_progress'].includes(ride.status)) {
            setActiveRide(ride);
            // Motorista ficou OCUPADO: esvazia toda a fila de ofertas — ele não
            // pode atender outra chamada enquanto vai buscar/conduzir esta. As
            // outras ofertas seguem vivas para os DEMAIS motoristas (cada device
            // tem sua própria fila); aqui só limpamos a fila DESTE motorista.
            setOfferQueue((q) => (q.length > 0 ? [] : q));
          } else {
            setActiveRide(null);
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [driverId]);

  // ─── PR-c: card do POOL ABERTO dirigido por `ride_offers` (motor v2) ─────────
  // Servidor = fonte da verdade. Com `dispatch_engine_v2` LIGADA, as ofertas do
  // pool aberto chegam por esta tabela (INSERT PENDING → card; UPDATE
  // REVOKED/EXPIRED/REJECTED → some), e não mais pelo leque em `rides` (suprimido
  // acima). Também reconstrói o card ao (re)abrir o app a partir das ofertas
  // ainda vivas no servidor (critério 5 — sem card fantasma). Efeito inteiro é
  // no-op enquanto a flag estiver OFF (não abre canal, não lê nada).
  useEffect(() => {
    if (!driverId || !engineV2) return;
    let cancelled = false;

    // Resolve ride_id ← trip_request (com cache), busca a linha de `rides` e
    // enfileira reusando a MESMA fila/UI do card legado (offerQueue).
    const enqueueFromOffer = async (tripRequestId: string) => {
      if (cancelled) return;
      let rideId = rideByTripReqRef.current.get(tripRequestId);
      if (!rideId) {
        const { data: tr } = await supabase
          .from('trip_requests').select('ride_id').eq('id', tripRequestId).maybeSingle();
        rideId = (tr as { ride_id: string | null } | null)?.ride_id ?? undefined;
        if (!rideId) return;
        rideByTripReqRef.current.set(tripRequestId, rideId);
        tripReqByRideRef.current.set(rideId, tripRequestId);
      }
      if (offerAlertManager.isTombstoned(rideId)) return;
      const { data: ride } = await supabase.from('rides').select('*').eq('id', rideId).maybeSingle();
      if (!ride || cancelled) return;
      // Mesma guarda de disponibilidade do fluxo legado (não incomoda motorista
      // já a caminho/em corrida, salvo destino igual/perto).
      if (!canReceiveNewRideOffer(activeRideRef.current, ride as Ride)) return;
      setPendingRide(ride as Ride);
    };

    const dismissFromOffer = (tripRequestId: string) => {
      const rideId = rideByTripReqRef.current.get(tripRequestId);
      if (!rideId) return;
      // TERMINAL: para som/vibração/watchdog, lapida o id e remove SÓ esta oferta
      // da fila (a próxima assume). Idempotente.
      offerAlertManager.stopAll(rideId, 'revoked');
      dismissOffer(rideId);
      dismissRideNotifications(rideId);
    };

    const applyRow = (row: OfferRow) => {
      const rideId = rideByTripReqRef.current.get(row.trip_request_id);
      const action = decideOfferAction(row, {
        driverId,
        nowMs: Date.now(),
        tombstoned: (id) => offerAlertManager.isTombstoned(id),
        rideId,
      });
      if (action === 'enqueue') void enqueueFromOffer(row.trip_request_id);
      else if (action === 'dismiss') dismissFromOffer(row.trip_request_id);
    };

    // Reconstrução (critério 5): ofertas vivas do servidor ao (re)abrir o app.
    (async () => {
      const { data } = await supabase
        .from('ride_offers')
        .select('trip_request_id, driver_id, status, expires_at')
        .eq('driver_id', driverId)
        .eq('status', 'PENDING')
        .order('offered_at', { ascending: true });
      const rows = (data as OfferRow[] | null) ?? [];
      for (const row of livePendingOffers(rows, Date.now(), driverId)) {
        if (cancelled) break;
        await enqueueFromOffer(row.trip_request_id);
      }
    })();

    const channel = supabase
      .channel(`driver-offers-${driverId}-${channelId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'ride_offers', filter: `driver_id=eq.${driverId}` },
        (payload) => applyRow(payload.new as OfferRow)
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'ride_offers', filter: `driver_id=eq.${driverId}` },
        (payload) => applyRow(payload.new as OfferRow)
      )
      .subscribe();

    return () => { cancelled = true; supabase.removeChannel(channel); };
  }, [driverId, engineV2, dismissOffer, setPendingRide]);

  // ─── Broadcast "corrida aceita por outro motorista" ──────────────────────────
  // Modelo de dispatch em leque: a mesma corrida em 'requesting' aparece para
  // todos os motoristas online. Quando um aceita, os postgres_changes filtrados
  // por driver_id NÃO disparam para os demais (a corrida agora pertence a outro),
  // então o overlay ficaria preso. Este canal compartilhado resolve isso: ao
  // aceitar, broadcastRideRevoked avisa todos; quem tiver essa corrida como
  // pendente limpa o overlay na hora.
  useEffect(() => {
    if (!driverId) return;

    // Handler ÚNICO de revogação de oferta (Tarefas 3 e 4). Atende os dois
    // eventos do canal compartilhado — `ride_offer_revoked` (novo, com motivo)
    // e `ride_taken` (legado, só aceite) — sem duplicar lógica. O dedupe por
    // `${rideId}:${reason}` evita registrar o log de auditoria duas vezes já
    // que o aceite emite ambos os eventos.
    const handleRevocation = (
      rideId: string | undefined,
      by: string | undefined,
      reason: RideRevokeReason
    ) => {
      if (__DEV__) {
        console.log(
          `[${Platform.OS}][revoke] broadcast recebido rideId=${rideId} reason=${reason} by=${by} ` +
          `meuPending=${pendingRideIdRef.current} euSou=${driverId}`
        );
      }
      // Decisão determinística isolada (testada em lib/rideRevocation).
      const actions = resolveRevocation(
        { rideId, by, reason },
        {
          driverId,
          pendingRideId: pendingRideIdRef.current,
          pendingScheduledRideId: pendingScheduledRideIdRef.current,
          activeRideId: activeRideRef.current?.id ?? null,
        }
      );

      // Dedupe: broadcastRideRevoked emite dois eventos no aceite
      // (ride_offer_revoked + ride_taken legado) — só auditamos uma vez.
      const key = `${rideId}:${reason}`;
      const firstTime = !handledRevocations.current.has(key);
      handledRevocations.current.add(key);

      // Remove esta oferta se ela estiver na fila do motorista. Com a flag on, a
      // oferta revogada pode estar na CAUDA (não só na cabeça) — resolveRevocation
      // só enxerga a cabeça (pendingRideId), então cobrimos a cauda via a fila.
      const clearThisOffer = multiOfferRef.current
        ? queueHasOffer(offerQueueRef.current, rideId ?? '')
        : actions.clearPendingRide;
      if (clearThisOffer && rideId) {
        // TERMINAL: para o som/vibração/watchdog e lapida o id AGORA — sem
        // depender do unmount do card (que pode atrasar). stopAll também dispensa
        // a notificação e fecha o card via forceClose (remove da fila e promove a
        // próxima); mantemos o dismissOffer explícito para o caso raro de o
        // callback ainda não estar registrado. Só remove ESTA oferta — as demais
        // da fila permanecem.
        offerAlertManager.stopAll(
          rideId,
          reason === 'taken' ? 'taken' : reason === 'expired' ? 'expired' : 'revoked'
        );
        dismissOffer(rideId);
        // Dispensa também a notificação de oferta da bandeja/lockscreen (item 3).
        dismissRideNotifications(rideId);
        if (firstTime) {
          logRideOfferEvent(rideId, driverId, 'taken_by_other', { reason });
        }
      }
      // Mesma corrida agendada (pool aberto) revogada enquanto via o popup.
      if (actions.clearPendingScheduledRide) {
        setPendingScheduledRide(null);
      }
      // Tarefa 4: se o passageiro CANCELOU uma corrida que este motorista já
      // aceitou (é a corrida ativa dele), encerra a corrida ativa — o
      // DriverNavigateScreen escuta esse evento e mostra o aviso + volta ao início.
      if (actions.endActiveRide) {
        setActiveRide(null);
      }
    };

    const ch = supabase
      .channel('ride-offers')
      .on('broadcast', { event: 'ride_offer_revoked' }, ({ payload }) => {
        handleRevocation(
          payload?.rideId as string | undefined,
          payload?.by as string | undefined,
          (payload?.reason as RideRevokeReason | undefined) ?? 'taken'
        );
      })
      .on('broadcast', { event: 'ride_taken' }, ({ payload }) => {
        handleRevocation(
          payload?.rideId as string | undefined,
          payload?.by as string | undefined,
          'taken'
        );
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [driverId]);

  const acceptRide = useCallback(async (
    rideId: string,
    driverLocation?: { lat: number; lng: number } | null
  ): Promise<Ride | null | 'payment_error'> => {
    // 0) SILÊNCIO IMEDIATO: no instante do toque em ACEITAR, avisa os demais
    //    motoristas para PARAR o som e retirar o card AGORA — antes de qualquer
    //    trabalho lento (a cobrança do cartão pode levar até ~20s). Sem isto, os
    //    outros continuariam tocando durante toda a cobrança. É otimista: se o
    //    aceite abortar abaixo (pagamento/corrida já tomada), reofferRide reabre
    //    a corrida e o som/card voltam para os motoristas livres silenciados.
    //    setPendingRide(null) do lado receptor é idempotente (não passa pelo
    //    dedupe), então reasseverar 'taken' mais abaixo é seguro.
    broadcastRideRevoked(rideId, 'taken', driverId);

    // 1) Cobra o cartão do passageiro ANTES de travar a corrida.
    //    Se o pagamento falhar, reabrimos a corrida (reofferRide) para os demais.
    const charge = await chargeRide(rideId);
    if (!charge.ok) {
      reportError(charge.error, { op: 'acceptRide.charge', rideId });
      logRideOfferEvent(rideId, driverId, 'failed', { reason: 'payment_error' });
      // Cobrança falhou → a corrida continua aberta: devolve a chamada (som+card)
      // aos motoristas livres que silenciamos otimisticamente no passo 0.
      reofferRide(rideId);
      return 'payment_error';
    }

    // PR-c: com o motor v2 LIGADO, o VENCEDOR entre aceites simultâneos é eleito
    // ATOMICAMENTE no servidor (RPC accept_trip_offer via dispatch-engine), que
    // também revoga os perdedores e promove o próximo pedido (redispatch). Se
    // este motorista NÃO vencer a disputa, aborta aqui — sem tocar na linha de
    // `rides`. Se vencer (ou se a flag estiver OFF no servidor → resposta
    // { skipped } sem `result`), segue para o UPDATE de `rides` abaixo, que
    // permanece a fonte de tarifa/pagamento. O silêncio otimista do passo 0 já
    // fechou o card dos demais, então na prática só o vencedor chega até aqui.
    if (engineV2Ref.current) {
      let tripRequestId = tripReqByRideRef.current.get(rideId);
      if (!tripRequestId) {
        const { data: tr } = await supabase
          .from('trip_requests').select('id').eq('ride_id', rideId).maybeSingle();
        tripRequestId = (tr as { id: string } | null)?.id ?? undefined;
      }
      if (tripRequestId) {
        try {
          const { data: res, error } = await supabase.functions.invoke('dispatch-engine', {
            body: { action: 'accept', tripRequestId },
          });
          const outcome = res as { result?: string; skipped?: boolean } | null;
          if (error || (outcome?.result && outcome.result !== 'ACCEPTED')) {
            logRideOfferEvent(rideId, driverId, 'taken_by_other', { reason: 'v2_lost' });
            return null;
          }
        } catch (e) {
          // Falha de rede na eleição atômica: não é seguro assumir vitória.
          reportError(e, { op: 'acceptRide.v2', rideId });
          return null;
        }
      }
    }

    // 1) UPDATE (sem RETURNING — o .select().single() falha silenciosamente em alguns casos)
    //    withTimeout: a escrita do supabase-js pode ficar pendurada em rede instável.
    let updateError: unknown = null;
    try {
      const res = await withTimeout(
        supabase
          .from('rides')
          .update({ driver_id: driverId, status: 'accepted' as RideStatus, accepted_at: new Date().toISOString() })
          .eq('id', rideId)
          .eq('status', 'requesting')
          // Aceita apenas se a corrida não estiver travada para outro motorista
          .or(`driver_id.is.null,driver_id.eq.${driverId}`),
        12000,
        'A confirmação da corrida demorou demais.'
      );
      updateError = res.error;
    } catch (e) {
      updateError = e;
    }

    if (updateError) {
      reportError(updateError, { op: 'acceptRide.update', rideId });
      logRideOfferEvent(rideId, driverId, 'taken_by_other', { reason: 'update_error' });
      // Erro ao travar a corrida → reabre (guardado: só reabre se ainda estiver
      // 'requesting' e sem motorista) para o som/card voltarem aos demais.
      reofferRide(rideId);
      return null;
    }

    // 2) SELECT separado para confirmar e obter a corrida atualizada
    let data: unknown = null;
    let selectError: unknown = null;
    try {
      const res = await withTimeout(
        supabase
          .from('rides')
          .select('*')
          .eq('id', rideId)
          .eq('driver_id', driverId)
          .eq('status', 'accepted')
          .single(),
        12000,
        'A confirmação da corrida demorou demais.'
      );
      data = res.data;
      selectError = res.error;
    } catch (e) {
      selectError = e;
    }

    if (selectError || !data) {
      reportError(selectError, { op: 'acceptRide.select', rideId });
      logRideOfferEvent(rideId, driverId, 'taken_by_other', { reason: 'select_failed' });
      return null;
    }

    let ride = data as Ride;

    // 2b) Reaplica a fatia real deste motorista ao split (fire-and-forget) — o
    //     driver_id agora é conhecido, então driver_amount/platform_fee passam a
    //     refletir a faixa de comissão dele (85% ou 80%).
    applyDriverSplit(rideId, driverId!);

    // 3) Calcula o ETA até o embarque para gravar em rides — assim o passageiro
    //    recebe o tempo estimado junto com o aviso de "motorista a caminho".
    //    IMPORTANTE: isso é 100% fire-and-forget agora. O motorista precisa ver o
    //    mapa com a rota traçada IMEDIATAMENTE ao aceitar — nenhuma chamada de
    //    rede (OSRM/telemetria) pode segurar o retorno de acceptRide/a navegação
    //    para DriverNavigateScreen, que já calcula e desenha a própria rota ao
    //    montar (usando a localização do motorista salva no aceite como origem).
    if (driverLocation && ride.origin_lat != null && ride.origin_lng != null) {
      const originForRoute = driverLocation;
      const destForRoute = { lat: ride.origin_lat, lng: ride.origin_lng };
      getRoute(originForRoute, destForRoute)
        .then((path) => {
          if (!path) return;
          const telemetry = {
            driver_lat: originForRoute.lat,
            driver_lng: originForRoute.lng,
            driver_eta_min: path.durationMin,
            driver_eta_km: path.distanceKm,
          };
          return withTimeout(
            supabase.from('rides').update(telemetry).eq('id', rideId),
            8000,
            'telemetry timeout'
          );
        })
        .catch(() => {
          // Sem ETA inicial — DriverNavigateScreen ainda vai calcular e gravar o seu.
        });
    }

    setActiveRide(ride);
    setPendingRide(null);

    // Auditoria: aceite confirmado.
    logRideOfferEvent(rideId, driverId, 'accepted');

    // Reasseveração pós-confirmação: o silêncio primário já saiu no passo 0
    // (otimista). Este segundo 'taken' — agora com a corrida DEFINITIVAMENTE
    // travada — garante que qualquer motorista cujo card tenha surgido no meio
    // do caminho também seja limpo. setPendingRide(null) é idempotente.
    broadcastRideRevoked(rideId, 'taken', driverId);

    // Confirmação ao passageiro: broadcast direto (confiável) + push como fallback
    broadcastRideAccepted(ride.passenger_id, ride);
    notifyPassenger(ride.passenger_id, ride.id, ride.price, ride.driver_eta_min);

    return ride;
  }, [driverId]);

  const confirmScheduledRide = useCallback(async (rideId: string): Promise<boolean> => {
    if (!driverId) return false; // sem motorista logado não há o que confirmar
    const { data, error } = await supabase
      .from('rides')
      // accepted_at marca a decisão do motorista — reivindicar do pool aberto
      // já É a confirmação, então grava junto. Isso mantém accepted_at com o
      // mesmo significado ("motorista confirmou") tanto aqui quanto no fluxo
      // de agendamento travado por QR (confirmQrScheduledRide) — evitando que
      // uma corrida recém-reivindicada seja confundida com uma ainda aguardando
      // decisão nas checagens de polling/realtime abaixo.
      .update({ driver_id: driverId, accepted_at: new Date().toISOString() })
      .eq('id', rideId)
      // Idempotência: confirma se ainda sem motorista OU se já é DESTE motorista
      // (duplo-toque devolve sucesso em vez de falso "já confirmada por outro").
      // O trigger do banco (0042) barra reatribuição para um motorista diferente.
      .or(`driver_id.is.null,driver_id.eq.${driverId}`)
      .eq('status', 'scheduled')
      .select()
      .maybeSingle();

    if (error || !data) return false;
    setPendingScheduledRide(null);

    const ride = data as Ride;

    // Reaplica a fatia deste motorista ao split (driver_id agora é conhecido).
    applyDriverSplit(ride.id, driverId!);

    // Remove o card da aba "Agenda" e do popup dos DEMAIS motoristas na hora
    // (mesmo mecanismo usado em acceptRide para corridas imediatas).
    broadcastRideRevoked(ride.id, 'taken', driverId);

    // Broadcast direto para o passageiro (mais confiável que push/postgres_changes)
    broadcastToPassenger(ride.passenger_id, ride.id);

    // Tenta push remoto como fallback (só funciona se o passageiro tiver token EAS)
    notifyPassengerScheduleConfirmed(ride.passenger_id, ride.id);

    return true;
  }, [driverId]);

  /**
   * Confirma um agendamento que já veio TRAVADO para este motorista (via QR
   * code do passageiro) — diferente de `confirmScheduledRide` (que reivindica
   * uma corrida do pool aberto, ainda sem motorista). Aqui `driver_id` já é
   * deste motorista desde a criação; só falta gravar `accepted_at` para sair
   * do estado "aguardando decisão".
   */
  const confirmQrScheduledRide = useCallback(async (rideId: string): Promise<boolean> => {
    const { data, error } = await supabase
      .from('rides')
      .update({ accepted_at: new Date().toISOString() })
      .eq('id', rideId)
      .eq('driver_id', driverId)
      .eq('status', 'scheduled')
      .is('accepted_at', null)
      .select()
      .single();

    if (error || !data) return false;
    setPendingScheduledRide(null);

    const ride = data as Ride;
    // Reaplica a fatia deste motorista ao split (agendamento travado por QR:
    // driver_id já era dele desde a criação, mas o split fora gravado no padrão).
    applyDriverSplit(ride.id, driverId!);
    // Broadcast direto para o passageiro (mais confiável que push/postgres_changes)
    broadcastToPassenger(ride.passenger_id, ride.id);
    // Tenta push remoto como fallback
    notifyPassengerScheduleConfirmed(ride.passenger_id, ride.id);

    return true;
  }, [driverId]);

  /**
   * Recusa um agendamento travado por QR: libera `driver_id` de volta para
   * `null`, devolvendo a corrida ao pool aberto para outros motoristas, e
   * avisa o passageiro que este motorista não pôde confirmar.
   */
  const rejectScheduledRide = useCallback(async (rideId: string): Promise<boolean> => {
    const { data, error } = await supabase
      .from('rides')
      .update({ driver_id: null })
      .eq('id', rideId)
      .eq('driver_id', driverId)
      .eq('status', 'scheduled')
      .is('accepted_at', null)
      .select()
      .single();

    if (error || !data) return false;
    setPendingScheduledRide(null);

    const ride = data as Ride;
    notifyPassengerScheduleRejected(ride.passenger_id, ride.id);

    return true;
  }, [driverId]);

  /**
   * Grava o novo status da corrida — escrita CRÍTICA: se falhar em silêncio, a
   * corrida fica presa num status ativo pra sempre (bug visto em produção).
   * Por isso: (1) confirma via `.select()` que alguma linha foi realmente
   * atualizada (update bloqueado por RLS ou id inexistente NÃO retorna erro,
   * só 0 linhas); (2) tenta de novo com backoff em falha transitória;
   * (3) devolve `false` em vez de resolver como sucesso, pra tela poder
   * avisar o motorista e não avançar o fluxo.
   */
  const updateRideStatus = useCallback(async (rideId: string, status: RideStatus): Promise<boolean> => {
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const { data, error } = await supabase
        .from('rides')
        .update({ status, ...(status === 'completed' ? { completed_at: new Date().toISOString() } : {}) })
        .eq('id', rideId)
        .select('id');

      if (!error && (data?.length ?? 0) > 0) return true;

      console.warn(
        `[useRide] updateRideStatus('${status}') falhou (tentativa ${attempt}/${MAX_ATTEMPTS}):`,
        error ? error.message : 'nenhuma linha atualizada (id inexistente ou bloqueado por RLS)'
      );
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
      }
    }
    return false;
  }, []);

  return {
    pendingRide, pendingScheduledRide,
    activeRide, acceptRide, confirmScheduledRide,
    confirmQrScheduledRide, rejectScheduledRide,
    updateRideStatus, setPendingRide, setPendingScheduledRide,
    // PR-a: remove UMA oferta por id (idempotente). Preferir a setPendingRide(null)
    // nos caminhos terminais — não remove a próxima oferta já promovida da fila.
    dismissOffer,
    // PR-c: avisa o servidor (motor v2) da recusa/expiração para promover o
    // próximo candidato na hora. No-op quando a flag está OFF.
    rejectServerOffer,
    refundRide,
    resumableRide, clearResumableRide,
  };
}

function haversineDistance(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const x =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((a.lat * Math.PI) / 180) *
      Math.cos((b.lat * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
