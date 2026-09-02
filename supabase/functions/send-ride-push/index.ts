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
// `rideId`. Toda a autorização é resolvida a partir da própria linha de `rides`
// (passenger_id/driver_id), nunca confiando em um id "de quem chama" vindo
// do body.
//
// ─────────────────────────────────────────────────────────────────────────────
// O LEQUE É DERIVADO AQUI, NÃO RECEBIDO
// ─────────────────────────────────────────────────────────────────────────────
// Até a rodada anterior o corpo trazia `driverIds` — o cliente consultava
// `driver_locations` e mandava a lista. Duas coisas erradas nisso:
//
//   • a lista era ARBITRÁRIA: nada aqui a conferia contra o banco, só a fatiava
//     em MAX_BROADCAST_TARGETS. Quem chamasse a função com uma lista escolhida
//     mandava push (e, enquanto a prova de oferta valia como autorização,
//     também DIREITO DE COBRANÇA) para quem quisesse;
//   • e ela nascia da RLS do PASSAGEIRO, que é outro recorte do que o servidor
//     enxerga.
//
// Agora `onlineDriverIds` lê `driver_locations` com a service key. `driverIds`
// do corpo é IGNORADO — permanece aceito e descartado só para que um app antigo
// em campo não quebre.
//
// Deploy:  npx supabase functions deploy send-ride-push --no-verify-jwt
// Chamada: POST { kind, rideId, exceptDriverId? } + JWT do usuário

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { driversFreeForOffer, type BusyRideRow } from '../_shared/rideDispatch.ts';
import { cortePorFrescorIso } from '../_shared/driverFreshness.ts';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')         ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

// Teto do broadcast ao pool de motoristas. Com a lista derivada no servidor ele
// deixa de ser defesa contra corpo malformado e passa a ser o que o nome diz: um
// teto de custo por chamada (tokens lidos + payload ao Expo). Se algum dia
// Orlando tiver mais de 300 motoristas online ao mesmo tempo, este número é que
// precisa subir — não há outro lugar onde o leque seja cortado.
const MAX_BROADCAST_TARGETS = 300;

type Ride = {
  id: string;
  passenger_id: string;
  driver_id: string | null;
  status: string;
  destination_address: string | null;
  destination_lat: number | null;
  destination_lng: number | null;
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

// ─────────────────────────────────────────────────────────────────────────────
// PORTAS ESTRUTURAIS
// ─────────────────────────────────────────────────────────────────────────────
// Cada helper declara SÓ o encadeamento que usa, em vez de `ReturnType<typeof
// createClient>`. Não é preciosismo: este arquivo cria o cliente SEM esquema
// gerado, e o tipo do cliente sem esquema NÃO é assinável ao tipo do parâmetro
// quando este é escrito como `ReturnType<typeof createClient>` — os dois lados
// instanciam os genéricos de formas diferentes e cada chamada vira um TS2345.
// Eram 12 no arquivo. `as any` calaria os mesmos 12 e junto com eles o dia em
// que uma coluna mudar de nome; declarar a forma usada não cala nada.
type PgError = { message: string } | null;

type ProfileTokenReader = {
  from(table: string): {
    select(columns: string): {
      in(column: string, values: string[]): PromiseLike<{ data: { push_token: string | null }[] | null }>;
      eq(column: string, value: string): {
        single(): PromiseLike<{ data: { push_token: string | null } | null }>;
      };
    };
  };
};

type ActiveRideReader = {
  from(table: string): {
    select(columns: string): {
      in(column: string, values: string[]): {
        in(column: string, values: string[]): PromiseLike<{ data: BusyRideRow[] | null; error: PgError }>;
      };
    };
  };
};

type OnlineDriverReader = {
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: boolean): {
        gt(column: string, value: string): {
          order(column: string, options: { ascending: boolean }): {
            limit(count: number): PromiseLike<{ data: { driver_id: string | null }[] | null; error: PgError }>;
          };
        };
      };
    };
  };
};

