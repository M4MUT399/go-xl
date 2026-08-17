// find_rides.ts — RELATÓRIO somente-leitura de corridas, sem filtro de status
// nem de pagamento.
//
// Por que existe: list_unpaid_rides.ts só olha corridas `completed` com `paid`
// falso. Se uma corrida sumiu desse relatório mas o dinheiro não apareceu no
// Stripe, é preciso olhar a corrida INTEIRA — status, paid, payment_intent e
// gorjeta — para saber se ela foi cobrada, se ficou num status intermediário,
// ou se foi marcada como paga sem cobrança correspondente.
//
// Uso (VOCÊ roda, no Terminal, dentro de /Users/mamute99/go-xl):
//
//   por nome:  deno run --allow-env --allow-net --allow-read --node-modules-dir=auto supabase/scripts/find_rides.ts "Jeff"
//   só de hoje: deno run --allow-env --allow-net --allow-read --node-modules-dir=auto supabase/scripts/find_rides.ts
//
// NÃO MUDA NADA — só lê e imprime.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { load } from 'jsr:@std/dotenv';

try {
  await load({ envPath: new URL('./.env', import.meta.url).pathname, export: true });
} catch {
  // .env ausente ou malformado — segue com o que estiver no ambiente
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const line = (s = '') => console.log(s);
const money = (n: number) => `$${n.toFixed(2)}`;

interface RideRow {
  id: string;
  status: string;
  price: number | null;
  paid: boolean | null;
  tip_amount: number | null;
  scheduled_for: string | null;
  passenger_id: string;
  driver_id: string | null;
  created_at: string | null;
  completed_at: string | null;
  stripe_payment_intent_id: string | null;
}

function show(r: RideRow, nome: string) {
  const price = Number(r.price ?? 0);
  const tip = Number(r.tip_amount ?? 0);
  line(`passageiro ..... ${nome || '⟨sem nome⟩'}`);
  line(`corrida ........ ${r.id}`);
  line(`status ......... ${r.status}`);
  line(`criada ......... ${r.created_at ?? '—'}`);
  line(`concluída ...... ${r.completed_at ?? '— (nunca concluída)'}`);
  line(`agendada p/ .... ${r.scheduled_for ?? '— (imediata)'}`);
  line(`tarifa ......... ${money(price)}`);
  line(`paid ........... ${r.paid ? 'SIM' : 'NÃO'}`);
  line(`payment_intent . ${r.stripe_payment_intent_id ?? '⟨nenhum⟩'}`);
  line(`gorjeta ........ ${tip > 0 ? money(tip) : '—'}`);
  if (r.paid && !r.stripe_payment_intent_id) {
    line('⚠️  MARCADA COMO PAGA SEM PAYMENT INTENT — o banco diz pago, o Stripe não tem cobrança.');
  }
  if (!r.paid && r.stripe_payment_intent_id) {
    line('⚠️  TEM PAYMENT INTENT MAS paid=false — cobrança saiu e o banco não registrou.');
  }
  line('─'.repeat(60));
}

async function main() {
  const term = Deno.args.join(' ').trim();

  line('════════════════════════════════════════════════════════');
  line(' find_rides — relatório de corridas (NÃO MUDA NADA)');
  line('════════════════════════════════════════════════════════');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error('Faltam SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY (veja supabase/scripts/.env).');
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY.trim());

  // Últimos 60 dias bastam para o que estamos investigando.
  const desde = new Date(Date.now() - 60 * 24 * 3600 * 1000).toISOString();

  const { data, error } = await admin
    .from('rides')
    .select('id, status, price, paid, tip_amount, scheduled_for, passenger_id, driver_id, created_at, completed_at, stripe_payment_intent_id')
    .gte('created_at', desde)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Erro ao ler rides: ${error.message}`);

  const rides = (data as RideRow[]) ?? [];
  const ids = [...new Set(rides.map((r) => r.passenger_id))];

  const nameOf = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data: profs } = await admin
      .from('profiles_public').select('id, full_name').in('id', ids.slice(i, i + 200));
    for (const p of (profs as { id: string; full_name: string | null }[]) ?? []) {
      nameOf.set(p.id, p.full_name ?? '');
    }
  }

  if (term) {
    const needle = term.toLowerCase();
    const hits = rides.filter((r) => (nameOf.get(r.passenger_id) ?? '').toLowerCase().includes(needle));
    line(`Corridas de passageiros que batem com "${term}": ${hits.length}`);
    line('─'.repeat(60));
    for (const r of hits) show(r, nameOf.get(r.passenger_id) ?? '');
    if (hits.length === 0) {
      line('Nenhuma. Nomes de passageiros com corrida nos últimos 60 dias:');
      const nomes = [...new Set(rides.map((r) => nameOf.get(r.passenger_id) ?? '⟨sem nome⟩'))].sort();
      for (const n of nomes) line(`  • ${n}`);
      line('─'.repeat(60));
    }
  }

  // ── O estrago de verdade ──────────────────────────────────────────────────
  // Corrida CONCLUÍDA marcada como paga mas sem PaymentIntent: o banco diz que
  // recebeu, o Stripe não tem cobrança nenhuma. Era o buraco do webhook, que
  // aceitava a gorjeta como se fosse a tarifa.
  const fantasmas = rides.filter(
    (r) => r.status === 'completed' && r.paid && !r.stripe_payment_intent_id,
  );
  line();
  line(`PAGAS SEM COBRANÇA NO STRIPE: ${fantasmas.length}`);
  line('(banco diz pago, Stripe não tem PaymentIntent — dinheiro não entrou)');
  line('─'.repeat(60));
  let totalFantasma = 0;
  for (const r of fantasmas) {
    totalFantasma += Number(r.price ?? 0);
    show(r, nameOf.get(r.passenger_id) ?? '');
  }
  if (fantasmas.length === 0) line('Nenhuma. ✅');
  else line(`TOTAL NÃO RECEBIDO: ${money(totalFantasma)}`);

  // Sempre mostra o dia de hoje — por data de CONCLUSÃO, não de criação: um
  // agendamento criado dias antes conclui hoje e precisa aparecer aqui.
  const hoje = new Date().toISOString().slice(0, 10);
  const doDia = rides.filter((r) =>
    (r.completed_at ?? '').slice(0, 10) === hoje || (r.created_at ?? '').slice(0, 10) === hoje);
  line();
  line(`CORRIDAS DE HOJE (${hoje}): ${doDia.length}`);
  line('(criadas OU concluídas hoje)');
  line('─'.repeat(60));
  for (const r of doDia) show(r, nameOf.get(r.passenger_id) ?? '');
  if (doDia.length === 0) line('Nenhuma corrida criada nem concluída hoje.');
}

main().catch((e) => {
  console.error('ERRO:', e instanceof Error ? e.message : e);
  Deno.exit(1);
});
