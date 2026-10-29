// Supabase Edge Function — extorna o pagamento de uma corrida via Stripe.
// Chamada pelo motorista ao cancelar uma corrida já aceita (e paga), e pelo
// ADMIN como estorno avulso de qualquer corrida.
//
// ⚠️ MODELO DE PAGAMENTO: Separate Charges & Transfers (decisão do dono — não
// migrar para Destination Charges). A plataforma cobra o cartão do passageiro
// na hora (charge-ride) e a parte do motorista sai DEPOIS, num transfer semanal
// para a conta conectada (run-weekly-payouts / request-payout). São dois
// movimentos independentes, e por isso ESTORNAR NÃO É UMA OPERAÇÃO SÓ:
//
//   • corrida ainda não repassada → basta o refund + `paid = false`: a
//     elegibilidade de repasse é `paid = true and payout_id is null`, então a
//     corrida sai da fila e o dinheiro do motorista nunca chega a sair;
//   • corrida JÁ repassada → o dinheiro do motorista saiu de verdade. Sem
//     `transfers.createReversal`, o passageiro recebe 100% de volta, o motorista
//     fica com os 80-85% e a diferença sai do bolso da plataforma. Era
//     exatamente o que acontecia aqui: a função criava o refund e gravava
//     `paid = false`, e mais nada.
//
// A reversão pode FALHAR (o motorista já sacou e a conta conectada não tem
// saldo). Nesse caso o estorno ao passageiro acontece assim mesmo — ele não pode
// ficar refém do saldo do motorista — mas NUNCA em silêncio: fica registrado em
// `stripe_reconciliation` com `needs_attention = true` e os admins são
// alertados. A decisão de "quem cobra esse valor do motorista" é humana.
//
// A aritmética/decisão é pura e testada em _shared/refundReversal.ts, e a
// SEQUÊNCIA (reverter → estornar → paid = false → registrar), com o tratamento
// de cada meio-caminho, em _shared/refundFlow.ts. Este arquivo faz autenticação,
// autorização, a busca do transfer e a ligação das portas ao Stripe/Supabase.
//
// Deploy:  npx supabase functions deploy refund-ride --no-verify-jwt

import Stripe from 'npm:stripe@17';
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import {
  findRideTransfer,
  planDriverReversal,
  type TipDisposition,
  type TransferShape,
} from '../_shared/refundReversal.ts';
import {
  runRefundFlow,
  type RefundAuditRow,
  type RefundPorts,
} from '../_shared/refundFlow.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2025-01-27.acacia',
});

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')         ?? '';
// Mesmo canal de alerta do stripe-webhook (Slack/Discord/etc.), opcional.
const ALERT_WEBHOOK_URL    = Deno.env.get('ALERT_WEBHOOK_URL')         ?? '';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

/**
 * Quantas páginas de 100 transfers varremos procurando o da corrida.
 *
 * Por que varrer: NENHUMA coluna guarda o transfer por corrida. As duas funções
 * de repasse criam um transfer por corrida com `metadata.ride_id`, mas só
 * persistem o PRIMEIRO id do lote em `payouts.stripe_transfer_id`
 * (_shared/payout.ts:147); `_shared/tipPayout.ts:89` descarta o id. O `metadata`
 * do Stripe é a única fonte da associação.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ORDENAÇÃO — o comentário anterior aqui estava INVERTIDO
 * ─────────────────────────────────────────────────────────────────────────────
 * As listas do Stripe vêm do MAIS NOVO para o mais antigo, e `starting_after`
 * caminha em direção ao MAIS ANTIGO. A versão anterior filtrava só com
 * `created.gte` (limite INFERIOR), o que deixa a janela aberta até hoje: a
 * página 0 continha os 100 transfers MAIS RECENTES da conta conectada, e o
 * transfer procurado — o mais ANTIGO do conjunto filtrado — ficava na ÚLTIMA
 * página. As 5 páginas eram gastas andando de hoje para trás.
 *
 * Consequência com volume ORDINÁRIO, não excepcional: estornar uma corrida de
 * seis semanas atrás de um motorista ativo (um transfer por corrida mais um por
 * gorjeta, toda semana) estourava o teto passados uns 500 transfers, devolvia
 * `null` e virava `transfer_not_found` — com o dinheiro do motorista parado no
 * Stripe, perfeitamente localizável.
 *
 * A correção é fechar a janela dos DOIS lados (ver TRANSFER_WINDOW_SEC), e aí
 * "está na primeira página" passa a ser verdade de fato: dentro da janela só
 * cabem os transfers daquele repasse (um por corrida + um por gorjeta) e, no
 * máximo, os do repasse vizinho.
 *
 * O teto continua existindo para não deixar a função rodando para sempre — e, se
 * for atingido sem achar, o resultado NÃO é silêncio: vira `transfer_not_found`,
 * que é pendência humana registrada.
 */