/**
 * As portas acima, reunidas — o tipo com que este arquivo enxerga a service key.
 *
 * O estreitamento acontece UMA vez, na criação, e não em cada chamada. Com o
 * cliente cru, cada helper obrigava o compilador a comparar estruturalmente o
 * tipo do `createClient` sem esquema contra a porta do parâmetro; somadas, essas
 * comparações estouravam o limite de profundidade e o erro caía num ponto
 * arbitrário (era um TS2589 em `tokenFor`, que não tem nada de errado). Vale a
 * mesma razão do comentário das portas: nada de `as any` — as colunas continuam
 * declaradas, só que num lugar só.
 *
 * A leitura de `rides` fica DE FORA da interseção de propósito: ela usa o mesmo
 * encadeamento de `ProfileTokenReader` (`.eq(...).single()`) com outro tipo de
 * retorno, e numa interseção o compilador resolve pela primeira assinatura —
 * `rideRow` sairia tipado como `push_token`. Aquela leitura é feita pelo cliente
 * cru, uma vez só, logo abaixo.
 */
type PushAdmin = ProfileTokenReader & ActiveRideReader & OnlineDriverReader & PushOfferWriter;

async function tokensFor(admin: ProfileTokenReader, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const { data } = await admin.from('profiles').select('push_token').in('id', ids);
  return (data ?? [])
    .map((d) => d.push_token)
    .filter((t): t is string => !!t);
}

/**
 * O LEQUE. Derivado aqui, com a service key, e nunca recebido do cliente.
 *
 * `is_online` continua sendo o critério de QUEM RECEBE O TOQUE, e continua sendo
 * um espelho mantido pelo app do motorista (que ele mesmo pode escrever: a RLS
 * de `driver_locations` é `auth.uid() = driver_id`). Isso está certo para PUSH e
 * seria errado para autorização — e é exatamente por isso que a autorização de
 * cobrança saiu daqui: quem decide se um motorista pode assumir a corrida é o
 * `charge-ride`, sobre fatos que o motorista não escreve (flags do Connect,
 * `driver_can_go_online`) e com reserva atômica. Ver _shared/chargeAuth.ts.
 *
 * A ordenação por `updated_at` desc não é enfeite: se houver mais motoristas
 * online que `MAX_BROADCAST_TARGETS`, o corte precisa cair sobre as linhas mais
 * velhas (app morto sem desligar o espelho), não sobre um conjunto arbitrário.
 *
 * ── O FILTRO DE FRESCOR ────────────────────────────────────────────────────
 *
 * Ordenar não bastava. Com menos motoristas que o teto — o caso real, hoje são
 * oito — nenhuma linha era cortada, e o leque incluía TODO mundo que um dia
 * ficou online e nunca desligou o espelho. Em 02/09/2026 isso eram seis
 * telefones parados havia entre 8 e 55 dias tocando a cada corrida pedida.
 *
 * `cortePorFrescorIso()` é a MESMA janela do `dispatch-engine` e da
 * `nearby_online_drivers` — ver _shared/driverFreshness.ts para por que 10 min.
 *
 * Isto vale também para o `silent_revoke`, e está certo: quem não estava fresco
 * o bastante para receber a oferta não tem o que dispensar. A oferta expira em
 * ~30 s (`ride_offer_timeout_seconds`), muito dentro da janela, então um
 * motorista que recebeu o toque continua alcançável pela revogação.
 */
async function onlineDriverIds(admin: OnlineDriverReader): Promise<string[]> {
  const { data, error } = await admin
    .from('driver_locations')
    .select('driver_id')
    .eq('is_online', true)
    .gt('updated_at', cortePorFrescorIso())
    .order('updated_at', { ascending: false })
    .limit(MAX_BROADCAST_TARGETS);

  if (error) {
    // Sem leque não há push. O card em tempo real (subscription do motorista em
    // `rides`) não depende desta função, então a corrida ainda pode ser aceita.
    console.error('Falha ao derivar o leque de motoristas online — nenhum push sai', {
      error: error.message,
    });
    return [];
  }
  return (data ?? []).map((d) => d.driver_id).filter((id): id is string => !!id);
}

