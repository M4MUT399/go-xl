// Supabase Edge Function — cria uma sessão de Stripe Checkout (modo teste ou produção)
// Deploy:  npx supabase functions deploy create-checkout
// Segredo: npx supabase secrets set STRIPE_SECRET_KEY=sk_test_...
import Stripe from 'npm:stripe@17';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY') ?? '', {
  apiVersion: '2025-01-27.acacia',
});

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};

// O Supabase força text/plain nas respostas das Edge Functions (não serve HTML),
// então as paginas de retorno usam texto puro, sem acentos (a prova de charset).
function text(message: string): Response {
  return new Response(message, {
    headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const url = new URL(req.url);

  // Páginas de retorno do Checkout (success_url / cancel_url)
  const base = `${Deno.env.get('SUPABASE_URL')}/functions/v1/create-checkout`;

  if (req.method === 'GET') {
    if (url.searchParams.get('debug')) {
      return new Response(JSON.stringify({ base, supabaseUrl: Deno.env.get('SUPABASE_URL') }), {
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }
    const status = url.searchParams.get('status');
    if (status === 'success') {
      return text('Pagamento concluido com sucesso! Voce ja pode fechar esta janela e voltar ao app Go XL.');
    }
    return text('Pagamento cancelado. Nenhuma cobranca foi feita. Volte ao app para tentar novamente.');
  }

  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: CORS });
  }

  try {
    const { amount, description, rideId } = await req.json();
    const cents = Math.round(Number(amount) * 100);
    if (!cents || cents < 50) {
      return new Response(JSON.stringify({ error: 'Valor inválido' }), {
        status: 400,
        headers: { ...CORS, 'Content-Type': 'application/json' },
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: { name: description ?? 'Corrida Go XL — Executive XL' },
            unit_amount: cents,
          },
          quantity: 1,
        },
      ],
      metadata: { rideId: rideId ?? '' },
      success_url: `${base}?status=success`,
      cancel_url: `${base}?status=cancel`,
    });

    return new Response(JSON.stringify({ url: session.url, id: session.id }), {
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), {
      status: 500,
      headers: { ...CORS, 'Content-Type': 'application/json' },
    });
  }
});
