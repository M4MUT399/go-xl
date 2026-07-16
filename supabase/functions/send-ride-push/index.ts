// Supabase Edge Function — envio de push notification de corrida no servidor.
//
// Por quê: até aqui o client lia `profiles.push_token` de OUTROS usuários
// direto (via supabase-js) e chamava a API pública do Expo
// (https://exp.host/--/api/v2/push/send) com o token em mãos. Isso exigia uma
// policy de RLS ampla em `profiles` (qualquer authenticated lê push_token de
// qualquer um) e permitia, em tese, que um client malicioso lesse o token de
// QUALQUER usuário e enviasse push arbitrário (título/corpo livres) se
// conseguisse compor a chamada à API do Expo por fora do app.
//
// Esta função move a leitura do token e a chamada ao Expo para o servidor
// (service_role, nunca exposto ao client) e SEMPRE usa templates de mensagem
// fixos no código — o client nunca envia título/corpo livre, só `kind` +
// `rideId` (+ lista de ids-alvo apenas no broadcast do pool de motoristas).
// Toda a autorização é resolvida a partir da própria linha de `rides`
// (passenger_id/driver_id), nunca confiando em um id "de quem chama" vindo
// do body.
//
// Deploy:  npx supabase functions deploy send-ride-push --no-verify-jwt
// Chamada: POST { kind, rideId, driverIds?, exceptDriverId? } + JWT do usuário

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')         ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Limite de segurança para o broadcast ao pool de motoristas — nunca deve
// passar disso em operação normal; existe só para não deixar o endpoint
// virar vetor de amplificação caso `driverIds` venha malformado/gigante.
const MAX_BROADCAST_TARGETS = 300;

type Ride = {
  id: string;
  passenger_id: string;
  driver_id: string | null;
  status: string;
  destination_address: string | null;
  price: number | null;
  driver_eta_min: number | null;
  scheduled_for: string | null;
};

type PushMessage = {
  to: string;
  title?: string;
  body?: string;
  data: Record<string, unknown>;
  sound?: 'default';
  channelId?: string;
  ttl?: number;
  priority?: 'high';
  collapseId?: string;
  _contentAvailable?: boolean;
};

function formatCurrency(v: number | null | undefined): string {
  return `$${(Number(v) || 0).toFixed(2)}`;
}

async function sendExpoPush(messages: PushMessage[]): Promise<void> {
  const valid = messages.filter((m) => m.to?.startsWith('ExponentPushToken'));
  if (valid.length === 0) return;
  try {
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(valid),
    });
  } catch {
    // push é best-effort — nunca deve derrubar o fluxo de corrida
  }
}

async function tokensFor(admin: ReturnType<typeof createClient>, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const { data } = await admin.from('profiles').select('push_token').in('id', ids);
  return ((data as { push_token: string | null }[] | null) ?? [])
    .map((d) => d.push_token)
    .filter((t): t is string => !!t);
}