/**
 * AUDITORIA — quem recebeu o toque desta corrida (`public.ride_push_offers`,
 * migration 0070).
 *
 * ISTO NÃO AUTORIZA NADA. Já autorizou, e essa foi a rodada anterior: o
 * `charge-ride` exigia uma linha aqui para deixar um motorista cobrar corrida do
 * leque. Duas consequências, ambas reais:
 *
 *   • concedia demais — todo motorista online no instante do pedido ganhava
 *     direito de cobrança off-session no cartão daquele passageiro por 2 h;
 *   • e recusava legítimos — o conjunto que via o card (subscription realtime,
 *     filtrada só por status) e o conjunto provado (`is_online` naquele
 *     instante) vinham de fontes diferentes e discordavam. Corrida pedida sem
 *     ninguém online nascia com ZERO linhas, e quem entrasse um minuto depois era
 *     recusado com 403 para sempre.
 *
 * Hoje a autorização é derivada no `charge-ride` no momento do aceite e a
 * exclusividade vem de uma reserva atômica (_shared/chargeAuth.ts). Estas linhas
 * respondem "para quem o telefone tocou?" — pergunta de auditoria, não de
 * permissão. Por isso uma falha aqui NÃO impede mais aceite nenhum, e por isso
 * ela só é registrada em log.
 *
 * `upsert` com `ignoreDuplicates` porque o mesmo leque pode ser transmitido mais
 * de uma vez para a mesma corrida (reoferta depois de um aceite que falhou): a
 * primeira gravação é a que vale, e `offered_at` não deve ser empurrado para a
 * frente por uma retransmissão.
 */
type PushOfferWriter = {
  from(table: string): {
    upsert(
      rows: { ride_id: string; driver_id: string }[],
      options: { onConflict: string; ignoreDuplicates: boolean },
    ): PromiseLike<{ error: { message: string } | null }>;
  };
};

async function recordPushOffers(
  admin: PushOfferWriter,
  rideId: string,
  driverIds: string[],
): Promise<void> {
  if (driverIds.length === 0) return;
  try {
    // De-duplica antes de mandar: o `upsert` recusa o LOTE INTEIRO ("ON CONFLICT
    // DO UPDATE command cannot affect row a second time") se o mesmo par
    // aparecer duas vezes no payload. `driver_locations.driver_id` é chave
    // primária, então hoje não repete — o Set é para não voltar a repetir se a
    // origem do leque mudar.
    const unique = [...new Set(driverIds)];
    const { error } = await admin.from('ride_push_offers').upsert(
      unique.map((driver_id) => ({ ride_id: rideId, driver_id })),
      { onConflict: 'ride_id,driver_id', ignoreDuplicates: true },
    );
    if (error) {
      console.error('Falha ao registrar ride_push_offers (auditoria) — aceite NÃO é afetado', {
        rideId, count: unique.length, error: error.message,
      });
    }
  } catch (e) {
    console.error('Exceção ao registrar ride_push_offers', { rideId, error: String(e) });
  }
}

/**
 * Corridas ATIVAS (de qualquer passageiro) dos motoristas do leque.
 *
 * Só existe aqui porque só aqui é possível: a leitura usa a service key e
 * ignora RLS. O passageiro que dispara o broadcast não enxerga essas linhas —
 * a policy de SELECT de `rides` (0067 A.2/A.3) lhe dá o pool aberto e as
 * corridas dele, e mais nada. Alargar aquela policy para o cliente poder
 * filtrar sozinho reabriria o vazamento que a 0067 fechou.
 */
async function busyRidesFor(
  admin: ActiveRideReader,
  driverIds: string[],
): Promise<BusyRideRow[]> {
  if (driverIds.length === 0) return [];
  const { data, error } = await admin
    .from('rides')
    .select('driver_id, status, destination_lat, destination_lng, destination_address, driver_eta_min')
    .in('driver_id', driverIds)
    .in('status', ['accepted', 'driver_en_route', 'in_progress']);
  if (error) {
    // Sem a lista de ocupados não dá para decidir quem está livre. Notificar
    // todo mundo (o comportamento de sempre) é melhor que não notificar
    // ninguém: o custo é um push indevido, não uma corrida sem motorista.
    console.error('Falha ao ler corridas ativas — leque sai sem filtro de ocupados', {
      count: driverIds.length, error: error.message,
    });
    return [];
  }
  return data ?? [];
}

