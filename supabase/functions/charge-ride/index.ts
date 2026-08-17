// Supabase Edge Function — cobra o cartão salvo do passageiro no momento em que
// o motorista aceita a corrida (off-session, sem interação do passageiro).
//
// Deploy:  npx supabase functions deploy charge-ride
// Chamada: POST com { rideId: string } + JWT do motorista no header Authorization

import Stripe from 'npm:stripe@17';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2025-01-27.acacia',
});

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')              ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const SUPABASE_ANON_KEY    = Deno.env.get('SUPABASE_ANON_KEY')         ?? '';

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
    const { rideId } = await req.json();
    if (!rideId) return json({ error: 'rideId obrigatório' }, 400);

    // ── Autenticação: exige JWT válido de um MOTORISTA ───────────────────────
    // A cobrança acontece no aceite, ANTES do driver_id ser gravado na corrida,
    // então não dá pra amarrar ao motorista daquela corrida específica. Mas
    // restringir a usuários do tipo 'driver' fecha o buraco de "qualquer usuário
    // logado cobra qualquer corrida".
    const authHeader = req.headers.get('Authorization') ?? '';
    const { data: { user }, error: authErr } = await createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    }).auth.getUser();
    if (authErr || !user) return json({ error: 'Não autorizado' }, 401);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // ── Busca dados da corrida ───────────────────────────────────────────────
    const { data: ride, error: rideErr } = await admin
      .from('rides')
      .select('passenger_id, price, paid, status')
      .eq('id', rideId)
      .single();

    if (rideErr || !ride) return json({ error: 'Corrida não encontrada' }, 404);

    const r = ride as { passenger_id: string; price?: number; paid?: boolean; status: string };

    // Autorização. Dois chamadores legítimos, e só eles:
    //   • qualquer MOTORISTA — a cobrança do aceite acontece antes de o
    //     driver_id existir na corrida, então não dá para amarrar ao motorista
    //     daquela corrida específica;
    //   • o PASSAGEIRO DAQUELA corrida — é o caso do agendamento que o próprio
    //     passageiro ativa (o cartão cobrado é o dele, não há vetor de abuso).
    // A busca da corrida vem antes justamente para poder fazer essa segunda
    // checagem; sem ela, ativar uma agendada pelo app do passageiro devolvia
    // 403 e a corrida seguia sem cobrança nenhuma.
    if (user.id !== r.passenger_id) {
      const { data: caller } = await admin
        .from('profiles').select('type').eq('id', user.id).single();
      if ((caller as { type?: string } | null)?.type !== 'driver') {
        return json({ error: 'Não autorizado a cobrar esta corrida.' }, 403);
      }
    }

    // Idempotência: já foi cobrada
    if (r.paid) return json({ success: true, already_paid: true });

    // ── Busca dados de pagamento do passageiro ───────────────────────────────
    const { data: passenger, error: passengerErr } = await admin
      .from('profiles')
      .select('stripe_customer_id, stripe_payment_method_id, full_name')
      .eq('id', r.passenger_id)
      .single();

    const p = passenger as {
      stripe_customer_id?: string;
      stripe_payment_method_id?: string;
      full_name?: string;
    } | null;

    if (passengerErr || !p?.stripe_customer_id || !p?.stripe_payment_method_id) {
      return json({ error: 'Passageiro sem cartão salvo. Solicite que ele adicione um cartão no app.' }, 400);
    }

    const amount = Math.round((r.price ?? 0) * 100);
    if (amount < 50) return json({ error: 'Valor da corrida inválido' }, 400);

    // ── Cobra off-session ────────────────────────────────────────────────────
    const paymentIntent = await stripe.paymentIntents.create({
      amount,
      currency: 'usd',
      customer: p.stripe_customer_id,
      payment_method: p.stripe_payment_method_id,
      off_session: true,
      confirm: true,
      // `type` explícito: o webhook distingue tarifa de gorjeta por este campo.
      metadata: { rideId, type: 'fare' },
      description: 'Go XL — Executive XL',
    }, {
      // Idempotência no lado do Stripe: duas chamadas rápidas para a mesma
      // corrida não geram duas cobranças (protege contra corrida antes do
      // flag `paid` gravar no banco).
      idempotencyKey: `charge_${rideId}`,
    });

    if (paymentIntent.status === 'succeeded') {
      await admin.from('rides').update({
        paid: true,
        stripe_payment_intent_id: paymentIntent.id,
      }).eq('id', rideId);
      return json({ success: true });
    }

    return json({ error: `Pagamento retornou status inesperado: ${paymentIntent.status}` }, 400);
  } catch (e: unknown) {
    // Stripe lança StripeCardError para cartões recusados — mensagem legível
    const stripeErr = e as { raw?: { message?: string }; message?: string };
    const msg = stripeErr?.raw?.message ?? stripeErr?.message ?? String(e);
    return json({ error: msg }, 500);
  }
});
