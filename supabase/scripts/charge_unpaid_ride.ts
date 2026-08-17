// charge_unpaid_ride.ts — cobra A TARIFA de UMA corrida que rodou sem cobrança.
//
// Contexto (2026-08-17): o bug do agendamento (corrigido em useRide.activate())
// deixou corridas concluídas com `paid` falso — rodaram de graça. Este script
// cobra UMA dessas, retroativamente, pelo mesmo caminho que o app usaria.
//
// POR QUE É SEGURO CONTRA COBRANÇA DUPLA:
// usa a MESMA chave de idempotência do app, `charge_<rideId>`. Se o app já
// tiver cobrado — ou vier a cobrar depois — o Stripe devolve o PaymentIntent
// que já existe em vez de criar outro. Não há como sair cobrança dobrada.
//
// DUAS ETAPAS, de propósito:
//   1) sem --confirm  → só MOSTRA o que seria cobrado. Não toca em nada.
//   2) com --confirm  → cobra de verdade.
//
// Como rodar (VOCÊ roda, no Terminal, dentro de /Users/mamute99/go-xl; a IA
// nunca tem a service_role key nem a chave do Stripe):
//
//   ver:     deno run --allow-env --allow-net --allow-read --node-modules-dir=auto supabase/scripts/charge_unpaid_ride.ts "Jeff Reina"
//   cobrar:  deno run --allow-env --allow-net --allow-read --node-modules-dir=auto supabase/scripts/charge_unpaid_ride.ts "Jeff Reina" --confirm
//
// Também aceita o id da corrida no lugar do nome.
//
// Exige em supabase/scripts/.env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY

import Stripe from 'npm:stripe@17';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { load } from 'jsr:@std/dotenv';

