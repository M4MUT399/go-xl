// list_unpaid_rides.ts — RELATÓRIO somente-leitura das corridas que RODARAM SEM
// COBRANÇA da tarifa.
//
// Contexto (2026-08-17): no Stripe apareceu só um crédito de US$ 10,00 (a
// gorjeta) para uma corrida de US$ 49,77. A causa não foi a gorjeta "anular" a
// tarifa — as duas cobranças são PaymentIntents independentes, com chaves de
// idempotência distintas (`charge_<rideId>` e `tip_<rideId>`), uma não
// sobrescreve a outra. A causa foi um buraco no fluxo de AGENDAMENTO:
//
//   • corrida imediata  → acceptRide() chama chargeRide() antes de travar → OK
//   • agendada SEM motorista → ativa como 'requesting' → cai no leque → OK
//   • agendada COM motorista confirmado → ia direto de 'scheduled' para
//     'accepted' e NUNCA passava por chargeRide() → corria de graça
//
// Este script mede o estrago: lista toda corrida concluída com `paid` falso,
// soma o dinheiro que ficou na mesa e separa quais eram agendamentos, para
// confirmar que o padrão bate com a causa acima.
//
// NÃO MUDA NADA — só lê e imprime.
//
// Como rodar (VOCÊ roda, no Terminal, dentro de /Users/mamute99/go-xl; a IA
// nunca tem a service_role key):
//   deno run --allow-env --allow-net --allow-read --node-modules-dir=auto supabase/scripts/list_unpaid_rides.ts

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { load } from 'jsr:@std/dotenv';

try {
  await load({ envPath: new URL('./.env', import.meta.url).pathname, export: true });
} catch {
  // .env ausente — segue com o que estiver no ambiente
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

function line(s = '') { console.log(s); }
const money = (n: number) => `$${n.toFixed(2)}`;

interface RideRow {
  id: string;
  status: string;
  price: number | null;
  paid: boolean | null;
  tip_amount: number | null;
  scheduled_for: string | null;
  driver_id: string | null;
  completed_at: string | null;
  created_at: string | null;
  stripe_payment_intent_id: string | null;
}

async function main() {
  line('════════════════════════════════════════════════════════');
  line(' list_unpaid_rides — corridas sem cobrança (NÃO MUDA NADA)');
  line('════════════════════════════════════════════════════════');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error('Faltam SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY no ambiente (veja supabase/scripts/.env).');
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY.trim());

  const { data, error } = await admin
    .from('rides')
    .select('id, status, price, paid, tip_amount, scheduled_for, driver_id, completed_at, created_at, stripe_payment_intent_id')
    .eq('status', 'completed')
    .order('completed_at', { ascending: false });

  if (error) throw new Error(`Erro ao ler rides: ${error.message}`);

  const rides = (data as RideRow[]) ?? [];
  const unpaid = rides.filter((r) => !r.paid);

  line(`Corridas concluídas no total: ${rides.length}`);
  line(`Concluídas SEM cobrança:      ${unpaid.length}`);
  line();

  if (unpaid.length === 0) {
    line('✅ Nenhuma corrida concluída sem cobrança.');
    return;
  }

  let totalPerdido = 0;
  let totalGorjetaRecebida = 0;
  let agendadas = 0;

  line('─'.repeat(56));
  for (const r of unpaid) {
    const price = Number(r.price ?? 0);
    const tip = Number(r.tip_amount ?? 0);
    totalPerdido += price;
    totalGorjetaRecebida += tip;
    const isScheduled = !!r.scheduled_for;
    if (isScheduled) agendadas++;

    line(`id .......... ${r.id}`);
    line(`quando ...... ${r.completed_at ?? r.created_at ?? '—'}`);
    line(`tipo ........ ${isScheduled ? `AGENDADA (para ${r.scheduled_for})` : 'imediata'}`);
    line(`tarifa ...... ${money(price)}  ← NÃO cobrada`);
    line(`gorjeta ..... ${tip > 0 ? `${money(tip)}  (essa foi cobrada)` : '—'}`);
    line(`payment_intent ${r.stripe_payment_intent_id ?? '⟨nenhum⟩'}`);
    line('─'.repeat(56));
  }

  line();
  line('RESUMO');
  line(`  Tarifa não cobrada (total) ....... ${money(totalPerdido)}`);
  line(`  Gorjetas que FORAM cobradas ...... ${money(totalGorjetaRecebida)}`);
  line(`  Dessas corridas, agendadas ....... ${agendadas} de ${unpaid.length}`);
  line();
  line('Se a maioria for AGENDADA, confirma a causa: o fluxo de agendamento com');
  line('motorista já confirmado pulava a cobrança. Corrigido em useRide.activate().');
}

main().catch((e) => {
  console.error('ERRO:', e instanceof Error ? e.message : e);
  Deno.exit(1);
});
