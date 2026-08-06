// Supabase Edge Function — recebe eventos do Stripe e atualiza o banco.
//
// Eventos tratados:
//   checkout.session.completed (mode=setup) → grava payment_method_id + card_last4 + card_brand
//   payment_intent.succeeded                → marca rides.paid = true (backup do charge-ride)
//   payment_intent.payment_failed           → marca rides.paid = false (cobrança recusada)
//   account.updated                          → espelha flags Connect + atribui faixa de
//                                              comissão na 1ª habilitação + tira o motorista
//                                              do ar se a conta for desabilitada pelo Stripe
//   transfer.created / payout.paid           → log de reconciliação financeira
//   charge.dispute.created                   → alerta de disputa (chargeback)
//
// Deploy:  npx supabase functions deploy stripe-webhook
// Segredo: npx supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
//   (obtido no Stripe Dashboard → Developers → Webhooks → seu endpoint)
//   Se não estiver configurado, a assinatura não é verificada (só usar em dev).

import Stripe from 'npm:stripe@17';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2025-01-27.acacia',
});

const webhookSecret       = Deno.env.get('STRIPE_WEBHOOK_SECRET')     ?? '';
// Em produção o STRIPE_WEBHOOK_SECRET é OBRIGATÓRIO. Para DEV local sem secret,
// setar ALLOW_UNSIGNED_WEBHOOK=true para aceitar eventos não assinados.
const ALLOW_UNSIGNED       = (Deno.env.get('ALLOW_UNSIGNED_WEBHOOK') ?? '') === 'true';
const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
// Opcional: URL de webhook do Slack/Discord/etc. para alertas em tempo real.
// Se não configurado, os alertas ainda vão como push aos admins + registro em DB.
const ALERT_WEBHOOK_URL    = Deno.env.get('ALERT_WEBHOOK_URL')         ?? '';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

/**
 * Grava um registro de reconciliação financeira. Idempotente por event_id — o
 * Stripe reentrega webhooks, e o upsert com ignoreDuplicates evita linhas
 * repetidas. Nunca deixa uma falha de gravação derrubar o webhook (o Stripe
 * reentregaria em loop); apenas loga.
 */
async function recordReconciliation(admin: Admin, row: Record<string, unknown>): Promise<void> {
  try {
    await admin
      .from('stripe_reconciliation')
      .upsert(row, { onConflict: 'event_id', ignoreDuplicates: true });
  } catch (e) {
    console.error('Falha ao gravar stripe_reconciliation', e);
  }
}

/** Envia push (Expo) para todos os admins com push_token. Best-effort. */
async function pushToAdmins(
  admin: Admin,
  title: string,
  bodyText: string,
  data: Record<string, unknown>,
): Promise<void> {
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
    const messages = tokens.map((to) => ({
      to, title, body: bodyText, data, sound: 'default', priority: 'high',
    }));
    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    });
  } catch (e) {
    console.error('Falha ao enviar push aos admins', e);
  }
}