const MAX_TRANSFER_PAGES = 5;

/**
 * Folga para TRÁS da âncora do repasse (fuso, retentativa, relógio do servidor).
 */
const TRANSFER_LOOKBACK_SEC = 2 * 24 * 60 * 60;

/**
 * Largura TOTAL da janela de busca, a partir do limite inferior.
 *
 * A âncora é `payouts.requested_at` (default `now()` no INSERT da linha de
 * repasse) e os transfers são criados na MESMA invocação, segundos depois:
 * request-payout/index.ts insere o payout e chama `settleTransfers` logo em
 * seguida; run-weekly-payouts/index.ts faz o mesmo antes de gravar
 * `processed_at`. Um repasse que trave por mais de 15 min é derrubado por
 * `unstickStalePayouts` (STUCK_PAYOUT_MS, request-payout/index.ts:47), então não
 * existe caminho em que o transfer nasça muito depois da âncora.
 *
 * 7 dias a partir de `âncora - 2d` dá +5 dias de folga para frente — ordens de
 * grandeza acima dos segundos reais, e ainda assim estreito o bastante para o
 * alvo caber na primeira página.
 */
const TRANSFER_WINDOW_SEC = 7 * 24 * 60 * 60;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS });
  }

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });

  try {
    const { rideId } = await req.json();
    if (!rideId) return json({ error: 'rideId obrigatório' }, 400);

    // ── Autenticação: passageiro OU motorista da corrida ─────────────────────
    // Deployada com --no-verify-jwt, então a verificação acontece AQUI. Tanto o
    // passageiro quanto o motorista podem cancelar/estornar a própria corrida.
    const authHeader = req.headers.get('Authorization') ?? '';
    const { data: { user }, error: authErr } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    }).auth.getUser();
    if (authErr || !user) return json({ error: 'Não autorizado' }, 401);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // ── Busca dados da corrida ───────────────────────────────────────────────
    // As colunas de repasse (payout_id / tip_payout_id / driver_amount /
    // tip_amount) entram aqui porque são elas que dizem se o dinheiro do
    // motorista JÁ SAIU — o que decide se este estorno precisa reverter um
    // transfer ou não.
    const { data: ride, error: rideErr } = await admin
      .from('rides')
      .select(
        'stripe_payment_intent_id, paid, passenger_id, driver_id, status, ' +
        'payout_id, tip_payout_id, driver_amount, tip_amount',
      )
      .eq('id', rideId)
      .single();

    if (rideErr || !ride) return json({ error: 'Corrida não encontrada' }, 404);

    const r = ride as {
      stripe_payment_intent_id?: string;
      paid?: boolean;
      passenger_id?: string;
      driver_id?: string;
      status?: string;
      payout_id?: string | null;
      tip_payout_id?: string | null;
      driver_amount?: number | null;
      tip_amount?: number | null;
    };

    // ── Autorização (política "admin + auto-estorno no cancelamento") ─────────
    // • ADMIN (profiles.is_admin) pode estornar QUALQUER corrida, em qualquer
    //   estado — é o endpoint de estorno avulso previsto na política de segurança.
    // • Um PARTICIPANTE (passageiro ou motorista) só pode estornar a própria
    //   corrida enquanto ela AINDA NÃO foi concluída — este é o estorno
    //   automático de cancelamento. Isso fecha o buraco de um participante
    //   estornar uma corrida já concluída (que seria abuso), sem deixar o
    //   passageiro cobrado quando o motorista cancela antes de concluir.
    const { data: callerProfile } = await admin
      .from('profiles')
      .select('is_admin')
      .eq('id', user.id)
      .single();
    const isAdmin = (callerProfile as { is_admin?: boolean } | null)?.is_admin === true;
    const isParticipant = user.id === r.passenger_id || user.id === r.driver_id;

    if (!isAdmin) {
      if (!isParticipant) {
        return json({ error: 'Não autorizado a estornar esta corrida.' }, 403);
      }
      if (r.status === 'completed') {
        return json({
          error: 'Corrida já concluída. Estornos de corridas concluídas são feitos apenas pela administração.',
          code: 'completed_admin_only',
        }, 403);
      }
    }

    // Corrida sem cobrança — nada a extornar.
    // (`payout_id` preenchido aqui seria um estado impossível pelo fluxo normal:
    // o repasse exige `paid = true`. Vai no retorno para não sumir do radar de
    // quem estiver depurando.)
    if (!r.paid || !r.stripe_payment_intent_id) {
      return json({ success: true, no_charge: true, payout_id: r.payout_id ?? null });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 1) A PARTE DO MOTORISTA JÁ SAIU? Se saiu, reverte ANTES de estornar.
    // ═══════════════════════════════════════════════════════════════════════
    // A ordem importa. O transfer é sacado da própria cobrança
    // (`source_transaction`), então reverter primeiro devolve o dinheiro ao
    // saldo da plataforma e só então o refund ao passageiro sai desse saldo. Na
    // ordem inversa, a plataforma estorna primeiro e fica descoberta no
    // intervalo.
    const accountId = await driverAccountId(admin, r.driver_id);
    const transfer = r.payout_id && accountId
      ? await findTransferForRide(admin, {
          rideId,
          payoutId: r.payout_id,
          accountId,
          kind: 'fare',
        })
      : null;

    const plan = planDriverReversal({
      payoutId: r.payout_id,
      accountId,
      transfer,
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 2) Situação da GORJETA — cobrança separada (0064), NÃO estornada aqui
    // ═══════════════════════════════════════════════════════════════════════
    // Os dois casos são pendência humana, por motivos diferentes, e nenhum deles
    // pode virar uma política automática de estorno de gorjeta (isso seria
    // decidir dinheiro no lugar do dono). Ver TipDisposition.
    //
    // `tip_amount > 0` já significa gorjeta COBRADA: tip-ride só grava a coluna
    // depois do PaymentIntent da gorjeta ter sucesso (tip-ride/index.ts:132-134).
    //
    // `tip_payout_id` preenchido NÃO significa "transferida". `claimPendingTips`
    // (_shared/tipPayout.ts:47 — arquivo do dono, apenas lido) RESERVA a gorjeta
    // gravando a coluna ANTES de `settleTips` chamar o Stripe. Enquanto o
    // repasse roda — e para sempre, se ele morrer no meio, até
    // `unstickStalePayouts` soltar a reserva em ~15 min — a corrida carrega um
    // `tip_payout_id` sem transfer nenhum atrás dele. Derivar 'transferred' só
    // da coluna fazia a nota operacional AFIRMAR que "a gorjeta já foi repassada
    // ao motorista" quando ela podia não ter saído, e o operador que lê essa
    // frase decide dinheiro em cima dela.
    //
    // O status do REPASSE é que responde. `completed` é o único terminal de
    // sucesso (request-payout/index.ts:381, run-weekly-payouts/index.ts:230); e
    // quando um transfer de gorjeta falha DENTRO de um repasse que fechou
    // `completed`, o `tip_payout_id` daquela corrida é devolvido a null
    // (run-weekly-payouts/index.ts:207-209) — então `completed` + coluna
    // preenchida é, de fato, transferida.
    const tipCents = Math.round((r.tip_amount ?? 0) * 100);
    const tipPayoutState = r.tip_payout_id ? await payoutStatus(admin, r.tip_payout_id) : null;
    const tip: TipDisposition =
      tipCents <= 0            ? 'none' :
      !r.tip_payout_id         ? 'charged_not_transferred' :
      tipPayoutState === 'completed' ? 'transferred' :
                                 'charged_payout_pending';

    // ═══════════════════════════════════════════════════════════════════════
    // 3) Sequência de dinheiro — extraída para _shared/refundFlow.ts
    // ═══════════════════════════════════════════════════════════════════════
    // A ordem (reverter → estornar → paid = false → registrar) e o tratamento de
    // cada meio-caminho moram lá, atrás de portas injetáveis, para poderem ser
    // exercitados por teste. Aqui ficam apenas as ligações reais ao Stripe e ao
    // Supabase.
    const ports: RefundPorts = {
      createReversal: async ({ transferId, amountCents, rideId: rid }) => {
        // `amount` explícito: reverte só o que ainda não foi revertido, o que
        // torna uma retentativa segura mesmo depois de uma reversão parcial.
        // A idempotencyKey cobre a janela curta de duas chamadas em paralelo; a
        // proteção de longo prazo é o próprio `amount_reversed` lido do Stripe,
        // que não expira (a chave de idempotência expira em ~24 h).
        const rev = await stripe.transfers.createReversal(transferId, {
          amount: amountCents,
          metadata: { ride_id: rid, reason: 'ride_refund' },
        }, {
          idempotencyKey: `reverse_${transferId}_${amountCents}`,
        });
        return { id: rev.id };
      },
      createRefund: async ({ paymentIntentId, rideId: rid, reversalId, idempotencyKey }) => {
        const refund = await stripe.refunds.create({
          payment_intent: paymentIntentId,
          metadata: { ride_id: rid, reversal_id: reversalId ?? '' },
        }, { idempotencyKey });
        return { id: refund.id, status: refund.status, amount: refund.amount };
      },
      markUnpaid: async (rid) => {
        const { error } = await admin.from('rides').update({ paid: false }).eq('id', rid);
        return { error: error ? { message: error.message, code: error.code ?? null } : null };
      },
      recordAudit: (row) => recordRefundAudit(admin, row),
      alertAdmins: (message, meta) => alertAdmins(admin, message, meta),
    };

    const result = await runRefundFlow(ports, {
      rideId,
      paymentIntentId: r.stripe_payment_intent_id,
      plan,
      driverId: r.driver_id ?? null,
      payoutId: r.payout_id ?? null,
      driverAmount: r.driver_amount ?? null,
      tipAmount: r.tip_amount ?? null,
      tipPayoutId: r.tip_payout_id ?? null,
      rideStatus: r.status ?? null,
      tip,
    });

    return json(result.body, result.status);
  } catch (e: unknown) {
    const stripeErr = e as { raw?: { message?: string }; message?: string };
    const msg = stripeErr?.raw?.message ?? stripeErr?.message ?? String(e);
    return json({ error: msg }, 500);
  }
});