try {
  await load({ envPath: new URL('./.env', import.meta.url).pathname, export: true });
} catch {
  // .env ausente — segue com o que estiver no ambiente
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const STRIPE_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';

const line = (s = '') => console.log(s);
const money = (n: number) => `$${n.toFixed(2)}`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RideRow {
  id: string;
  status: string;
  price: number | null;
  paid: boolean | null;
  passenger_id: string;
  scheduled_for: string | null;
  completed_at: string | null;
  created_at: string | null;
  stripe_payment_intent_id: string | null;
}

// Uma corrida é cobrável quando está concluída e o dinheiro comprovadamente não
// entrou. São DOIS casos, e o segundo é o que o bug do webhook criava:
//   • paid = false                      → nunca cobrada, honestamente marcada
//   • paid = true SEM payment_intent    → o banco diz pago mas o Stripe não tem
//     cobrança nenhuma. Era a gorjeta quitando a corrida.
// Ter payment_intent gravado é a única prova de que houve cobrança de verdade.
const cobravel = (r: RideRow) => !r.stripe_payment_intent_id;

async function main() {
  const args = [...Deno.args];
  const confirm = args.includes('--confirm');
  const term = args.filter((a) => a !== '--confirm').join(' ').trim();

  line('════════════════════════════════════════════════════════');
  line(confirm
    ? ' charge_unpaid_ride — MODO COBRANÇA (vai cobrar de verdade)'
    : ' charge_unpaid_ride — modo consulta (NÃO cobra nada)');
  line('════════════════════════════════════════════════════════');

  if (!term) throw new Error('Passe o nome do passageiro ou o id da corrida. Ex.: ... charge_unpaid_ride.ts "Jeff Reina"');
  if (!SUPABASE_URL || !SERVICE_KEY) throw new Error('Faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY em supabase/scripts/.env');
  if (!STRIPE_KEY) throw new Error('Falta STRIPE_SECRET_KEY em supabase/scripts/.env');

  const admin = createClient(SUPABASE_URL, SERVICE_KEY.trim());
  // Mesma apiVersion da edge function charge-ride, para a cobrança sair
  // idêntica à do app. O cast existe só porque o pacote instalado localmente
  // tipa uma versão mais nova; em runtime o Stripe aceita a string.
  const stripe = new Stripe(STRIPE_KEY.trim(), {
    apiVersion: '2025-01-27.acacia' as Stripe.LatestApiVersion,
  });

  // ── Acha a corrida ────────────────────────────────────────────────────────
  const { data, error } = await admin
    .from('rides')
    .select('id, status, price, paid, passenger_id, scheduled_for, completed_at, created_at, stripe_payment_intent_id')
    .eq('status', 'completed')
    .order('completed_at', { ascending: false });
  if (error) throw new Error(`Erro ao ler rides: ${error.message}`);

  const unpaid = ((data as RideRow[]) ?? []).filter(cobravel);
  if (unpaid.length === 0) {
    line('Nenhuma corrida concluída sem cobrança. Nada a fazer.');
    return;
  }

  // nomes dos passageiros dessas corridas
  const ids = [...new Set(unpaid.map((r) => r.passenger_id))];
  const { data: profs } = await admin
    .from('profiles_public').select('id, full_name').in('id', ids);
  const nameOf = new Map<string, string>(
    ((profs as { id: string; full_name: string | null }[]) ?? [])
      .map((p) => [p.id, p.full_name ?? '']),
  );

  let matches: RideRow[];
  if (UUID_RE.test(term)) {
    matches = unpaid.filter((r) => r.id.toLowerCase() === term.toLowerCase());
  } else {
    const needle = term.toLowerCase();
    matches = unpaid.filter((r) => (nameOf.get(r.passenger_id) ?? '').toLowerCase().includes(needle));
  }

  if (matches.length === 0) {
    line(`Nenhuma corrida SEM COBRANÇA bate com "${term}".`);
    line('Corridas sem cobrança disponíveis:');
    for (const r of unpaid) {
      line(`  ${r.id}  ${nameOf.get(r.passenger_id) || '⟨sem nome⟩'}  ${money(Number(r.price ?? 0))}  ${r.completed_at ?? '—'}`);
    }
    return;
  }

  if (matches.length > 1) {
    line(`"${term}" bate com ${matches.length} corridas. Rode de novo passando o ID de UMA:`);
    for (const r of matches) {
      line(`  ${r.id}  ${nameOf.get(r.passenger_id) || '⟨sem nome⟩'}  ${money(Number(r.price ?? 0))}  ${r.completed_at ?? '—'}`);
    }
    return;
  }

  const ride = matches[0];
  const price = Number(ride.price ?? 0);

  // ── Cartão do passageiro ──────────────────────────────────────────────────
  const { data: pass } = await admin
    .from('profiles')
    .select('stripe_customer_id, stripe_payment_method_id, full_name')
    .eq('id', ride.passenger_id).single();
  const p = pass as {
    stripe_customer_id?: string;
    stripe_payment_method_id?: string;
    full_name?: string;
  } | null;

  if (!p?.stripe_customer_id || !p?.stripe_payment_method_id) {
    throw new Error('Passageiro está sem cartão salvo — não há como cobrar por aqui.');
  }

  let cartao = '⟨não consegui ler o cartão⟩';
  try {
    const pm = await stripe.paymentMethods.retrieve(p.stripe_payment_method_id);
    if (pm.card) cartao = `${pm.card.brand} •••• ${pm.card.last4} (val. ${pm.card.exp_month}/${pm.card.exp_year})`;
  } catch { /* segue sem o detalhe do cartão */ }

  line();
  line(`passageiro ... ${p.full_name ?? nameOf.get(ride.passenger_id) ?? '—'}`);
  line(`corrida ...... ${ride.id}`);
  line(`quando ....... ${ride.completed_at ?? ride.created_at ?? '—'}`);
  line(`tipo ......... ${ride.scheduled_for ? `AGENDADA (para ${ride.scheduled_for})` : 'imediata'}`);
  line(`tarifa ....... ${money(price)}  ← é isto que será cobrado`);
  line(`cartão ....... ${cartao}`);
  line(`paid no banco  ${ride.paid ? 'SIM (mas sem cobrança no Stripe — era a gorjeta quitando)' : 'não'}`);
  line(`idempotência . charge_${ride.id}`);
  line();

  const amount = Math.round(price * 100);
  if (amount < 50) throw new Error(`Valor inválido para cobrança: ${money(price)}`);

  if (!confirm) {
    line('MODO CONSULTA — nada foi cobrado.');
    line('Para cobrar de verdade, rode o MESMO comando com --confirm no fim.');
    return;
  }

  // ── Cobrança ──────────────────────────────────────────────────────────────
  line('Cobrando…');
  const pi = await stripe.paymentIntents.create({
    amount,
    currency: 'usd',
    customer: p.stripe_customer_id,
    payment_method: p.stripe_payment_method_id,
    off_session: true,
    confirm: true,
    metadata: { rideId: ride.id, retroativo: 'true' },
    description: 'Go XL — Executive XL',
  }, {
    // MESMA chave do app: garante que app e script nunca cobrem duas vezes.
    idempotencyKey: `charge_${ride.id}`,
  });

  if (pi.status !== 'succeeded') {
    throw new Error(`Stripe retornou status "${pi.status}" — nada foi confirmado. PaymentIntent: ${pi.id}`);
  }

  const { error: upErr } = await admin
    .from('rides')
    .update({ paid: true, stripe_payment_intent_id: pi.id })
    .eq('id', ride.id);

  line();
  line(`✅ COBRADO ${money(price)} — PaymentIntent ${pi.id}`);
  if (upErr) {
    line(`⚠️  A cobrança PASSOU, mas falhou marcar paid=true no banco: ${upErr.message}`);
    line('    Avise a IA: a corrida precisa ser marcada como paga manualmente.');
  } else {
    line('   Corrida marcada como paga no banco.');
  }
}

main().catch((e) => {
  console.error('ERRO:', e instanceof Error ? e.message : e);
  Deno.exit(1);
});