/** Alerta a equipe: webhook externo (se configurado) + push aos admins. */
async function alertTeam(admin: Admin, message: string, meta: Record<string, unknown>): Promise<void> {
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
  await pushToAdmins(admin, '🚨 Go XL — alerta', message, meta);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const body = await req.text();
  const sig  = req.headers.get('stripe-signature') ?? '';

  let event: Stripe.Event;
  try {
    if (webhookSecret) {
      // No runtime do Supabase (Deno) a verificação de assinatura PRECISA ser
      // assíncrona — a versão síncrona (constructEvent) lança
      // "SubtleCryptoProvider cannot be used in a synchronous context" e faz
      // TODAS as entregas retornarem 400. Use sempre constructEventAsync aqui.
      event = await stripe.webhooks.constructEventAsync(body, sig, webhookSecret);
    } else if (ALLOW_UNSIGNED) {
      // DEV local apenas (opt-in explícito).
      event = JSON.parse(body) as Stripe.Event;
    } else {
      // Fail-closed: sem o secret não há como confiar no corpo — qualquer um
      // poderia forjar um evento e marcar corridas como pagas / anexar cartões.
      return new Response('Webhook secret não configurado', { status: 400 });
    }
  } catch (e) {
    return new Response(`Webhook error: ${e}`, { status: 400 });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // ── checkout.session.completed (modo setup) ──────────────────────────────
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;

    if (session.mode === 'setup' && session.setup_intent) {
      const passengerId = session.metadata?.passenger_id;
      if (!passengerId) {
        return new Response(JSON.stringify({ warning: 'passenger_id ausente no metadata' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Recupera o SetupIntent para obter o payment_method
      const setupIntent = await stripe.setupIntents.retrieve(
        session.setup_intent as string,
      );
      const pmId = setupIntent.payment_method as string | null;
      if (!pmId) {
        return new Response(JSON.stringify({ warning: 'payment_method ausente no setup_intent' }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Detalhes do cartão (last4, brand)
      const pm   = await stripe.paymentMethods.retrieve(pmId);
      const card = pm.card;

      // Define como método padrão do Customer
      await stripe.customers.update(session.customer as string, {
        invoice_settings: { default_payment_method: pmId },
      });

      // Busca dados do customer para popular o perfil se ele não existir
      const customer = await stripe.customers.retrieve(session.customer as string) as Stripe.Customer;

      // Busca o perfil atual para PRESERVAR os campos já preenchidos —
      // o upsert sobrescreveria phone/rating/total_rides/full_name com defaults.
      const { data: existing } = await admin
        .from('profiles')
        .select('*')
        .eq('id', passengerId)
        .single();
      const ex = existing as Record<string, unknown> | null;

      // UPSERT: se o perfil não existir no banco (ex: signup incompleto),
      // cria um mínimo válido com os dados do Stripe para não perder o cartão.
      // Se já existir, mantém os valores atuais (?? preserva).
      await admin.from('profiles').upsert({
        id:                       passengerId,
        email:                    (ex?.email as string)      ?? customer.email ?? '',
        full_name:                (ex?.full_name as string)  ?? customer.name  ?? '',
        phone:                    (ex?.phone as string)      ?? '',
        type:                     (ex?.type as string)       ?? 'passenger',
        rating:                   (ex?.rating as number)     ?? 5.0,
        total_rides:              (ex?.total_rides as number) ?? 0,
        language:                 (ex?.language as string)   ?? 'en',
        stripe_customer_id:       session.customer as string,
        stripe_payment_method_id: pmId,
        card_last4:               card?.last4  ?? null,
        card_brand:               card?.brand  ?? null,
      }, { onConflict: 'id' });
    }
  }

  // ── payment_intent.succeeded (backup) ───────────────────────────────────
  if (event.type === 'payment_intent.succeeded') {
    const pi     = event.data.object as Stripe.PaymentIntent;
    const rideId = pi.metadata?.rideId;
    if (rideId) {
      await admin.from('rides').update({ paid: true }).eq('id', rideId);
    }
  }

  // ── payment_intent.payment_failed ───────────────────────────────────────
  // Cobrança do passageiro recusada. Marca a corrida como não-paga (o
  // charge-ride já falha de forma síncrona no aceite; isto é a rede de
  // segurança assíncrona) e registra para acompanhamento.
  if (event.type === 'payment_intent.payment_failed') {
    const pi     = event.data.object as Stripe.PaymentIntent;
    const rideId = pi.metadata?.rideId;
    if (rideId) {
      await admin.from('rides').update({ paid: false }).eq('id', rideId);
    }
    console.warn('⚠️ payment_intent.payment_failed', {
      rideId, id: pi.id, reason: pi.last_payment_error?.message ?? null,
    });
  }

  // ── account.updated (Connect Express) ───────────────────────────────────
  // Fonte da verdade do estado da conta conectada do motorista. Espelha os
  // flags no perfil, atribui a faixa de comissão na 1ª habilitação de cobranças
  // e, se o Stripe desabilitar a conta (documentos pendentes, verificação
  // reprovada, etc.), tira o motorista do ar imediatamente.
  if (event.type === 'account.updated') {
    const account          = event.data.object as Stripe.Account;
    const chargesEnabled   = !!account.charges_enabled;
    const payoutsEnabled   = !!account.payouts_enabled;
    const onboardingDone    = !!account.details_submitted;
    const disabledReason   = account.requirements?.disabled_reason ?? null;

    const { data: prof } = await admin
      .from('profiles')
      .select('id')
      .eq('stripe_account_id', account.id)
      .single();
    const driverId = (prof as { id: string } | null)?.id;

    if (driverId) {
      await admin.from('profiles').update({
        stripe_onboarding_complete: onboardingDone,
        stripe_payouts_enabled:     payoutsEnabled,
        stripe_charges_enabled:     chargesEnabled,
      }).eq('id', driverId);

      // Atribui a faixa na 1ª habilitação (idempotente/race-safe no banco).
      if (chargesEnabled) {
        await admin.rpc('assign_driver_tier', { p_driver: driverId });
      }

      // Conta impedida de cobrar/repassar → tira do ar agora. O gating de
      // "ficar online" (que exige charges + payouts) impede novo retorno.
      if (disabledReason || !chargesEnabled || !payoutsEnabled) {
        await admin.from('driver_locations').update({ is_online: false }).eq('driver_id', driverId);
        console.warn('⚠️ Conta Connect desabilitada — motorista suspenso', {
          driverId, disabledReason, chargesEnabled, payoutsEnabled,
        });
        // Só alerta quando há motivo explícito de desabilitação do Stripe
        // (evita ruído durante o onboarding, quando os flags ainda são false).
        if (disabledReason) {
          await alertTeam(
            admin,
            `Conta Stripe do motorista ${driverId} foi desabilitada (motivo: ${disabledReason}). Motorista suspenso automaticamente.`,
            { type: 'connect_account_disabled', driverId, disabledReason },
          );
        }
      }
    }
  }

  // ── transfer.created / payout.paid — reconciliação financeira ────────────
  // O run-weekly-payouts já grava payouts.stripe_transfer_id ao criar o
  // transfer; estes eventos viram registro auditável em stripe_reconciliation.
  if (event.type === 'transfer.created') {
    const tr = event.data.object as Stripe.Transfer;
    await recordReconciliation(admin, {
      event_id:     event.id,
      event_type:   'transfer.created',
      object_id:    tr.id,
      amount_cents: tr.amount,
      currency:     tr.currency,
      driver_id:    (tr.metadata?.driver_id as string) ?? null,
      payout_id:    (tr.metadata?.payout_id as string) ?? null,
      raw: {
        destination: tr.destination,
        rides_count: tr.metadata?.rides_count ?? null,
        source:      tr.metadata?.source ?? null,
      },
    });
  }
  if (event.type === 'payout.paid') {
    const po = event.data.object as Stripe.Payout;
    await recordReconciliation(admin, {
      event_id:     event.id,
      event_type:   'payout.paid',
      object_id:    po.id,
      amount_cents: po.amount,
      currency:     po.currency,
      raw: { arrival_date: po.arrival_date, status: po.status, method: po.method },
    });
  }

  // ── charge.dispute.created (chargeback) — registra E alerta a equipe ─────
  if (event.type === 'charge.dispute.created') {
    const d = event.data.object as Stripe.Dispute;

    // Tenta associar a disputa a um motorista via a corrida cobrada (rides.
    // stripe_payment_intent_id → driver_id), para dar contexto no alerta.
    let driverId: string | null = null;
    const piId = typeof d.payment_intent === 'string' ? d.payment_intent : d.payment_intent?.id ?? null;
    if (piId) {
      const { data: ride } = await admin
        .from('rides')
        .select('driver_id')
        .eq('stripe_payment_intent_id', piId)
        .maybeSingle();
      driverId = (ride as { driver_id?: string } | null)?.driver_id ?? null;
    }

    await recordReconciliation(admin, {
      event_id:        event.id,
      event_type:      'charge.dispute.created',
      object_id:       d.id,
      amount_cents:    d.amount,
      currency:        d.currency,
      driver_id:       driverId,
      reason:          d.reason,
      needs_attention: true,
      raw: { charge: d.charge, status: d.status, payment_intent: piId },
    });

    const valor = (d.amount / 100).toFixed(2);
    await alertTeam(
      admin,
      `Nova disputa (chargeback) de ${d.currency?.toUpperCase()} ${valor} — motivo: ${d.reason}. Responda no Stripe antes do prazo.`,
      { type: 'stripe_dispute', disputeId: d.id, amount: d.amount, reason: d.reason },
    );
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
