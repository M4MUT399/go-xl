// clean_phantom_fares.ts — tira da fila de repasse as TARIFAS que nunca foram
// cobradas nesta conta Stripe.
//
// ── O QUE É UMA TARIFA FANTASMA ────────────────────────────────────────────
//
// Uma corrida com `paid = true` cujo `stripe_payment_intent_id` NÃO EXISTE na
// conta Stripe de produção. O banco afirma que o dinheiro entrou; o Stripe não
// conhece aquela cobrança. Levantado em 06/09/2026: de 127 corridas com
// `paid = true` somando US$ 9.939,46, apenas 10 (US$ 350,67) têm PaymentIntent
// que existe aqui. As outras 117 (US$ 9.588,79) apontam para fora.
//
// Isso não é fraude nem defeito: é o período de TESTE. As datas se concentram
// em julho/2026 e o PaymentIntent mais antigo desta conta é de 16/07, de US$
// 1,00. O app foi exercitado com chave de teste e depois entrou em produção; os
// dois períodos moram no mesmo banco.
//
// ── POR QUE ISTO É URGENTE ─────────────────────────────────────────────────
//
// `run-weekly-payouts` seleciona por `paid = true`, `payout_id` nulo,
// `driver_id` e `driver_amount` não nulos — e não pergunta ao Stripe se aquele
// dinheiro existiu. Medido no `dry_run` de 06/09: das corridas na fila,
// 23 são fantasmas e valem US$ 1.494,36 de `driver_amount`, contra US$ 292,11
// lastreados. Ou seja, 83% do repasse de segunda sairia do bolso da plataforma
// por corrida de teste. Todas as 23 têm "Edson Luiz" como passageiro e
// motoristas de teste; há tarifas de US$ 537,01 e US$ 213,65 entre elas.
//
// É o mesmo problema das gorjetas fantasma (`clean_phantom_tips.ts`), 1,7×
// maior. E, como lá, o que segura tudo hoje é um acidente: o cron leva 401
// porque o Vault guarda a chave antiga. Trocar aquele segredo sem limpar isto
// antes libera o repasse.
//
// ── O QUE ESTE SCRIPT FAZ ──────────────────────────────────────────────────
//
// Grava `paid = false` nas corridas cuja cobrança não existe. Isso é a coisa
// HONESTA, não um truque para escapar da consulta: `paid = true` é justamente a
// afirmação falsa. O efeito colateral é o desejado em três lugares de uma vez —
// sai da fila de repasse, sai da soma de faturamento e o banco passa a dizer a
// verdade sobre aquela corrida.
//
// NADA é apagado: `price`, `driver_amount`, `driver_id` e o próprio
// `stripe_payment_intent_id` continuam na linha. O histórico fica; o que muda é
// a afirmação de que o dinheiro entrou.
//
// ── O QUE ELE SE RECUSA A FAZER ────────────────────────────────────────────
//
//   • não toca em corrida cuja cobrança EXISTE e foi liquidada;
//   • não toca em corrida JÁ REPASSADA (`payout_id` preenchido) — ali o
//     dinheiro do motorista já saiu de verdade, e reescrever `paid` depois do
//     transfer é reescrever a história de uma transferência real. Essas são
//     listadas para decisão humana e nada mais;
//   • CONFERE NO STRIPE no momento da escrita, varrendo a conta inteira, e
//     ABORTA se a varredura não terminar — "não terminei de procurar" e "não
//     existe" são coisas diferentes.
//
// ── USO (VOCÊ roda, no Terminal, dentro de /Users/mamute99/go-xl) ──────────
//
//   ensaio:   deno run --allow-env --allow-net --allow-read --node-modules-dir=none supabase/scripts/clean_phantom_fares.ts
//   aplicar:  deno run --allow-env --allow-net --allow-read --node-modules-dir=none supabase/scripts/clean_phantom_fares.ts --aplicar
//
// DEPOIS DE APLICAR: a `sweep-unpaid-completed` vai enxergar essas corridas como
// "concluída, não paga, COM PaymentIntent" e registrar cada uma em
// `stripe_reconciliation` com `needs_attention` — de propósito, é o veredito
// certo dela (nunca cria segunda cobrança em cima de intent existente). São
// linhas de aviso já explicadas, uma por corrida, e podem ser resolvidas em
// bloco marcando `resolved_at` nelas.

import Stripe from 'npm:stripe@17';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { load } from 'jsr:@std/dotenv';

try {
  await load({ envPath: new URL('./.env', import.meta.url).pathname, export: true });
} catch { /* .env ausente — segue com o ambiente */ }

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const STRIPE_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';

