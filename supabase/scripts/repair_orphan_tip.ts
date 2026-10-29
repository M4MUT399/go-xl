// repair_orphan_tip.ts — devolve à gorjeta ÓRFÃ o lastro que ela nunca teve.
//
// ── O QUE É UMA GORJETA ÓRFÃ ────────────────────────────────────────────────
//
// Uma corrida com `tip_amount > 0` e `tip_payment_intent_id` NULO, quando existe
// no Stripe um PaymentIntent `succeeded` com `metadata.type = 'tip'` e
// `metadata.rideId` daquela corrida. O passageiro pagou, a cobrança está lá, e o
// banco não sabe qual cobrança é.
//
// Por que isso importa em dinheiro (ver `_shared/tipPayout.ts` e a migração
// 0064, que faz a gorjeta ir 100% ao motorista, fora do split):
//
//   COM o id  → o transfer é sacado da cobrança da PRÓPRIA gorjeta
//               (`source_transaction`). Não depende de saldo na plataforma.
//   SEM o id  → o transfer sai do saldo disponível da plataforma. Se não houver
//               saldo, o Stripe recusa e a gorjeta volta para a fila — nunca se
//               perde, mas também nunca é paga sozinha.
//
// ── O CASO CONHECIDO ────────────────────────────────────────────────────────
//
// Corrida `6acaf884-9e16-43a9-9ae9-5845cc7364d9`, 17/08/2026:
// `tip_amount = 10`, `tip_payment_intent_id = NULL`, e no Stripe o
// `pi_3U5PGQCgSu88OSlV1dhyGTtQ` — $10,00, `succeeded`, metadata batendo. Foi
// cobrada pela versão da `tip-ride` de então (commit 1c57718), que gravava só o
// valor; o id só passou a ser gravado em ea57da5.
//
// Este script NÃO cobra ninguém e NÃO cria PaymentIntent. Ele só escreve, no
// banco, o id de uma cobrança que JÁ EXISTE no Stripe — e só depois de conferir,
// no próprio Stripe, que ela existe, que está `succeeded`, que a metadata aponta
// para esta corrida e que o valor bate com o `tip_amount` gravado.
//
// ── USO (VOCÊ roda, no Terminal, dentro de /Users/mamute99/go-xl) ───────────
//
// 1) Ensaio — não escreve nada, só mostra o que faria:
//
//   deno run --allow-env --allow-net --allow-read --node-modules-dir=auto supabase/scripts/repair_orphan_tip.ts
//
// 2) Aplicar de verdade:
//
//   deno run --allow-env --allow-net --allow-read --node-modules-dir=auto supabase/scripts/repair_orphan_tip.ts --aplicar
//
// O ensaio é o PADRÃO de propósito: rodar sem querer não muda nada.

import Stripe from 'npm:stripe@17';
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { load } from 'jsr:@std/dotenv';

