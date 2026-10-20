import { useState, useEffect, useCallback, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import { supabase } from '../lib/supabase';
import { dismissRideNotifications } from '../lib/notifications';
import { KM_TO_MILES, formatCurrency } from '../lib/format';
import { getSurgeInfo } from '../lib/surge';
import { composeRideSplit } from '../lib/split';
import { estimateTollAmount } from '../lib/tolls';
import { estimateAirportFees } from '../lib/airportFees';
import { normalizeFlightNumber } from '../lib/airportTrip';
import { getRoute } from '../lib/routing';
import { logRideOfferEvent } from '../lib/rideOfferEvents';
import { canReceiveNewRideOffer } from '../lib/rideDispatch';
import { resolveRevocation, decideOfferSilence, type RideRevokeReason } from '../lib/rideRevocation';
import { offerAlertManager } from '../lib/offerAlertManager';
import { arriveOffer, resolveOffer, queueHasOffer } from '../lib/offerQueue';
import { decideOfferAction, livePendingOffers, type OfferRow } from '../lib/dispatchClientBridge';
import { getConfig } from '../lib/systemConfig';
import { passengerScheduleConflict } from '../lib/scheduleConflict';
import { cancellationPolicy } from '../lib/cancellation';
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
 * O CÁLCULO NÃO MORA MAIS AQUI — E NEM DEPENDE MAIS DESTA CHAMADA. Até a
 * migração 0065 esta função lia price/toll/fee, calculava driver_amount no
 * telefone e escrevia direto em `rides`: o valor do repasse semanal era um
 * número que o app do MOTORISTA mandava, e qualquer um com o token dele fazia
 * `update rides set driver_amount = 5000`.
 *
 * A 0065 tirou o cliente do circuito por inteiro. O split é calculado pelo
 * trigger `guard_ride_money_fields`, na MESMA linha e no MESMO statement do
 * UPDATE de aceite (ou do INSERT, no caminho do QR, em que a corrida já nasce
 * com driver_id). Isso fecha a janela que existia entre "a corrida virou minha"
 * e "meu percentual foi aplicado" — janela em que `charge-ride` já tinha
 * marcado paid = true e um saque/cron podia reservar a corrida com o padrão de
 * 80%, congelando o motorista de 85% num valor errado para sempre. Perda de
 * rede ou crash do app entre o UPDATE e esta RPC dava o mesmo estrago.
 *
 * Esta chamada continua aqui como CINTO E SUSPENSÓRIO: `apply_driver_split` é
 * idempotente e hoje é um no-op no caminho feliz. Ela ainda serve para (a)
 * reparar corridas aceitas antes da 0065 e (b) recalcular quando a faixa de
 * comissão é atribuída DEPOIS do aceite (assign_driver_tier roda no webhook
 * account.updated do Stripe). O erro é aguardado e reportado, mas NÃO derruba o
 * aceite — o split já está gravado pelo trigger de qualquer forma.
 */
async function applyDriverSplit(rideId: string): Promise<void> {
  try {
    const { error } = await supabase.rpc('apply_driver_split', { p_ride_id: rideId });
    if (error) reportError(error, { op: 'applyDriverSplit.rpc', rideId });
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

/**
 * Cancela uma corrida AGENDADA. Autônoma (fora de hook) porque DUAS telas
 * precisam dela: a lista de agendamentos e a de detalhes da viagem, aberta pelo
 * histórico. Enquanto ela morava só dentro de `useScheduledRides`, a segunda
 * tela simplesmente não oferecia cancelamento — o defeito relatado com print.
 *
 * Cancelamento ATÔMICO: o `.not('status','in',...)` garante que só cancelamos o
 * que ainda está em pé, e o `.select().maybeSingle()` diz se o UPDATE bateu de
 * fato. Sem isso, um UPDATE que não afeta linha nenhuma volta como sucesso e
 * emitiríamos revogação de uma corrida que já tinha acabado.
 *
 * NÃO cobra nada. A tarifa do cancelamento tardio é anunciada pela tela
 * (`src/lib/cancellation.ts`) e não executada em lugar nenhum — está escrito lá
 * por quê.
 */
export async function cancelScheduledRide(rideId: string, reason?: string): Promise<boolean> {
  const { data: updated, error } = await supabase
    .from('rides')
    .update({
      status: 'cancelled' as RideStatus,
      cancelled_at: new Date().toISOString(),
      ...(reason ? { cancellation_reason: reason } : {}),
    })
    .eq('id', rideId)
    .not('status', 'in', '(completed,cancelled)')
    .select('id')
    .maybeSingle();

  // Erro explícito: o agendamento NÃO foi cancelado. Devolvemos a falha para a
  // tela poder dizê-la ao passageiro, em vez de sumir com o card e mentir.
  if (error) {
    reportError(error, { op: 'scheduled.cancel', rideId });
    return false;
  }
  // Para o alarme de TODOS os motoristas que tenham esse agendamento como oferta.
  if (updated) broadcastRideRevoked(rideId, 'cancelled');
  // `updated == null` sem erro = já estava finalizada/cancelada; do ponto de
  // vista do passageiro o agendamento não está mais ativo, então é sucesso.
  return true;
}

/** Motivo gravado na linha quando o passageiro cancela dentro da última hora. */
export const LATE_CANCEL_REASON = 'passenger_late_cancel';

/** O que aconteceu num cancelamento — a tela precisa dizer a verdade ao passageiro. */
export type CancelScheduleOutcome =
  /** Cancelado dentro da janela grátis. Nada foi cobrado. */
  | { ok: true; charged: false }
  /** Cancelado na última hora e a tarifa FOI cobrada. */
  | { ok: true; charged: true; amountDollars: number }
  /** Cancelado na última hora e a cobrança FALHOU — a corrida foi cancelada assim mesmo. */
  | { ok: true; charged: false; chargeError: string }
  /** O servidor recusou o cancelamento. A corrida continua de pé. */
  | { ok: false };

/**
 * Cancela um agendamento APLICANDO A POLÍTICA: grátis com mais de 1h de
 * antecedência, tarifa integral dentro da última hora (`src/lib/cancellation.ts`).
 *
 * ── A ORDEM É CANCELAR PRIMEIRO, COBRAR DEPOIS. E ISSO É DELIBERADO ─────────
 *
 * O instinto é o contrário — cobrar antes, como `activate` faz. Lá está certo:
 * se o cartão recusa, a corrida NÃO começa, e o pior desfecho é ninguém sair do
 * lugar. Aqui os desfechos não são simétricos:
 *
 *   • cobrar primeiro e o cancelamento falhar → passageiro COBRADO com a
 *     corrida ainda de pé e o motorista a caminho. Dinheiro tirado por um
 *     serviço que segue agendado;
 *   • cancelar primeiro e a cobrança falhar → a plataforma perde a multa. O
 *     motorista fica sabendo cedo, que é o que mais importa para ele.
 *
 * O segundo é o erro reversível, e é o mesmo raciocínio já escrito em
 * `cancelRide` sobre o estorno: trocar dinheiro retido por passageiro trancado
 * não é conserto, é mudar de vítima.
 *
 * ── FALHA DE COBRANÇA NÃO TRANCA O CANCELAMENTO ────────────────────────────
 *
 * Se a cobrança falhar, a corrida JÁ FOI cancelada e assim fica. Bloquear o
 * cancelamento porque o cartão recusou produziria o pior desfecho possível para
 * o motorista: o passageiro não consegue cancelar, não avisa ninguém, e
 * simplesmente não aparece — viagem perdida E sem multa. A falha volta no
 * retorno para a tela poder dizê-la.
 *
 * ⚠️ COBRA MESMO SEM MOTORISTA DESIGNADO. A regra do produto é por RELÓGIO, não
 * por motorista: dentro da última hora, cobra. Vale registrar que o texto que a
 * tela mostra (`scheduled.policyChargedBody1`) diz "um motorista já confirmou
 * esta corrida" — quando não há motorista, a multa é receita da plataforma sem
 * ninguém para compensar, e o rótulo mente. É candidato natural a disputa de
 * cartão. Se o produto quiser restringir a multa aos agendamentos JÁ
 * CONFIRMADOS, o lugar de mudar é aqui e em `cancellation.ts`, não na cópia.
 */
export async function cancelScheduledRideWithPolicy(
  ride: { id: string; scheduled_for?: string | null; price?: number | null },
  nowMs: number = Date.now(),
): Promise<CancelScheduleOutcome> {
  const politica = cancellationPolicy(ride, nowMs);

  const cancelou = await cancelScheduledRide(
    ride.id,
    politica.free ? undefined : LATE_CANCEL_REASON,
  );
  if (!cancelou) return { ok: false };

  if (politica.free) return { ok: true, charged: false };

  // Multa. `charge-ride` cobra `rides.price` — a tarifa integral, que é
  // exatamente o que a política anuncia — e é idempotente pelos dois lados
  // (flag `paid` no banco + idempotencyKey no Stripe), então um duplo-toque não
  // cobra duas vezes.
  const charge = await chargeRide(ride.id);
  if (!charge.ok) {
    reportError(charge.error, { op: 'lateCancel.charge', rideId: ride.id });
    return { ok: true, charged: false, chargeError: charge.error ?? 'falha na cobrança' };
  }
  // A corrida fica `cancelled` com `paid = true`: é a multa retida de propósito,
  // e é `cancellation_reason` que distingue isso de uma corrida cobrada e
  // abandonada. O repasse semanal leva o `driver_amount` ao motorista quando há
  // um designado — que é a compensação que a política promete.
  return { ok: true, charged: true, amountDollars: politica.chargeDollars };
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
 * usuário nem manda título/corpo livre nem a lista de alvos — só `kind` +
 * `rideId` (+ `exceptDriverId`, que é o próprio chamador se excluindo, não uma
 * escolha sobre terceiros). Best-effort: falhas são engolidas, nunca bloqueiam o
 * fluxo de corrida (mesma filosofia do antigo sendPushAsync).
 */
async function invokeRidePush(body: {
  kind: string;
  rideId: string;
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

async function notifyOnlineDrivers(rideId: string) {
  if (!rideId) return;

  // O client NÃO manda mais a lista de alvos. Ele diz só qual corrida abriu; o
  // leque é derivado no servidor (send-ride-push, com a service key).
  //
  // Antes, esta função consultava `driver_locations` e mandava os ids junto.
  // Duas consequências, e a segunda é a grave:
  //
  //   • o servidor gravava PROVA DE OFERTA sobre uma lista de origem do
  //     cliente — quem controlasse o app escolhia quem ganhava direito de
  //     cobrança (isso saiu; a autorização hoje é derivada no charge-ride);
  //   • e este `return` antecipado dava ao CLIENTE o poder de cancelar a
  //     distribuição inteira: leitura vazia, RLS mudando de baixo, rede caindo
  //     no meio — qualquer um deles e a corrida nascia sem NENHUM push, sem
  //     erro nenhum aparecer. Agora a requisição sempre sai; se não houver
  //     ninguém online, quem constata isso é o servidor.
  //
  // Título/corpo são templates fixos no servidor, que lê destination/price
  // direto da linha de `rides`. E quem de fato recebe o toque também é decidido
  // lá: o filtro de "não incomoda motorista já a caminho" precisa enxergar a
  // corrida ativa de OUTRO passageiro com OUTRO motorista, e a RLS de `rides`
  // (0067) não mostra isso ao passageiro — nem deve.
  await invokeRidePush({ kind: 'new_ride_broadcast', rideId });
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
    // Mesma mudança do `notifyOnlineDrivers`: o leque sai do servidor. Aqui o
    // `return` antecipado sobre lista vazia era pior que lá — silenciar é o que
    // impede o telefone dos outros motoristas de continuar tocando por uma
    // corrida que já tem dono.
    await invokeRidePush({ kind: 'silent_revoke', rideId, exceptDriverId });
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

// ── Tarifa GoXL — Uber XL (Orlando, FL) + $0,25/milha, tudo + 10% ───────────
// Referência Uber XL Orlando: base $3,00 · $1,21/milha · $0,20/min · mínimo
// $8,90 · booking fee $3,00.
//
// Sobre essa referência incidem, nesta ordem:
//   1. o PRÊMIO DE MILHA de $0,25, embutido na tarifa por milha (1,21 → 1,46);
//   2. o surge de pico, sobre a parte metrada (base + distância + tempo);
//   3. o markup de 10% da GoXL, sobre o total.
//
// ── O QUE O PASSAGEIRO PAGA A MAIS, DE FATO ────────────────────────────────
//
// O prêmio foi posto na tarifa BASE por decisão de produto (27/08/2026), então
// ele é multiplicado pelas duas etapas seguintes. Na prática:
//
//   hora normal   +$0,25 × 1,10        = +$0,275 por milha
//   pico (1,3×)   +$0,25 × 1,3 × 1,10  = +$0,3575 por milha
//
// Ou seja: NÃO são $0,25 líquidos na conta do passageiro. Se um dia a intenção
// virar "exatamente $0,25 por milha, sempre", o lugar do acréscimo deixa de ser
// aqui e passa a ser depois do markup, em `estimatePrice`.
//
// A quantidade de motoristas GoXL online NÃO entra no preço — só horário
// (pico) e local (taxas de aeroporto/porto, P6).
const UBER_XL_BASE_FARE   = 3.0;   // USD
/** $1,21 da Uber XL + $0,25 de prêmio GoXL. Ver o bloco acima. */
const UBER_XL_PER_MILE    = 1.46;  // USD por milha
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

/** Voo e terminal de uma corrida para aeroporto (ver lib/airportTrip). */
export interface FlightInfo {
  number: string;
  terminal: string;
}

// As colunas só entram no insert quando há voo: corrida comum continua com o
// payload de sempre, e por isso não depende da migration 0088 estar aplicada.
function flightColumns(
  flight?: FlightInfo
): { flight_number?: string; airport_terminal?: string } {
  if (!flight) return {};
  return {
    flight_number: normalizeFlightNumber(flight.number),
    airport_terminal: flight.terminal.trim(),
  };
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
    const { data, error } = await supabase
      .from('rides')
      .select('*')
      .eq('passenger_id', passengerId)
      .in('status', ACTIVE_RIDE_STATUSES)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    // O erro era descartado e o `?? null` LIMPAVA a corrida ativa: uma falha de
    // rede/RLS ficava indistinguível de "você não tem corrida em andamento". O
    // passageiro voltava para a home no meio da viagem, via a tela de pedir
    // corrida como se nada estivesse acontecendo, e podia pedir uma segunda
    // corrida (e ser cobrado duas vezes) enquanto a primeira seguia ativa no
    // banco, com o motorista a caminho. Na falha preservamos o que já sabíamos —
    // só o servidor RESPONDENDO "não há corrida" zera o estado.
    if (error) {
      reportError(error, { op: 'refreshActiveRide', passengerId });
      return;
    }
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
    options?: { lockedDriverId?: string; flight?: FlightInfo }
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
    // Split PADRÃO (80%): no pedido o motorista ainda é desconhecido (pool
    // aberto).
    //
    // Contra uma base COM a 0065 aplicada, estes dois campos são DESCARTADOS no
    // insert (o trigger guard_ride_money_fields zera as colunas de dinheiro do
    // cliente) e o valor real é calculado no servidor quando o motorista entra
    // na corrida. Continuam no payload de propósito: contra uma base ainda SEM
    // a 0065 — a janela entre publicar o app e aplicar a migração — são eles que
    // mantêm o repasse funcionando. É o único arranjo que sobrevive às duas
    // ordens de deploy.
    const { driverAmount, platformFee } = composeRideSplit(price, toll, venueFee);

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
      ...flightColumns(options?.flight),
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
        notifyOnlineDrivers((data as Ride).id);
      }
    }
    return data as Ride;
  }, [passengerId, jurisdiction]);

  const scheduleRide = useCallback(async (
    origin: Location,
    destination: Location,
    scheduledFor: Date,
    routeInfo?: { distanceKm: number; durationMin: number },
    options?: { lockedDriverId?: string; flight?: FlightInfo }
  ): Promise<Ride | null | 'conflict'> => {
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
    // Split padrão — mesma regra do requestRide, inclusive quanto ao descarte
    // pelo servidor com a 0065 aplicada (ver comentário lá).
    const { driverAmount, platformFee } = composeRideSplit(price, toll, venueFee);

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
      ...flightColumns(options?.flight),
    };

    // ── Vários agendamentos, sim; dois no mesmo horário, não ─────────────────
    //
    // Regra de produto: o passageiro pode ter quantas corridas marcadas quiser,
    // desde que não se sobreponham no tempo. A regra do MOTORISTA
    // (`checkScheduleConflict`) não serve aqui — ela soma deslocamento entre
    // corridas e 20 min de folga porque é o mesmo carro atendendo as duas, e
    // recusaria coisa legítima do passageiro. Ver `passengerScheduleConflict`.
    //
    // FALHA DE LEITURA NÃO BARRA O AGENDAMENTO. Se esta consulta cair (rede,
    // RLS), seguimos e criamos a corrida. Os dois erros possíveis não têm o
    // mesmo tamanho: uma sobreposição que escapa é reversível — o passageiro
    // cancela um dos dois, de graça até 60 min antes (ScheduledRidesScreen) —,
    // enquanto recusar por falha de rede transforma instabilidade em "o app não
    // me deixa mais agendar", que é exatamente o defeito relatado.
    const { data: jaMarcadas, error: conflitoErr } = await supabase
      .from('rides')
      .select('id, scheduled_for, duration_min')
      .eq('passenger_id', passengerId)
      .eq('status', 'scheduled');

    if (conflitoErr) {
      reportError(conflitoErr, { op: 'scheduleRide.conflictCheck', passengerId });
    } else {
      const conflito = passengerScheduleConflict(
        { scheduled_for: scheduledFor.toISOString(), duration_min: duration },
        (jaMarcadas ?? []) as { id: string; scheduled_for: string | null; duration_min: number | null }[],
      );
      if (conflito.conflict) return 'conflict';
    }

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
      notifyOnlineDrivers((data as Ride).id);
    }
    return data as Ride;
  }, [passengerId]);

  // Devolve se o cancelamento foi REALMENTE confirmado pelo servidor. Antes esta
  // função era `Promise<void>` e chamava `setActiveRide(null)` incondicionalmente:
  // com o UPDATE recusado (rede caída, RLS, corrida já finalizada) a corrida sumia
  // da tela do passageiro e as telas que chamam isto navegavam para a home como se
  // estivesse cancelada — enquanto no banco ela seguia ativa, com o motorista a
  // caminho e a tarifa retida. O preço deste retorno é que todo chamador precisa
  // tratar o `false`; é exatamente o ponto.
  const cancelRide = useCallback(async (rideId: string): Promise<boolean> => {
    // Descobre se já havia motorista designado ANTES do update — para avisá-lo
    // diretamente (canal pessoal) que a corrida aceita foi cancelada.
    const { data: rideRow } = await supabase
      .from('rides')
      .select('driver_id, paid')
      .eq('id', rideId)
      .maybeSingle();
    const row = rideRow as { driver_id: string | null; paid: boolean | null } | null;
    const assignedDriverId = row?.driver_id ?? null;

    // Extorna o pagamento se a corrida já tiver sido cobrada.
    //
    // O resultado era DESCARTADO aqui, enquanto o lado do MOTORISTA já aborta
    // (DriverNavigateScreen: "const refund = await refundRide(...); if
    // (!refund.ok) return"). A assimetria é o defeito: pelo caminho do
    // passageiro, uma falha do estorno cancelava a corrida assim mesmo e o
    // dinheiro seguia retido no cartão dele, sem aviso a ninguém. É o mesmo
    // dinheiro e a mesma promessa — tem que ser a mesma regra.
    //
    // MAS o abort só pode valer quando existe dinheiro em jogo. Uma versão
    // anterior deste bloco barrava o cancelamento sempre que `refundRide`
    // falhasse, justificando-se em que `refund-ride` devolve `no_charge: true`
    // para corrida sem cobrança (refund-ride:208). O raciocínio tinha um buraco:
    // isso só vale quando a Edge Function RESPONDE. Fora do ar (5xx, cold start,
    // 401), `refundRide` cai no catch e devolve `ok: false` para TODA corrida,
    // cobrada ou não — e aí o passageiro em `FindingDriverScreen` ficava PRESO,
    // porque lá o `beforeRemove` dá `preventDefault()` e o cancelamento é a
    // única saída da tela (FindingDriverScreen:161,191-193). Trocar dinheiro
    // retido por passageiro trancado não é conserto, é mudar de vítima.
    //
    // Por isso o gate é `paid`, lido no mesmo SELECT acima — sem round-trip
    // extra. Não cobrada: não há o que estornar, cancela direto e o
    // `refund-ride` sequer é chamado. Cobrada: aí sim o estorno é condição, e a
    // regra fica idêntica à do motorista (DriverNavigateScreen:772-782).
    if (row?.paid === true) {
      const refund = await refundRide(rideId);
      if (!refund.ok) {
        reportError(new Error(refund.error ?? 'refund failed'), { op: 'cancelRide.refund', rideId });
        return false;
      }
    }

    // Cancelamento atômico: só marca como cancelada se ainda não terminou/cancelou.
    // `.select().maybeSingle()` só retorna linha quando o UPDATE realmente afetou
    // algo — assim só emitimos a revogação quando o cancelamento de fato ocorreu.
    const { data: updated, error: updateError } = await supabase
      .from('rides')
      .update({ status: 'cancelled' as RideStatus })
      .eq('id', rideId)
      .not('status', 'in', '(completed,cancelled)')
      .select('id')
      .maybeSingle();

    // Erro explícito do servidor: a corrida NÃO foi cancelada. Manter
    // `activeRide` é o que preserva a verdade na tela (o passageiro continua
    // vendo a corrida em andamento) e permite tentar de novo.
    if (updateError) {
      reportError(updateError, { op: 'cancelRide.update', rideId });
      return false;
    }

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

    // `updated == null` sem erro = o UPDATE não bateu em nenhuma linha porque a
    // corrida já estava completed/cancelled. Também é "não está mais ativa",
    // então sair da tela é honesto.
    return true;
  }, [jurisdiction]);

  return { activeRide, loadingActive, refreshActiveRide, requestRide, scheduleRide, cancelRide };
}

export function useScheduledRides(passengerId: string | undefined, jurisdiction: string = 'global') {
  const [rides, setRides] = useState<RideRecord[]>([]);
  const [loading, setLoading] = useState(true);
  /** true quando a última leitura da agenda falhou — ver `refresh` abaixo. */
  const [loadFailed, setLoadFailed] = useState(false);
  // Debounce de reivindicação: evita que um duplo-toque dispare duas chamadas
  // simultâneas de claim para a MESMA corrida (idempotência no cliente, além da
  // garantia atômica no banco). Guardado por rideId.
  const claimingRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    if (!passengerId) return;
    setLoading(true);
    const { data, error } = await supabase
      .from('rides')
      .select('*')
      .eq('passenger_id', passengerId)
      .eq('status', 'scheduled')
      .order('scheduled_for', { ascending: true });
    // O erro era descartado e o `?? []` esvaziava a lista: uma falha de rede ou
    // de RLS ficava visualmente idêntica a "você não tem nenhum agendamento".
    // O passageiro concluía que a viagem marcada para amanhã tinha sumido — e
    // ela continuava lá, com a política de cancelamento correndo. Agora, na
    // falha, PRESERVAMOS a última lista conhecida e marcamos `loadFailed` para
    // a tela poder avisar que os dados podem estar desatualizados.
    setLoadFailed(!!error);
    if (!error) setRides((data as RideRecord[]) ?? []);
    setLoading(false);
  }, [passengerId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const activate = useCallback(async (rideId: string): Promise<Ride | null | 'payment_error'> => {
    // Verifica se já tem motorista pré-confirmado
    const { data: current } = await supabase
      .from('rides').select('driver_id,destination_address,price').eq('id', rideId).single();
    const preAssigned = !!(current as { driver_id?: string })?.driver_id;

    // COBRANÇA DO AGENDAMENTO. Uma agendada com motorista já confirmado vai
    // daqui direto para 'accepted' — ela NUNCA passa por acceptRide, que era o
    // único lugar do app que chamava chargeRide. Resultado do buraco: toda
    // corrida agendada e confirmada em avanço rodava de graça, e no Stripe só
    // aparecia a gorjeta do fim (que tem função e PaymentIntent próprios).
    // Cobramos ANTES de travar o status, igual ao aceite imediato: se o cartão
    // recusar, a corrida NÃO começa. `charge-ride` é idempotente (flag `paid` +
    // idempotencyKey `charge_<rideId>`), então o caminho sem motorista, que
    // segue para o leque e cobra no aceite, não corre risco de cobrar duas vezes.
    if (preAssigned) {
      const charge = await chargeRide(rideId);
      if (!charge.ok) {
        reportError(charge.error, { op: 'activateScheduled.charge', rideId });
        return 'payment_error';
      }
    }

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
        // SPLIT DO AGENDAMENTO PRÉ-CONFIRMADO. Esta era a única porta de
        // aceite que NUNCA reaplicava a fatia real do motorista: a agendada
        // travada por QR nasce com driver_id preenchido e vai daqui direto para
        // 'accepted', sem passar por acceptRide/confirmScheduledRide, que eram
        // os únicos lugares que chamavam applyDriverSplit. Resultado do buraco:
        // o split ficava no padrão gravado no insert (80%) e um motorista de
        // 85% era pago a menos, em silêncio, em toda corrida agendada por QR.
        //
        // Roda no app do PASSAGEIRO — por isso apply_driver_split aceita as
        // duas pontas da corrida (ver a migração 0065). Ele não escolhe nada:
        // o valor sai inteiro do servidor.
        await applyDriverSplit(ride.id);
        // Notifica o motorista pré-confirmado
        notifyPassenger(ride.passenger_id, ride.id); // reutiliza lógica de push
      } else {
        // Pool aberto (agendada ativada agora → requesting): mesma regra do
        // requestRide — motor v2 quando ligado, com fallback ao leque legado.
        const useV2 = await getConfig('dispatch_engine_v2', jurisdiction);
        const handledByEngine = useV2 ? await dispatchEngineCreate(ride.id) : false;
        if (!handledByEngine) {
          notifyOnlineDrivers(ride.id);
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
      await applyDriverSplit(rideId);
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

  /**
   * Devolve se o cancelamento foi de fato aceito pelo servidor. Antes era
   * `Promise<void>` e o erro do UPDATE era descartado: a tela chamava isto sem
   * `await` e o card do agendamento continuava lá, sem explicação nenhuma. Pior,
   * dentro da janela de 60 min o cancelamento é COBRADO — o passageiro tocava
   * "cancelar mesmo assim", não via nada mudar, tocava de novo, e seguia sem
   * saber se ia ser cobrado uma vez, duas ou nenhuma.
   */
  const cancel = useCallback(async (rideId: string): Promise<boolean> => {
    const ok = await cancelScheduledRide(rideId);
    // Só relemos a lista quando o servidor confirmou: num erro nada mudou, e um
    // refresh à toa só pisca a tela.
    if (ok) await refresh();
    return ok;
  }, [refresh]);

  return { rides, loading, loadFailed, refresh, activate, cancel, claimScheduledRide };
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
  //
  // Atribuído EM RENDER, como `multiOfferRef` logo acima. Antes a sincronia
  // morava num `useEffect(..., [offerQueue])`, que roda DEPOIS do commit: se um
  // `ride_offer_revoked` chegasse ENTRE O COMMIT E O FLUSH DO EFEITO PASSIVO,
  // `queueHasOffer(offerQueueRef.current, ...)` respondia sobre a fila ANTERIOR
  // — `offerInQueue: false` para uma oferta que está na fila. Em modo multi isso
  // é exatamente `silenceThisOffer = false`: o telefone segue tocando por uma
  // corrida já dada a outro motorista, que é o defeito que `decideOfferSilence`
  // existe para evitar, reentrando pela porta do chamador.
  //
  // O QUE ISTO **NÃO** FECHA, para ninguém confiar demais: a janela do MESMO
  // macrotask. `setOfferQueue` é assíncrono e em lote, e o render só acontece
  // numa tarefa posterior — um evento que chegue antes desse render lê o ref
  // velho exatamente como antes. Essa janela não é fechável por ref; fechá-la
  // exigiria a fila viver no próprio ref (fonte da verdade) com o `useState`
  // servindo só para pintar.
  const offerQueueRef = useRef<Ride[]>([]);
  offerQueueRef.current = offerQueue;

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

  // Mantém ref sincronizada para usar dentro de setInterval sem stale closure.
  // Em render, pelo mesmo motivo do `offerQueueRef` acima: `pendingRide` é a
  // CABEÇA de `offerQueue`, e as duas entradas de `decideOfferSilence`
  // precisam vir do MESMO commit — se uma for velha e a outra nova, a decisão
  // é tomada sobre um estado que nunca existiu.
  pendingRideIdRef.current = pendingRide?.id ?? null;

  useEffect(() => {
    if (__DEV__) console.log(`[${Platform.OS}][dispatch] pendingRide agora =`, pendingRide?.id ?? 'null');
  }, [pendingRide?.id]);

  // As outras DUAS entradas de `resolveRevocation` (:1616-1618). Também em
  // render, e não em `useEffect`, pelo mesmo motivo — mas registrar por que a
  // meia-correção era pior que não ter corrigido nada:
  //
  // enquanto só `pendingRideIdRef` vinha do render e estes dois vinham do
  // efeito, uma única chamada de `resolveRevocation` misturava commits. No
  // aceite, `setActiveRide(ride)` e a saída da oferta da fila caem no MESMO
  // lote; depois do commit, `pendingRideIdRef` já é `null` e `activeRideRef`
  // ainda é `null` porque o efeito passivo não rodou. Um broadcast
  // `'cancelled'` nessa janela decide sobre um estado que nunca existiu e
  // devolve `endActiveRide: false` — o motorista segue navegando para uma
  // corrida cancelada.
  //
  // `activeRideRef` também alimenta `canReceiveNewRideOffer` (:1219, :1280,
  // :1417, :1465, :1527): uma vez iniciado o deslocamento, o motorista fica
  // bloqueado para novas chamadas até faltar <=5min, salvo destino igual/perto.
  pendingScheduledRideIdRef.current = pendingScheduledRide?.id ?? null;
  activeRideRef.current = activeRide;

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
      const alreadyHandled = handledRevocations.current.has(key);
      handledRevocations.current.add(key);

      // A regra em si mora em `decideOfferSilence` (src/lib/rideRevocation.ts),
      // pura e com teste próprio. Aqui ficam só os efeitos.
      const silence = decideOfferSilence({
        reason,
        multiOffer: multiOfferRef.current,
        offerInQueue: queueHasOffer(offerQueueRef.current, rideId ?? ''),
        clearPendingRide: actions.clearPendingRide,
        alreadyHandled,
      });
      if (silence.silenceThisOffer && rideId) {
        // TERMINAL: para o som/vibração/watchdog e lapida o id AGORA — sem
        // depender do unmount do card (que pode atrasar). stopAll também dispensa
        // a notificação e fecha o card via forceClose (remove da fila e promove a
        // próxima); mantemos o dismissOffer explícito para o caso raro de o
        // callback ainda não estar registrado. Só remove ESTA oferta — as demais
        // da fila permanecem.
        offerAlertManager.stopAll(rideId, silence.alertReason);
        dismissOffer(rideId);
        // Dispensa também a notificação de oferta da bandeja/lockscreen (item 3).
        dismissRideNotifications(rideId);
        if (silence.logTakenByOther) {
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

    // 2b) Reaplica a fatia real deste motorista ao split — o driver_id agora é
    //     conhecido, então driver_amount/platform_fee passam a refletir a faixa
    //     de comissão dele (85% ou 80%). Awaited: o RPC é uma ida rápida ao
    //     banco e um split errado é dinheiro errado no repasse; um erro aqui
    //     precisa aparecer na telemetria, não sumir.
    await applyDriverSplit(rideId);

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
    await applyDriverSplit(ride.id);

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
    await applyDriverSplit(ride.id);
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

      if (!error && (data?.length ?? 0) > 0) {
        // REDE DE SEGURANÇA DA COBRANÇA. Nenhuma corrida pode terminar sem que
        // a tarifa tenha sido cobrada. O caminho normal cobra lá atrás (aceite
        // imediato ou ativação da agendada); aqui só fechamos a última porta —
        // se por qualquer motivo `paid` ainda estiver falso ao concluir, a
        // cobrança sai agora. É idempotente dos dois lados (flag `paid` no
        // banco + idempotencyKey no Stripe), então o caso normal é um no-op.
        //
        // Não bloqueia a conclusão: a viagem fisicamente acabou e prender o
        // motorista numa tela por causa de cartão recusado seria pior. A falha
        // vira telemetria para cobrança/estorno manual.
        if (status === 'completed') {
          void (async () => {
            try {
              const { data: row } = await supabase
                .from('rides').select('paid').eq('id', rideId).maybeSingle();
              if ((row as { paid?: boolean } | null)?.paid) return;
              const charge = await chargeRide(rideId);
              if (!charge.ok) {
                reportError(charge.error, { op: 'completeRide.chargeFallback', rideId });
              }
            } catch (e) {
              reportError(e, { op: 'completeRide.chargeFallback', rideId });
            }
          })();
        }
        return true;
      }

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