/**
 * Status do repasse (`payouts.status`), ou null se a linha não existir.
 *
 * Só três valores são escritos no repositório: 'processing' (na criação),
 * 'completed' e 'failed'. Qualquer coisa que NÃO seja 'completed' — inclusive a
 * linha ausente — é tratada pelo chamador como "não dá para afirmar que o
 * dinheiro saiu", que é o lado seguro do erro: a nota operacional passa a pedir
 * conferência em vez de afirmar um repasse.
 */
async function payoutStatus(admin: SupabaseClient, payoutId: string): Promise<string | null> {
  const { data } = await admin
    .from('payouts')
    .select('status')
    .eq('id', payoutId)
    .maybeSingle();
  return (data as { status?: string | null } | null)?.status ?? null;
}

/** Conta conectada (Express) do motorista da corrida, se houver. */
async function driverAccountId(admin: SupabaseClient, driverId?: string | null): Promise<string | null> {
  if (!driverId) return null;
  const { data } = await admin
    .from('profiles')
    .select('stripe_account_id')
    .eq('id', driverId)
    .maybeSingle();
  return (data as { stripe_account_id?: string | null } | null)?.stripe_account_id ?? null;
}

/**
 * Localiza no Stripe o transfer desta corrida, varrendo os transfers da conta
 * conectada e casando por `metadata` (ver findRideTransfer).
 *
 * A janela de datas vem do próprio repasse e é fechada nos DOIS lados — sem o
 * limite superior a varredura começava em "hoje" e caminhava para trás, longe do
 * alvo (ver o comentário de MAX_TRANSFER_PAGES).
 */
