// Supabase Edge Function — cobra gorjeta do passageiro após o término da corrida.
//
// Deploy:  npx supabase functions deploy tip-ride --no-verify-jwt
// Chamada: POST com { rideId: string, amountCents: number } + JWT do passageiro

import Stripe from 'npm:stripe@17';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import {
  acharGorjetaCobrada,
  descreverFalhaDeGorjeta,
  tipIdempotencyKey,
} from '../_shared/tipCharge.ts';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2025-01-27.acacia',
});

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')         ?? '';

// Teto de gorjeta (proteção contra abuso/cobrança de valor arbitrário).
// Configurável por env; default $200.
//
// P2-10: o teto configurável passa a ser limitado por um teto RÍGIDO de $2000,
// que é o mesmo do CHECK `rides_fee_components_sane` (migração 0065:
// `tip_amount <= 2000`). Sem este `Math.min`, subir MAX_TIP_CENTS por variável
// de ambiente acima de 200000 abriria uma janela em que o Stripe COBRA o
// passageiro com sucesso e o UPDATE seguinte (`tip_amount: amountCents / 100`,
// mais abaixo) é rejeitado pelo banco: dinheiro capturado, gorjeta não
// registrada e — como o repasse sai de `tip_amount`/`tip_payment_intent_id` —
// gorjeta nunca paga a ninguém. Com o teto rígido, a recusa acontece ANTES da
// cobrança. Se um dia o produto precisar de gorjeta acima de $2000, é o CHECK
// que muda primeiro: os dois números não podem divergir.
const DB_MAX_TIP_CENTS = 200000; // espelha o CHECK tip_amount <= 2000 (0065)
const MAX_TIP_CENTS = Math.min(
  Number(Deno.env.get('MAX_TIP_CENTS') ?? '20000') || 20000,
  DB_MAX_TIP_CENTS,
);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

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
    const { rideId, amountCents } = await req.json();
    if (!rideId)      return json({ error: 'rideId obrigatório' }, 400);
    if (!amountCents || amountCents < 50)
      return json({ error: 'Valor mínimo de gorjeta: $0.50' }, 400);
    if (amountCents > MAX_TIP_CENTS)
      return json({ error: `Gorjeta acima do máximo permitido ($${(MAX_TIP_CENTS / 100).toFixed(2)}).` }, 400);

    // ── Autenticação do passageiro ───────────────────────────────────────────
    // Esta função é deployada com --no-verify-jwt, então a verificação precisa
    // acontecer AQUI no código (senão o endpoint fica aberto para cobrar o
    // cartão salvo de qualquer passageiro por quem souber o rideId).
    const authHeader = req.headers.get('Authorization') ?? '';
    const { data: { user }, error: authErr } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    }).auth.getUser();
    if (authErr || !user) return json({ error: 'Não autorizado' }, 401);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // ── Busca dados da corrida ───────────────────────────────────────────────
    const { data: ride, error: rideErr } = await admin
      .from('rides')
      .select('passenger_id, status, tip_amount, tip_payment_intent_id')
      .eq('id', rideId)
      .single();

    if (rideErr || !ride) return json({ error: 'Corrida não encontrada' }, 404);

    const r = ride as {
      passenger_id: string;
      status: string;
      tip_amount?: number;
      tip_payment_intent_id?: string | null;
    };

    // Autorização: só o passageiro DAQUELA corrida pode dar a gorjeta.
    if (user.id !== r.passenger_id) {
      return json({ error: 'Não autorizado a dar gorjeta nesta corrida.' }, 403);
    }

    // Idempotência COMPLETA: valor gravado E lastro do repasse gravado. Só com
    // os dois é que não há mais nada a fazer nesta corrida.
    //
    // Antes bastava `tip_amount > 0` para sair por aqui, e era isso que fazia a
    // gorjeta órfã ser permanente: a corrida 6acaf884 tem `tip_amount = 10`,
    // `tip_payment_intent_id` nulo e um PaymentIntent `succeeded` de $10 no
    // Stripe desde 17/08/2026. O passageiro pagou, o motorista nunca recebeu, e
    // toda chamada seguinte devolvia "já gorjetada" sem consertar nada.
    if (r.tip_amount && r.tip_amount > 0 && r.tip_payment_intent_id) {
      return json({ success: true, already_tipped: true });
    }

    // ── Busca dados de pagamento do passageiro ───────────────────────────────
    const { data: passenger, error: passengerErr } = await admin
      .from('profiles')
      .select('stripe_customer_id, stripe_payment_method_id')
      .eq('id', r.passenger_id)
      .single();

    const p = passenger as {
      stripe_customer_id?: string;
      stripe_payment_method_id?: string;
    } | null;

    // ── ANTES DE COBRAR: esta corrida já tem gorjeta paga no Stripe? ─────────
    //
    // O Stripe é a autoridade sobre o que foi cobrado; o banco é só o registro.
    // Quando os dois discordam — Stripe cobrou, banco não gravou —, o conserto é
    // gravar o que faltou, NUNCA cobrar de novo. Esta busca é o reparador da
    // órfã e, junto com ela, a trava contra cobrança dupla depois que a chave de
    // idempotência expira (~24 h).
    if (p?.stripe_customer_id) {
      let jaCobrada: { id: string; amount: number } | null = null;
      let buscaFalhou = false;
      try {
        const lista = await stripe.paymentIntents.list({
          customer: p.stripe_customer_id,
          limit: 100,
        });
        jaCobrada = acharGorjetaCobrada(lista.data, rideId);
      } catch (buscaErr) {
        console.error('[tip-ride] falha ao procurar gorjeta já cobrada', buscaErr);
        buscaFalhou = true;
      }

      if (jaCobrada) {
        // Reparo. `tip_payment_intent_id` é o que lastreia o transfer da gorjeta
        // ao motorista (source_transaction) — ver `_shared/tipPayout.ts` e a
        // migração 0064, que faz a gorjeta ir 100% para ele, fora do split.
        const { error: reparoErr } = await admin
          .from('rides')
          .update({
            tip_amount: jaCobrada.amount / 100,
            tip_payment_intent_id: jaCobrada.id,
          })
          .eq('id', rideId);

        if (reparoErr) {
          console.error('[tip-ride] reparo da gorjeta órfã falhou', { rideId, reparoErr });
          return json({
            error: 'Sua gorjeta já foi cobrada, mas não conseguimos registrá-la. Não tente de novo — nosso time vai corrigir.',
          }, 500);
        }
        return json({ success: true, already_tipped: true, repaired: true });
      }

      // A busca caiu E o banco diz que já existe gorjeta: parar é o erro
      // reversível. Cobrar às cegas aqui é o que geraria a SEGUNDA cobrança.
      if (buscaFalhou && r.tip_amount && r.tip_amount > 0) {
        return json({ error: 'Não conseguimos confirmar a gorjeta desta corrida agora. Tente de novo em instantes.' }, 503);
      }
    }

    // Valor já gravado sem cobrança correspondente no Stripe (as 84 linhas
    // legadas, anteriores ao guard de dinheiro da 0065): a corrida CONSTA como
    // gorjetada e não há charge para lastrear. Cobrar agora seria inventar uma
    // cobrança que o passageiro não pediu neste momento.
    if (r.tip_amount && r.tip_amount > 0) {
      return json({ success: true, already_tipped: true });
    }

    if (passengerErr || !p?.stripe_customer_id || !p?.stripe_payment_method_id) {
      return json({ error: 'Passageiro sem cartão salvo.' }, 400);
    }

    // ── Cobra a gorjeta off-session ──────────────────────────────────────────
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: p.stripe_customer_id,
      payment_method: p.stripe_payment_method_id,
      off_session: true,
      confirm: true,
      metadata: { rideId, type: 'tip' },
      description: 'Go XL — Gorjeta Executive XL',
    }, {
      // A chave inclui o VALOR. Sem ele, a primeira tentativa queimava a chave
      // com os parâmetros dela e qualquer valor diferente batia em
      // `idempotency_error` — a corrida não aceitava mais gorjeta nenhuma. Ver
      // `_shared/tipCharge.ts` para o porquê completo (item P2-5 da AUDITORIA).
      idempotencyKey: tipIdempotencyKey(rideId, amountCents),
    });

    if (paymentIntent.status === 'succeeded') {
      // Grava também o PaymentIntent DA GORJETA. Ele é o que lastreia o transfer
      // da gorjeta para o motorista (source_transaction) no repasse — sem esse
      // id a gorjeta não teria como ser paga a quem é de direito. Ver migração
      // 0064 para o porquê de a gorjeta ser um transfer separado do da tarifa.
      //
      // O erro do UPDATE era DESCARTADO aqui, e é assim que nasce a gorjeta
      // órfã: Stripe cobra, o banco recusa, ninguém fica sabendo e o motorista
      // nunca recebe. Agora ele é conferido — e o próximo toque do passageiro
      // cai no reparador acima em vez de gerar uma segunda cobrança.
      const { error: updateErr } = await admin
        .from('rides')
        .update({
          tip_amount: amountCents / 100,
          tip_payment_intent_id: paymentIntent.id,
        })
        .eq('id', rideId);

      if (updateErr) {
        console.error('[tip-ride] gorjeta cobrada mas NÃO gravada', {
          rideId,
          paymentIntentId: paymentIntent.id,
          amountCents,
          updateErr,
        });
        return json({
          error: 'Sua gorjeta foi cobrada, mas não conseguimos registrá-la. Não tente de novo — nosso time vai corrigir.',
        }, 500);
      }
      return json({ success: true });
    }

    return json({ error: `Status inesperado: ${paymentIntent.status}` }, 400);
  } catch (e: unknown) {
    // A mensagem técnica fica no log da função; para a tela vai uma frase que o
    // passageiro consegue agir. Antes o texto de engenharia da Stripe, em
    // inglês, ia cru para o Alert do app.
    console.error('[tip-ride] falha na cobrança da gorjeta', e);
    const falha = descreverFalhaDeGorjeta(e);
    return json({ error: falha.message }, falha.status);
  }
});
