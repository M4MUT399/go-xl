// send_stripe_receipts.ts — dispara o RECIBO DA STRIPE das cobranças de corrida.
//
// ── O QUE ISTO É, E O QUE NÃO É ────────────────────────────────────────────
//
// É a ponte, não o destino. O recibo da Stripe traz valor, cartão, data e o
// nome do comerciante — comprovante de PAGAMENTO. Ele NÃO traz trajeto,
// motorista, distância nem a quebra da tarifa; isso é o recibo do Go XL, que
// sai por `supabase/functions/send-ride-receipt` assim que houver um provedor
// de e-mail configurado.
//
// Por que existe mesmo assim: até 21/09/2026 o projeto não tinha canal de
// e-mail nenhum, e nenhum passageiro jamais recebeu comprovante de nada. A
// Stripe consegue mandar hoje, de graça, sem domínio verificado e sem chave
// nova — preenchendo `receipt_email` numa cobrança que já existe, ela dispara
// o recibo na hora.
//
// ── IDEMPOTÊNCIA ───────────────────────────────────────────────────────────
//
// Cobrança que JÁ tem `receipt_email` é pulada. A Stripe reenvia o recibo a
// cada vez que esse campo é gravado, então rodar de novo sem essa trava
// mandaria e-mail repetido para cliente de verdade.
//
// ── USO (VOCÊ roda, dentro de /Users/mamute99/go-xl) ───────────────────────
//
//   ensaio:   deno run --allow-env --allow-net --allow-read --node-modules-dir=none supabase/scripts/send_stripe_receipts.ts
//   enviar:   deno run --allow-env --allow-net --allow-read --node-modules-dir=none supabase/scripts/send_stripe_receipts.ts --aplicar
//
// Aceita `--desde AAAA-MM-DD` (padrão: 2026-09-07) e `--gorjetas` para incluir
// também as cobranças de gorjeta, que são PaymentIntents próprios e geram um
// segundo recibo por corrida.

import Stripe from 'npm:stripe@17';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { load } from 'jsr:@std/dotenv';

try { await load({ envPath: new URL('./.env', import.meta.url).pathname, export: true }); } catch { /* usa o ambiente */ }

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const STRIPE_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
if (!SUPABASE_URL || !SERVICE_KEY || !STRIPE_KEY) {
  console.error('Faltam SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY ou STRIPE_SECRET_KEY em supabase/scripts/.env');
  Deno.exit(1);
}

const APLICAR = Deno.args.includes('--aplicar');
const COM_GORJETA = Deno.args.includes('--gorjetas');
const iDesde = Deno.args.indexOf('--desde');
const DESDE = iDesde >= 0 ? Deno.args[iDesde + 1] : '2026-09-07';

const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const stripe = new Stripe(STRIPE_KEY, { apiVersion: '2025-01-27.acacia' });
const line = (s = '') => console.log(s);
const fmt = (n: number) => `US$ ${n.toFixed(2)}`;

const { data, error } = await sb
  .from('rides')
  .select('id, completed_at, price, tip_amount, passenger_id, stripe_payment_intent_id, tip_payment_intent_id')
  .eq('status', 'completed')
  .gte('completed_at', DESDE)
  .not('stripe_payment_intent_id', 'is', null)
  .order('completed_at');

if (error) { console.error('Falha ao ler as corridas:', error.message); Deno.exit(1); }
const corridas = (data ?? []) as Record<string, string | number | null>[];

const paxIds = [...new Set(corridas.map((r) => r.passenger_id as string))];
const { data: profs } = await sb.from('profiles').select('id, full_name, email').in('id', paxIds);
const pax = new Map(((profs ?? []) as { id: string; full_name: string | null; email: string | null }[]).map((p) => [p.id, p]));

line(`Corridas concluídas desde ${DESDE} com cobrança: ${corridas.length}`);
line(APLICAR ? 'Modo: ENVIAR (a Stripe dispara o e-mail na hora)' : 'Modo: ENSAIO (nada é enviado)');
line();

let enviados = 0, pulados = 0, semEmail = 0;

async function recibo(piId: string, rotulo: string, email: string, valorEsperado: number) {
  const pi = await stripe.paymentIntents.retrieve(piId, { expand: ['latest_charge'] });
  const ch = pi.latest_charge as Stripe.Charge | null;
  if (!ch) { line(`   ⏭  ${rotulo}: PaymentIntent sem cobrança. Nada a enviar.`); pulados++; return; }
  if (ch.receipt_email) {
    // A Stripe REENVIA a cada gravação deste campo — pular é o que impede
    // e-mail repetido para cliente de verdade.
    line(`   ⏭  ${rotulo}: recibo já enviado para ${ch.receipt_email}.`);
    pulados++; return;
  }
  line(`   ✉️  ${rotulo}: ${fmt(valorEsperado)} → ${email}`);
  if (!APLICAR) return;
  await stripe.charges.update(ch.id, { receipt_email: email });
  enviados++;
}

for (const r of corridas) {
  const p = pax.get(r.passenger_id as string);
  const quando = String(r.completed_at ?? '').slice(0, 10);
  const nome = p?.full_name?.trim() || '(sem nome)';
  line(`${quando}  ${nome}`);

  const email = p?.email?.trim();
  if (!email) {
    line('   ⏭  passageiro sem e-mail cadastrado. Nada a enviar.');
    semEmail++; continue;
  }

  await recibo(r.stripe_payment_intent_id as string, 'tarifa', email, Number(r.price) || 0);

  if (COM_GORJETA && r.tip_payment_intent_id) {
    await recibo(r.tip_payment_intent_id as string, 'gorjeta', email, Number(r.tip_amount) || 0);
  }
  line();
}

line(`Resumo: ${enviados} recibo(s) enviado(s), ${pulados} pulado(s), ${semEmail} sem e-mail.`);
if (!APLICAR) line('ENSAIO — nada foi enviado. Rode de novo com --aplicar para valer.');
