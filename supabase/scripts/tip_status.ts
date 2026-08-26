// tip_status.ts — RELATÓRIO somente-leitura das GORJETAS.
//
// Por que existe: a partir da migração 0064 a gorjeta virou dinheiro do
// motorista, com repasse próprio (transfer separado, sacado da cobrança da
// gorjeta). Antes de confiar nesse caminho é preciso saber, com dados e não com
// suposição, QUAIS gorjetas existem, quais já foram repassadas, e quais o
// código consegue de fato pagar.
//
// As três condições para uma gorjeta ser repassada (ver _shared/tipPayout.ts →
// claimPendingTips) são: tip_amount > 0, paid = true e tip_payout_id nulo.
// Este relatório mostra cada uma separadamente, para que uma gorjeta presa
// apareça com o MOTIVO de estar presa, em vez de simplesmente não aparecer.
//
// A distinção que mais importa aqui é o tip_payment_intent_id:
//
//   COM o id  → o transfer é sacado da cobrança da própria gorjeta
//               (source_transaction). Não depende de saldo na plataforma.
//   SEM o id  → o transfer sai do saldo disponível da plataforma. É o caso das
//               gorjetas cobradas ANTES da 0064, quando esse id não era gravado.
//               Se não houver saldo, o Stripe recusa e a gorjeta volta para a
//               fila — nunca se perde, mas também nunca é paga sozinha.
//
// Uso (VOCÊ roda, no Terminal, dentro de /Users/mamute99/go-xl):
//
//   deno run --allow-env --allow-net --allow-read --node-modules-dir=auto supabase/scripts/tip_status.ts
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

interface TipRow {
  id: string;
  paid: boolean | null;
  tip_amount: number | null;
  tip_payout_id: string | null;
  tip_payment_intent_id: string | null;
  passenger_id: string;
  driver_id: string | null;
  completed_at: string | null;
}

async function main() {
  line('════════════════════════════════════════════════════════');
  line(' tip_status — relatório de GORJETAS (NÃO MUDA NADA)');
  line('════════════════════════════════════════════════════════');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error('Faltam SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY (veja supabase/scripts/.env).');
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY.trim());

  // Sem recorte de data: gorjeta retida é passivo, não importa a idade.
  const { data, error } = await admin
    .from('rides')
    .select('id, paid, tip_amount, tip_payout_id, tip_payment_intent_id, passenger_id, driver_id, completed_at')
    .gt('tip_amount', 0)
    .order('completed_at', { ascending: false });
  if (error) throw new Error(`Erro ao ler rides: ${error.message}`);

  const tips = (data as TipRow[]) ?? [];

  if (tips.length === 0) {
    line();
    line('Nenhuma gorjeta registrada no banco. Nada a repassar. ✅');
    return;
  }

  // Nomes de motorista e passageiro, e quem tem conta Stripe para receber.
  const ids = [...new Set(tips.flatMap((t) => [t.passenger_id, t.driver_id].filter(Boolean) as string[]))];
  const nameOf = new Map<string, string>();
  const accountOf = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    const { data: profs } = await admin
      .from('profiles').select('id, full_name, stripe_account_id').in('id', slice);
    for (const p of (profs as { id: string; full_name: string | null; stripe_account_id: string | null }[]) ?? []) {
      nameOf.set(p.id, p.full_name ?? '');
      if (p.stripe_account_id) accountOf.set(p.id, p.stripe_account_id);
    }
  }

  const nome = (id: string | null) => (id ? (nameOf.get(id) || '⟨sem nome⟩') : '⟨sem motorista⟩');

  // ── Cada gorjeta, com o motivo de estar presa quando for o caso ───────────
  line();
  line(`GORJETAS REGISTRADAS: ${tips.length}`);
  line('─'.repeat(60));

  let totalPendente = 0;
  let totalRepassado = 0;
  const semPI: TipRow[] = [];
  const presas: TipRow[] = [];

  for (const t of tips) {
    const valor = Number(t.tip_amount ?? 0);
    const repassada = !!t.tip_payout_id;
    if (repassada) totalRepassado += valor;
    else totalPendente += valor;

    line(`gorjeta ........ ${money(valor)}`);
    line(`corrida ........ ${t.id}`);
    line(`passageiro ..... ${nome(t.passenger_id)}`);
    line(`motorista ...... ${nome(t.driver_id)}`);
    line(`concluída ...... ${t.completed_at ?? '—'}`);
    line(`corrida paga ... ${t.paid ? 'SIM' : 'NÃO'}`);
    line(`repassada ...... ${repassada ? `SIM (payout ${t.tip_payout_id})` : 'NÃO — pendente'}`);
    line(`lastro ......... ${t.tip_payment_intent_id ?? '⟨nenhum⟩ — sai do saldo da plataforma'}`);

    if (!repassada) {
      // As três condições de claimPendingTips, verificadas uma a uma.
      if (!t.paid) {
        line('⚠️  PRESA: corrida com paid=false. A tarifa precisa ser cobrada antes.');
        presas.push(t);
      } else if (!t.driver_id) {
        line('⚠️  PRESA: corrida sem motorista. Não há a quem repassar.');
        presas.push(t);
      } else if (!accountOf.has(t.driver_id)) {
        line('⚠️  PRESA: motorista sem conta Stripe Connect configurada.');
        presas.push(t);
      }
      if (!t.tip_payment_intent_id) semPI.push(t);
    }
    line('─'.repeat(60));
  }

  // ── Resumo ────────────────────────────────────────────────────────────────
  line();
  line('RESUMO');
  line('─'.repeat(60));
  line(`já repassado ao motorista ... ${money(totalRepassado)}`);
  line(`AINDA DEVIDO ao motorista ... ${money(totalPendente)}`);

  // Pendente por motorista — é isso que o app mostra como saldo de gorjeta.
  const porMotorista = new Map<string, number>();
  for (const t of tips) {
    if (t.tip_payout_id || !t.driver_id) continue;
    porMotorista.set(t.driver_id, (porMotorista.get(t.driver_id) ?? 0) + Number(t.tip_amount ?? 0));
  }
  if (porMotorista.size) {
    line();
    line('PENDENTE POR MOTORISTA');
    for (const [id, v] of porMotorista) line(`  • ${nome(id)} .... ${money(v)}`);
  }

  if (semPI.length) {
    line();
    line(`SEM LASTRO NO STRIPE: ${semPI.length} gorjeta(s), ${money(semPI.reduce((s, t) => s + Number(t.tip_amount ?? 0), 0))}`);
    line('Cobradas antes da 0064, quando o PaymentIntent da gorjeta não era');
    line('gravado. O repasse delas depende de saldo disponível na plataforma.');
  }

  if (presas.length) {
    line();
    line(`PRESAS POR OUTRO MOTIVO: ${presas.length} — ver os ⚠️ acima.`);
  }

  if (!semPI.length && !presas.length && totalPendente > 0) {
    line();
    line('Todas as pendentes estão prontas para repassar. ✅');
  }
}

main().catch((e) => {
  console.error('ERRO:', e?.message ?? e);
  Deno.exit(1);
});