if (!SUPABASE_URL || !SERVICE_KEY || !STRIPE_KEY) {
  console.error('Faltam SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY ou STRIPE_SECRET_KEY em supabase/scripts/.env');
  Deno.exit(1);
}

const APLICAR = Deno.args.includes('--aplicar');
const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const stripe = new Stripe(STRIPE_KEY, { apiVersion: '2025-01-27.acacia' });

const line = (s = '') => console.log(s);
const fmt = (n: number) => `US$ ${n.toFixed(2)}`;

interface RideRow {
  id: string;
  status: string | null;
  price: number | null;
  driver_id: string | null;
  driver_amount: number | null;
  payout_id: string | null;
  passenger_id: string;
  completed_at: string | null;
  created_at: string | null;
  stripe_payment_intent_id: string | null;
}

// ── 1. A conta Stripe inteira, uma vez ─────────────────────────────────────
const TETO_PAGINAS = 100;
const liquidadas = new Set<string>();
let paginas = 0;
let after: string | undefined;
let exauriu = false;

while (paginas < TETO_PAGINAS) {
  const p = await stripe.paymentIntents.list({
    limit: 100,
    expand: ['data.latest_charge'],
    ...(after ? { starting_after: after } : {}),
  });
  paginas += 1;
  for (const pi of p.data) {
    const ch = pi.latest_charge as { amount_refunded?: number | null } | null;
    const cobrado =
      pi.status === 'succeeded' &&
      (ch?.amount_refunded ?? 0) === 0 &&
      (pi.amount_received ?? 0) >= pi.amount;
    if (cobrado) liquidadas.add(pi.id);
  }
  if (!p.has_more) { exauriu = true; break; }
  after = p.data[p.data.length - 1].id;
}

if (!exauriu) {
  console.error(
    `A varredura do Stripe parou no teto de ${TETO_PAGINAS} páginas sem terminar. NADA foi escrito: ` +
    'sem a lista completa de cobranças, não dá para afirmar que uma tarifa não tem lastro.',
  );
  Deno.exit(1);
}
line(`Conferência no Stripe: ${paginas} página(s), ${liquidadas.size} cobrança(s) liquidada(s) na conta.`);
line();

// ── 2. Candidatas ──────────────────────────────────────────────────────────
const { data, error } = await sb
  .from('rides')
  .select('id, status, price, driver_id, driver_amount, payout_id, passenger_id, completed_at, created_at, stripe_payment_intent_id')
  .eq('paid', true);

if (error) {
  console.error('Falha ao ler as corridas:', error.message);
  Deno.exit(1);
}

const pagas = (data ?? []) as RideRow[];
const semLastro = pagas.filter((r) => !r.stripe_payment_intent_id || !liquidadas.has(r.stripe_payment_intent_id));
const jaRepassadas = semLastro.filter((r) => r.payout_id);
const limpar = semLastro.filter((r) => !r.payout_id);

const nomes = new Map<string, string>();
const ids = [...new Set(semLastro.flatMap((r) => [r.passenger_id, r.driver_id].filter(Boolean) as string[]))];
if (ids.length) {
  const { data: profs } = await sb.from('profiles').select('id, full_name').in('id', ids);
  for (const p of ((profs ?? []) as { id: string; full_name: string | null }[])) nomes.set(p.id, p.full_name ?? p.id);
}

const soma = (l: RideRow[], c: 'price' | 'driver_amount') => l.reduce((s, r) => s + (Number(r[c]) || 0), 0);

line(`Corridas com paid = true: ${pagas.length}  (${fmt(soma(pagas, 'price'))} em tarifa)`);
line(`  com lastro no Stripe ....... ${pagas.length - semLastro.length}`);
line(`  SEM lastro ................. ${semLastro.length}  (${fmt(soma(semLastro, 'price'))})`);
line(APLICAR ? '\nModo: APLICAR (vai escrever)' : '\nModo: ENSAIO (não escreve nada)');
line();

if (jaRepassadas.length > 0) {
  line(`⚠️  ${jaRepassadas.length} corrida(s) sem lastro JÁ FORAM REPASSADAS — NÃO serão tocadas.`);
  line('    O dinheiro do motorista já saiu; reescrever `paid` depois do transfer é reescrever');
  line('    a história de uma transferência real. Decisão humana, com o Stripe na mão.');
  for (const r of jaRepassadas) {
    line(`      ${(r.completed_at ?? r.created_at ?? '').slice(0, 10)}  ${r.id}  ${fmt(Number(r.price) || 0)}  motorista: ${nomes.get(r.driver_id ?? '') ?? r.driver_id}`);
  }
  line();
}