async function findTransferForRide(
  admin: SupabaseClient,
  input: { rideId: string; payoutId: string; accountId: string; kind: 'fare' | 'tip' },
): Promise<TransferShape | null> {
  // Âncora temporal: o transfer foi criado no processamento do repasse.
  let createdGte: number | undefined;
  const { data: payout } = await admin
    .from('payouts')
    .select('requested_at, processed_at')
    .eq('id', input.payoutId)
    .maybeSingle();
  const p = payout as { requested_at?: string | null; processed_at?: string | null } | null;
  const anchor = p?.requested_at ?? p?.processed_at ?? null;
  if (anchor) {
    const ms = Date.parse(anchor);
    if (Number.isFinite(ms)) createdGte = Math.floor(ms / 1000) - TRANSFER_LOOKBACK_SEC;
  }

  let startingAfter: string | undefined;
  for (let page = 0; page < MAX_TRANSFER_PAGES; page++) {
    const params: Stripe.TransferListParams = { destination: input.accountId, limit: 100 };
    // Janela FECHADA: sem o `lte` a página 0 traz os transfers mais recentes da
    // conta, e o alvo (o mais antigo do conjunto) fica na última página.
    if (createdGte) params.created = { gte: createdGte, lte: createdGte + TRANSFER_WINDOW_SEC };
    if (startingAfter) params.starting_after = startingAfter;

    const list = await stripe.transfers.list(params);
    const hit = findRideTransfer(list.data as unknown as TransferShape[], input);
    if (hit) {
      // Releitura direta: `amount_reversed` precisa estar fresco, é ele que
      // impede reverter duas vezes.
      const fresh = await stripe.transfers.retrieve(hit.id);
      return fresh as unknown as TransferShape;
    }
    if (!list.has_more || list.data.length === 0) return null;
    startingAfter = list.data[list.data.length - 1].id;
  }
  return null;
}