try {
  await load({ envPath: new URL('./.env', import.meta.url).pathname, export: true });
} catch {
  // .env ausente ou malformado — segue com o que estiver no ambiente
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const STRIPE_KEY = Deno.env.get('STRIPE_SECRET_KEY') ?? '';

if (!SUPABASE_URL || !SERVICE_KEY || !STRIPE_KEY) {
  console.error('Faltam SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY ou STRIPE_SECRET_KEY em supabase/scripts/.env');
  Deno.exit(1);
}

const APLICAR = Deno.args.includes('--aplicar');
// Um id de corrida solto na linha de comando limita a varredura a ela. Sem id,
// varre todas as órfãs.
const SO_ESTA = Deno.args.find((a) => !a.startsWith('--')) ?? null;
const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const stripe = new Stripe(STRIPE_KEY, { apiVersion: '2025-01-27.acacia' });

const line = (s = '') => console.log(s);
const money = (c: number) => `$${(c / 100).toFixed(2)}`;

interface RideRow {
  id: string;
  passenger_id: string;
  driver_id: string | null;
  completed_at: string | null;
  tip_amount: number | null;
  tip_payment_intent_id: string | null;
  tip_payout_id: string | null;
  paid: boolean | null;
}

// ── 1. Quem são as órfãs candidatas ────────────────────────────────────────
let consulta = sb
  .from('rides')
  .select('id, passenger_id, driver_id, completed_at, tip_amount, tip_payment_intent_id, tip_payout_id, paid')
  .gt('tip_amount', 0)
  .is('tip_payment_intent_id', null);
if (SO_ESTA) consulta = consulta.eq('id', SO_ESTA);
const { data: candidatas, error: erroBusca } = await consulta.order('completed_at', { ascending: false });

if (erroBusca) {
  console.error('Falha ao ler as corridas:', erroBusca.message);
  Deno.exit(1);
}

const orfas = (candidatas ?? []) as RideRow[];
line(`Corridas com gorjeta gravada e SEM lastro no banco: ${orfas.length}`);
line(APLICAR ? 'Modo: APLICAR (vai escrever)' : 'Modo: ENSAIO (não escreve nada)');
line();

if (orfas.length === 0) Deno.exit(0);

// ── 2. Para cada uma, procurar a cobrança REAL no Stripe ───────────────────
//
// A busca é pelos PaymentIntents DO CLIENTE daquela corrida, e não uma varredura
// da conta inteira: é o mesmo caminho que a `tip-ride` corrigida usa, então o
// que este script repara é exatamente o que ela repararia sozinha se o
// passageiro tocasse em gorjeta de novo — coisa que ele não vai fazer.

let reparadas = 0;
let semCobranca = 0;

for (const r of orfas) {
  const { data: perfil } = await sb
    .from('profiles')
    .select('stripe_customer_id, full_name')
    .eq('id', r.passenger_id)
    .single();
  const p = perfil as { stripe_customer_id?: string; full_name?: string } | null;

  const quando = (r.completed_at ?? '').slice(0, 10);
  const rotulo = `${quando}  ${r.id}  tip ${money(Math.round((r.tip_amount ?? 0) * 100))}  ${p?.full_name ?? '?'}`;

  if (!p?.stripe_customer_id) {
    line(`⏭  ${rotulo} — passageiro sem stripe_customer_id, não há onde procurar`);
    semCobranca++;
    continue;
  }

  // Cliente que não existe mais nesta conta Stripe é comum nas linhas antigas
  // (ids de modo de teste sob a chave de produção — AUDITORIA, item F). Isso
  // NÃO pode derrubar a varredura e deixar as órfãs seguintes sem conferir.
  let cobranca: Stripe.PaymentIntent | undefined;
  try {
    const lista = await stripe.paymentIntents.list({ customer: p.stripe_customer_id, limit: 100 });
    cobranca = lista.data.find(
      (pi) => pi.status === 'succeeded' && pi.metadata?.type === 'tip' && pi.metadata?.rideId === r.id,
    );
  } catch (e) {
    const msg = (e as { raw?: { message?: string }; message?: string })?.raw?.message
      ?? (e as { message?: string })?.message ?? String(e);
    line(`⏭  ${rotulo} — não deu para consultar o Stripe (${msg}). NÃO tocado.`);
    semCobranca++;
    continue;
  }

  if (!cobranca) {
    // É o caso das 84 linhas legadas: `tip_amount` gravado sem cobrança
    // nenhuma por trás (anteriores ao guard de dinheiro da 0065). Não há o que
    // reparar — e inventar uma cobrança aqui seria cobrar alguém sem pedido.
    line(`⏭  ${rotulo} — nenhuma cobrança de gorjeta no Stripe. Nada a reparar.`);
    semCobranca++;
    continue;
  }

  // ── 3. Conferências ANTES de escrever ────────────────────────────────────
  // O valor do banco e o do Stripe precisam bater. Se divergirem, a linha não é
  // uma órfã simples — é outra história, e escrever por cima esconderia ela.
  const centavosBanco = Math.round((r.tip_amount ?? 0) * 100);
  if (cobranca.amount !== centavosBanco) {
    line(`⚠️  ${rotulo} — DIVERGE: banco ${money(centavosBanco)} × Stripe ${money(cobranca.amount)} (${cobranca.id}). NÃO tocado.`);
    continue;
  }

  if (r.tip_payout_id) {
    // Já repassada sem o lastro (saiu do saldo da plataforma). Gravar o id agora
    // não desfaz nem duplica o transfer — `claimPendingTips` filtra por
    // `tip_payout_id` nulo —, mas fica o registro correto de qual cobrança era.
    line(`ℹ️  ${rotulo} — já repassada (payout ${r.tip_payout_id}); grava só o lastro histórico.`);
  }

  line(`✅ ${rotulo}`);
  line(`   → tip_payment_intent_id = ${cobranca.id}  (${money(cobranca.amount)}, ${cobranca.status})`);
  line(`   → motorista: ${r.driver_id ?? 'SEM MOTORISTA'}`);

  if (!APLICAR) {
    line('   (ensaio — nada foi escrito)');
    line();
    continue;
  }

  // Só o lastro. `tip_amount` NÃO é reescrito: ele já está certo, e mexer nele
  // sem necessidade é mexer em dinheiro sem necessidade.
  const { error: erroEscrita } = await sb
    .from('rides')
    .update({ tip_payment_intent_id: cobranca.id })
    .eq('id', r.id)
    .is('tip_payment_intent_id', null); // condicional: não sobrescreve o que já tem lastro

  if (erroEscrita) {
    line(`   ❌ falhou ao gravar: ${erroEscrita.message}`);
  } else {
    line('   ✔ gravado.');
    reparadas++;
  }
  line();
}

line();
line(`Resumo: ${reparadas} reparada(s), ${semCobranca} sem cobrança correspondente, de ${orfas.length} candidata(s).`);
if (!APLICAR) line('Nada foi escrito. Rode de novo com --aplicar para valer.');