async function tokenFor(admin: ProfileTokenReader, id: string): Promise<string | null> {
  const { data } = await admin.from('profiles').select('push_token').eq('id', id).single();
  return data?.push_token ?? null;
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
    // `body.driverIds` NÃO é mais lido. Apps antigos em campo continuam podendo
    // mandá-lo; ele é descartado. O leque sai de `onlineDriverIds`, abaixo.
    const exceptDriverId: string | undefined = body?.exceptDriverId;

    if (!kind || !rideId) return json({ error: 'kind e rideId são obrigatórios' }, 400);

    // ── Autenticação do usuário (função deployada com --no-verify-jwt) ──────
    const authHeader = req.headers.get('Authorization') ?? '';
    const { data: { user }, error: authErr } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    }).auth.getUser();
    if (authErr || !user) return json({ error: 'Não autorizado' }, 401);

    const rawAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const admin = rawAdmin as unknown as PushAdmin;

    const { data: rideRow, error: rideErr } = await rawAdmin
      .from('rides')
      .select('id, passenger_id, driver_id, status, destination_address, destination_lat, destination_lng, price, driver_eta_min, scheduled_for')
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

        // ── REGISTRA A OFERTA ANTES DE NOTIFICAR ──────────────────────────
        // Esta gravação não é telemetria: é a PROVA de autorização que o
        // `charge-ride` exige para deixar um motorista cobrar uma corrida que
        // ainda não é dele (_shared/chargeAuth.ts). Sem ela, a carve-out do
        // aceite é "qualquer motorista cadastrado cobra qualquer corrida do
        // leque" — e a tentativa anterior de fechar isso via `ride_offers`
        // ficou inerte porque `dispatch_engine_v2` está desligada.
        //
        // Por que AQUI e não no cliente: esta função roda com service_role e já
        // provou, acima, que quem chama é o PASSAGEIRO desta corrida. Um
        // motorista não consegue escrever nesta tabela — a 0070 não dá `insert`
        // a `authenticated`, ao contrário de `ride_offer_events` (0023), cuja
        // policy é `auth.uid() = driver_id` e que por isso NÃO serve como prova
        // (o atacante assinaria o próprio salvo-conduto).
        //
        // Vem ANTES do push de propósito: o Expo estar fora não pode impedir que
        // um motorista legítimo aceite a corrida.
        // O leque é derivado AQUI, com a service key, e não vem mais do corpo
        // da requisição — ver o cabeçalho deste arquivo.
        const fanout = await onlineDriverIds(admin);
        await recordPushOffers(admin, rideId, fanout);

        // ── QUEM DE FATO RECEBE O TOQUE ───────────────────────────────────
        // Motorista já a caminho/em corrida com outro passageiro não é
        // incomodado — salvo se o destino desta chamada for o mesmo (ou a até
        // 1km) do destino da corrida ativa dele, ou se faltarem <=5min para
        // terminá-la. Mesma regra que o app do motorista aplica ao card de
        // chamada em tempo real (canReceiveNewRideOffer), agora com a mesma
        // resposta dos dois lados: a versão que morava no cliente lia `rides`
        // sob a RLS do PASSAGEIRO, nunca via corrida alheia, e por isso
        // liberava todo mundo.
        //
        // O recorte é só do PUSH, e vem depois de `recordPushOffers` de
        // propósito: a prova de oferta continua cobrindo o leque inteiro de
        // motoristas online. Um motorista que termine a corrida enquanto esta
        // ainda está aberta recebe o card pelo realtime e precisa poder
        // aceitá-la — restringir a prova aqui o faria ser recusado na cobrança.
        const targets = driversFreeForOffer(fanout, await busyRidesFor(admin, fanout), {
          id: ride.id,
          destination_address: ride.destination_address,
          destination_lat: ride.destination_lat,
          destination_lng: ride.destination_lng,
        });
        if (targets.length === 0) break;

        const tokens = await tokensFor(admin, targets);
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
        const targets = (await onlineDriverIds(admin)).filter((id) => id !== exceptDriverId);
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