async function tokenFor(admin: ReturnType<typeof createClient>, id: string): Promise<string | null> {
  const { data } = await admin.from('profiles').select('push_token').eq('id', id).single();
  return (data as { push_token: string | null } | null)?.push_token ?? null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS });
  }

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

  try {
    const body = await req.json();
    const kind: string = body?.kind;
    const rideId: string = body?.rideId;
    const driverIds: string[] = Array.isArray(body?.driverIds) ? body.driverIds.slice(0, MAX_BROADCAST_TARGETS) : [];
    const exceptDriverId: string | undefined = body?.exceptDriverId;

    if (!kind || !rideId) return json({ error: 'kind e rideId são obrigatórios' }, 400);

    // ── Autenticação do usuário (função deployada com --no-verify-jwt) ──────
    const authHeader = req.headers.get('Authorization') ?? '';
    const { data: { user }, error: authErr } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    }).auth.getUser();
    if (authErr || !user) return json({ error: 'Não autorizado' }, 401);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const { data: rideRow, error: rideErr } = await admin
      .from('rides')
      .select('id, passenger_id, driver_id, status, destination_address, price, driver_eta_min, scheduled_for')
      .eq('id', rideId)
      .single();
    if (rideErr || !rideRow) return json({ error: 'Corrida não encontrada' }, 404);
    const ride = rideRow as Ride;

    const isPassenger = user.id === ride.passenger_id;
    const isDriver    = !!ride.driver_id && user.id === ride.driver_id;

    switch (kind) {
      // ── Passageiro → motorista pré-vinculado por QR (imediato) ───────────
      case 'new_ride_direct': {
        if (!isPassenger || !ride.driver_id) return json({ error: 'Não autorizado' }, 403);
        const token = await tokenFor(admin, ride.driver_id);
        if (token) {
          await sendExpoPush([{
            to: token,
            title: '📲 Corrida via QR Code — Executive XL',
            body: `Passageiro solicitou pelo seu QR. Destino: ${ride.destination_address ?? ''} • ${formatCurrency(ride.price)}`,
            data: { type: 'new_ride', rideId },
            sound: 'default', channelId: 'rides', ttl: 30, priority: 'high', collapseId: rideId,
          }]);
        }
        break;
      }

      // ── Passageiro → motorista pré-vinculado por QR (agendamento) ────────
      case 'new_ride_scheduled_direct': {
        if (!isPassenger || !ride.driver_id) return json({ error: 'Não autorizado' }, 403);
        const token = await tokenFor(admin, ride.driver_id);
        if (token) {
          const when = ride.scheduled_for ? new Date(ride.scheduled_for) : null;
          const whenStr = when
            ? `${when.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${when.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`
            : '';
          await sendExpoPush([{
            to: token,
            title: '🗓️📲 Agendamento via QR Code — Executive XL',
            body: `Passageiro agendou pelo seu QR para ${whenStr}. Destino: ${ride.destination_address ?? ''} • ${formatCurrency(ride.price)}`,
            data: { type: 'new_scheduled_ride' },
            sound: 'default', channelId: 'rides',
          }]);
        }
        break;
      }

      // ── Passageiro → pool de motoristas online (sem QR) ──────────────────
      case 'new_ride_broadcast': {
        if (!isPassenger || ride.driver_id) return json({ error: 'Não autorizado' }, 403);
        const tokens = await tokensFor(admin, driverIds);
        await sendExpoPush(tokens.map((to) => ({
          to,
          title: '🚗 Nova corrida Executive XL',
          body: `Destino: ${ride.destination_address ?? ''} • ${formatCurrency(ride.price)}`,
          data: { type: 'new_ride', rideId },
          sound: 'default', channelId: 'rides', ttl: 30, priority: 'high', collapseId: rideId,
        })));
        break;
      }

      // ── Push silencioso de revogação de oferta ────────────────────────────
      case 'silent_revoke': {
        // Participantes diretos OU qualquer motorista autenticado quando a
        // corrida ainda está no pool público (status 'requesting'/'scheduled'
        // sem driver_id) — cobre o aviso OTIMISTA disparado no instante do
        // toque em "Aceitar", ANTES do UPDATE que trava driver_id na linha
        // (ver acceptRide em useRide.ts: o silêncio sai primeiro para parar
        // o som dos demais o quanto antes; só depois vem a cobrança/UPDATE).
        const isOpenPool = !ride.driver_id && (ride.status === 'requesting' || ride.status === 'scheduled');
        if (!isPassenger && !isDriver && !isOpenPool) return json({ error: 'Não autorizado' }, 403);
        const targets = driverIds.filter((id) => id !== exceptDriverId);
        const tokens = await tokensFor(admin, targets);
        await sendExpoPush(tokens.map((to) => ({
          to,
          data: { type: 'offer_revoked', rideId },
          channelId: 'rides', priority: 'high', ttl: 30, collapseId: rideId, _contentAvailable: true,
        })));
        break;
      }

      // ── Motorista → passageiro: corrida aceita ────────────────────────────
      case 'ride_accepted': {
        // Dois pontos de disparo legítimos: (1) acceptRide — sempre o
        // motorista, chamado DEPOIS do UPDATE que trava driver_id nele
        // mesmo (isDriver ok); (2) activate() em useScheduledRides, ramo
        // preAssigned — corrida agendada travada por QR, cujo botão
        // "Iniciar corrida" existe tanto na tela do motorista quanto na do
        // PASSAGEIRO (ScheduledRidesScreen.handleActivate). Nesse segundo
        // caso quem chama pode ser o próprio passageiro, então isDriver
        // sozinho derrubaria a notificação. Autoriza também isPassenger,
        // já que o alvo do push é sempre ride.passenger_id — não há
        // terceiro ilegítimo que se beneficie disso.
        if (!isDriver && !isPassenger) return json({ error: 'Não autorizado' }, 403);
        const token = await tokenFor(admin, ride.passenger_id);
        if (token) {
          const etaPhrase = ride.driver_eta_min ? ` Chegando em ${ride.driver_eta_min} min.` : ' Motorista a caminho!';
          const bodyMsg = ride.price
            ? `${formatCurrency(ride.price)} cobrado do seu cartão.${etaPhrase}`
            : `Seu Executive XL foi confirmado.${etaPhrase}`;
          await sendExpoPush([{
            to: token,
            title: '💳 Pagamento confirmado — Motorista a caminho!',
            body: bodyMsg,
            data: { type: 'ride_accepted' },
            sound: 'default', channelId: 'rides',
          }]);
        }
        break;
      }

      // ── Motorista → passageiro: agendamento confirmado ────────────────────
      case 'schedule_confirmed': {
        if (!isDriver) return json({ error: 'Não autorizado' }, 403);
        const token = await tokenFor(admin, ride.passenger_id);
        if (token) {
          await sendExpoPush([{
            to: token,
            title: '🗓️ Motorista confirmado!',
            body: 'Um motorista aceitou seu agendamento. Você pode ver os detalhes na tela de corridas agendadas.',
            data: { type: 'schedule_confirmed' },
            sound: 'default', channelId: 'rides',
          }]);
        }
        break;
      }

      // ── Motorista → passageiro: agendamento rejeitado ─────────────────────
      case 'schedule_rejected': {
        // O UPDATE que rejeita já limpou driver_id ANTES desta chamada (a Edge
        // Function sempre lê o estado atual da linha) — então não dá pra
        // verificar isDriver aqui. Autoriza estruturalmente: agendamento
        // (status 'scheduled') que acabou de voltar ao pool sem motorista,
        // mesmo sinal usado no watchdog de expiração abaixo.
        const isBackToPool = ride.status === 'scheduled' && !ride.driver_id;
        if (!isBackToPool) return json({ error: 'Não autorizado' }, 403);
        const token = await tokenFor(admin, ride.passenger_id);
        if (token) {
          await sendExpoPush([{
            to: token,
            title: '🗓️ Agendamento não confirmado',
            body: 'O motorista não pôde confirmar seu agendamento. Estamos procurando outro motorista para você.',
            data: { type: 'schedule_rejected' },
            sound: 'default', channelId: 'rides',
          }]);
        }
        break;
      }

      // ── Motorista → passageiro: corrida concluída ─────────────────────────
      case 'ride_completed': {
        if (!isDriver) return json({ error: 'Não autorizado' }, 403);
        const token = await tokenFor(admin, ride.passenger_id);
        if (token) {
          const bodyMsg = ride.price
            ? `Valor: ${formatCurrency(ride.price)}. Avalie o motorista e deixe uma gorjeta! 🌟`
            : 'Sua corrida Executive XL foi concluída. Avalie o motorista!';
          await sendExpoPush([{
            to: token,
            title: '🏁 Corrida finalizada!',
            body: bodyMsg,
            data: { type: 'ride_completed' },
            sound: 'default', channelId: 'rides',
          }]);
        }
        break;
      }

      // ── Motorista → passageiro: liberou agendamento aceito ────────────────
      case 'driver_released': {
        // Mesmo caso do 'schedule_rejected': o release já limpou driver_id
        // antes desta chamada — autoriza pelo estado estrutural resultante
        // (agendamento de volta ao pool aberto).
        const isBackToPool = ride.status === 'scheduled' && !ride.driver_id;
        if (!isBackToPool) return json({ error: 'Não autorizado' }, 403);
        const token = await tokenFor(admin, ride.passenger_id);
        if (token) {
          await sendExpoPush([{
            to: token,
            title: '⚠️ Motorista cancelou o agendamento',
            body: 'O motorista liberou sua corrida agendada. Aguarde nova confirmação ou solicite agora.',
            data: { type: 'driver_released', rideId },
            sound: 'default', channelId: 'rides',
          }]);
        }
        break;
      }

      // ── Passageiro → motorista: cancelou corrida já aceita ────────────────
      // Complementa o broadcast em tempo real (`driver-notify-${driverId}`,
      // ver useRide.ts/broadcastRideCancelledToDriver) que só chega se o app
      // do motorista estiver aberto na tela de navegação com o WebSocket
      // conectado. Este push garante a entrega mesmo em segundo plano/fechado.
      case 'ride_cancelled_by_passenger': {
        if (!isPassenger || !ride.driver_id) return json({ error: 'Não autorizado' }, 403);
        const token = await tokenFor(admin, ride.driver_id);
        if (token) {
          await sendExpoPush([{
            to: token,
            title: '❌ Corrida cancelada',
            body: 'O passageiro cancelou esta corrida.',
            data: { type: 'ride_cancelled', rideId },
            sound: 'default', channelId: 'rides', ttl: 30, priority: 'high', collapseId: rideId,
          }]);
        }
        break;
      }

      // ── Watchdog: agendamento venceu sem motorista ────────────────────────
      case 'schedule_expired': {
        // O watchdog (expireOldScheduledRides) já marcou a linha como
        // 'cancelled' ANTES de chamar esta função — então aceita tanto o
        // estado transitório ('scheduled', chamada antiga/direta) quanto o
        // estado pós-cancelamento ('cancelled'), sempre exigindo driver_id
        // nulo (nunca chegou a ter motorista designado).
        const isPoolWatchdog = !ride.driver_id && (ride.status === 'scheduled' || ride.status === 'cancelled');
        if (!isPoolWatchdog) return json({ error: 'Não autorizado' }, 403);
        const token = await tokenFor(admin, ride.passenger_id);
        if (token) {
          await sendExpoPush([{
            to: token,
            title: '⏰ Agendamento não confirmado',
            body: 'Nenhum motorista aceitou seu agendamento a tempo. Solicite uma nova corrida.',
            data: { type: 'schedule_expired', rideId },
            sound: 'default', channelId: 'rides',
          }]);
        }
        break;
      }

      default:
        return json({ error: `kind desconhecido: ${kind}` }, 400);
    }

    return json({ ok: true });
  } catch (e: unknown) {
    return json({ error: String(e) }, 500);
  }
});