const naFila = limpar.filter((r) => r.driver_id && r.driver_amount != null);
line(`A MARCAR COMO NÃO PAGA: ${limpar.length} corrida(s), ${fmt(soma(limpar, 'price'))} de tarifa.`);
line(`   dessas, na fila do repasse: ${naFila.length} corrida(s), ${fmt(soma(naFila, 'driver_amount'))} de driver_amount`);
line();

const porMotorista = new Map<string, { n: number; total: number }>();
for (const r of naFila) {
  const k = r.driver_id ?? '(sem motorista)';
  const a = porMotorista.get(k) ?? { n: 0, total: 0 };
  a.n += 1; a.total += Number(r.driver_amount) || 0;
  porMotorista.set(k, a);
}
line('   deixaria de ser repassado, por motorista:');
for (const [id, v] of [...porMotorista.entries()].sort((a, b) => b[1].total - a[1].total)) {
  line(`     ${(nomes.get(id) ?? id).padEnd(22)} ${String(v.n).padStart(3)} corrida(s)  ${fmt(v.total)}`);
}
const porPassageiro = new Map<string, number>();
for (const r of limpar) porPassageiro.set(r.passenger_id, (porPassageiro.get(r.passenger_id) ?? 0) + 1);
line('   passageiros envolvidos:');
for (const [id, n] of [...porPassageiro.entries()].sort((a, b) => b[1] - a[1])) {
  line(`     ${(nomes.get(id) ?? id).padEnd(30)} ${n} corrida(s)`);
}
line();

if (limpar.length === 0) Deno.exit(0);

if (!APLICAR) {
  line('ENSAIO — nada foi escrito. Rode de novo com --aplicar para valer.');
  Deno.exit(0);
}

// ── 3. Escrita ─────────────────────────────────────────────────────────────
// O desfazer vem ANTES. Se a auditoria não gravar, nada é alterado.
const antes = limpar.map((r) => ({
  ride_id: r.id,
  price: Number(r.price) || 0,
  driver_amount: Number(r.driver_amount) || 0,
  driver_id: r.driver_id,
  passenger_id: r.passenger_id,
  stripe_payment_intent_id: r.stripe_payment_intent_id,
  completed_at: r.completed_at,
  status: r.status,
}));

const { error: erroAuditoria } = await sb.from('stripe_reconciliation').upsert({
  event_id: `phantom_fares_cleanup_${new Date().toISOString().slice(0, 19)}`,
  event_type: 'charge.phantom.cleanup',
  object_id: 'clean_phantom_fares',
  amount_cents: Math.round(soma(limpar, 'price') * 100),
  currency: 'usd',
  needs_attention: false,
  reason:
    `Limpeza de tarifas fantasma: ${limpar.length} corrida(s), ${fmt(soma(limpar, 'price'))} marcadas como ` +
    'paid = false porque o stripe_payment_intent_id delas NÃO EXISTE nesta conta Stripe (conferido ' +
    'varrendo a conta inteira antes de escrever). São corridas do período de teste de julho/2026. ' +
    `Tira ${fmt(soma(naFila, 'driver_amount'))} de driver_amount da fila do repasse semanal. Nada foi ` +
    'apagado: price, driver_amount e o proprio payment_intent seguem na linha. raw.antes tem o desfazer.',
  raw: { source: 'clean_phantom_fares', antes },
}, { onConflict: 'event_id' });

if (erroAuditoria) {
  console.error('Falha ao gravar a auditoria — NADA foi alterado:', erroAuditoria.message);
  Deno.exit(1);
}
line('✔ auditoria gravada em stripe_reconciliation (raw.antes tem o desfazer).');

let alteradas = 0;
for (const r of limpar) {
  // Condicional nas MESMAS colunas que qualificaram a linha: se ela foi
  // repassada ou re-cobrada no meio do caminho, quem ganha é a outra escrita.
  const { data: ok, error: erroUpdate } = await sb
    .from('rides')
    .update({ paid: false })
    .eq('id', r.id)
    .eq('paid', true)
    .is('payout_id', null)
    .select('id');

  if (erroUpdate) line(`   ❌ ${r.id}: ${erroUpdate.message}`);
  else if ((ok?.length ?? 0) === 0) line(`   ⏭  ${r.id}: mudou de estado no meio do caminho — deixada como está.`);
  else alteradas += 1;
}

line();
line(`Resumo: ${alteradas} de ${limpar.length} corrida(s) marcadas como não pagas.`);
line(`${fmt(soma(naFila, 'driver_amount'))} fora da fila do repasse semanal.`);
line('Confira o efeito com o dry_run do repasse antes de mexer no Vault.');