/**
 * Linha de conciliação do estorno. Mesma tabela e mesma idempotência por
 * `event_id` que o stripe-webhook usa (migração 0039) — `needs_attention = true`
 * é o que faz um estorno mal fechado aparecer para a equipe em vez de sumir.
 *
 * Nunca derruba o estorno: se a gravação falhar, loga e segue (o dinheiro já se
 * moveu; falhar aqui só esconderia o resultado do chamador).
 */
async function recordRefundAudit(
  admin: SupabaseClient,
  row: RefundAuditRow,
): Promise<void> {
  try {
    await admin.from('stripe_reconciliation').upsert({
      event_id:        row.eventId,
      event_type:      `refund.ride.${row.code}`,
      object_id:       row.rideId,
      amount_cents:    row.amountCents,
      currency:        'usd',
      driver_id:       row.driverId,
      payout_id:       row.payoutId,
      reason:          row.reason,
      needs_attention: row.needsAttention,
      raw:             { ride_id: row.rideId, ...row.raw },
    }, { onConflict: 'event_id', ignoreDuplicates: true });
  } catch (e) {
    console.error('Falha ao gravar stripe_reconciliation do estorno', e);
  }
}

/** Alerta a equipe: webhook externo (se configurado) + push aos admins. Best-effort. */
async function alertAdmins(
  admin: SupabaseClient,
  message: string,
  meta: Record<string, unknown>,
): Promise<void> {
  if (ALERT_WEBHOOK_URL) {
    try {
      await fetch(ALERT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message }),
      });
    } catch (e) {
      console.error('Falha ao chamar ALERT_WEBHOOK_URL', e);
    }
  }
  try {
    const { data: admins } = await admin
      .from('profiles')
      .select('push_token')
      .eq('is_admin', true)
      .not('push_token', 'is', null);
    const tokens = ((admins ?? []) as { push_token: string | null }[])
      .map((a) => a.push_token)
      .filter((t): t is string => !!t);
    if (tokens.length === 0) return;
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tokens.map((to) => ({
        to, title: '🚨 Go XL — estorno', body: message, data: meta, sound: 'default', priority: 'high',
      }))),
    });
  } catch (e) {
    console.error('Falha ao alertar admins sobre o estorno', e);
  }
}
