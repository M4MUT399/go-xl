// clean_phantom_tips.ts — tira da fila de repasse as gorjetas que NUNCA foram
// cobradas de ninguém.
//
// ── O QUE É UMA GORJETA FANTASMA ────────────────────────────────────────────
//
// Uma corrida com `tip_amount > 0`, `tip_payment_intent_id` NULO e NENHUM
// PaymentIntent de gorjeta correspondente no Stripe. O valor foi gravado direto
// na linha — as 83 corridas de teste de julho/2026, anteriores ao guard de
// dinheiro da 0065, que só então passou a impedir o cliente de escrever nas
// colunas de dinheiro.
//
// Não confundir com a gorjeta ÓRFÃ, que é o contrário: lá a cobrança EXISTE no
// Stripe e é o banco que não sabe qual é. Órfã se conserta gravando o lastro
// (`repair_orphan_tip.ts`); fantasma se conserta apagando o valor, porque não há
// lastro nenhum para gravar.
//
// ── POR QUE ISTO É URGENTE, E NÃO ARRUMAÇÃO ────────────────────────────────
//
// `_shared/tipPayout.ts → claimPendingTips` paga TODA gorjeta com
// `tip_amount > 0`, `paid = true` e `tip_payout_id` nulo. Sem
// `tip_payment_intent_id` não há `source_transaction`, então o transfer sai do
// SALDO DA PLATAFORMA. Medido em 06/09/2026: US$ 885 em 83 corridas, na fila do
// repasse semanal (segunda, 17:00 UTC). É dinheiro saindo para motorista por
// gorjeta que passageiro nenhum pagou.
//
// Hoje o que segura isso é um acidente: o cron leva 401 porque o Vault guarda a
// chave antiga. No instante em que esse segredo for atualizado, o repasse roda —
// e leva os US$ 885 junto. Por isso a limpeza vem ANTES da troca da chave.
//
// ── O QUE ESTE SCRIPT FAZ, E O QUE ELE SE RECUSA A FAZER ───────────────────
//
// Faz: apaga `tip_amount` (vira NULL) das corridas em que ele não representa
// dinheiro nenhum, e grava em `stripe_reconciliation` a lista completa do que
// apagou, com o valor anterior de cada linha — o desfazer existe.
//
// NÃO faz: não toca em corrida que tenha `tip_payment_intent_id`, não toca em
// corrida já repassada (`tip_payout_id`), e — o mais importante — CONFERE NO
// STRIPE, corrida por corrida e no momento da escrita, que não existe cobrança
// de gorjeta ali. Se existir, ele PARA naquela linha e manda usar o
// `repair_orphan_tip.ts`. Não confia num levantamento anterior: entre o
// levantamento e a escrita cabe uma gorjeta nova.
//
// ── USO (VOCÊ roda, no Terminal, dentro de /Users/mamute99/go-xl) ──────────
//
// 1) Ensaio — não escreve nada, lista tudo o que faria:
//
//   deno run --allow-env --allow-net --allow-read --node-modules-dir=none supabase/scripts/clean_phantom_tips.ts
//
// 2) Aplicar de verdade:
//
//   deno run --allow-env --allow-net --allow-read --node-modules-dir=none supabase/scripts/clean_phantom_tips.ts --aplicar
//
// Aceita `--passageiro <uuid>` para limitar a limpeza às corridas de um
// passageiro só (ex.: a sua conta de teste). O ensaio é o PADRÃO de propósito.

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
const iPax = Deno.args.indexOf('--passageiro');
const SO_PASSAGEIRO = iPax >= 0 ? Deno.args[iPax + 1] ?? null : null;

const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const stripe = new Stripe(STRIPE_KEY, { apiVersion: '2025-01-27.acacia' });

const line = (s = '') => console.log(s);
const money = (n: number) => `$${n.toFixed(2)}`;

interface RideRow {
  id: string;
  passenger_id: string;
  driver_id: string | null;
  completed_at: string | null;
  tip_amount: number | null;
  paid: boolean | null;
}

// ── 1. Candidatas: gorjeta gravada, sem lastro e ainda não repassada ────────
let consulta = sb
  .from('rides')
  .select('id, passenger_id, driver_id, completed_at, tip_amount, paid')
  .gt('tip_amount', 0)
  .is('tip_payment_intent_id', null)
  .is('tip_payout_id', null);
if (SO_PASSAGEIRO) consulta = consulta.eq('passenger_id', SO_PASSAGEIRO);

const { data, error } = await consulta.order('completed_at', { ascending: true });
if (error) {
  console.error('Falha ao ler as corridas:', error.message);
  Deno.exit(1);
}

const candidatas = (data ?? []) as RideRow[];
line(`Gorjetas gravadas, sem lastro e ainda não repassadas: ${candidatas.length}`);
line(APLICAR ? 'Modo: APLICAR (vai escrever)' : 'Modo: ENSAIO (não escreve nada)');
if (SO_PASSAGEIRO) line(`Limitado ao passageiro ${SO_PASSAGEIRO}`);
line();

if (candidatas.length === 0) Deno.exit(0);

// Nomes, só para o relatório ser legível por gente.
const paxIds = [...new Set(candidatas.map((r) => r.passenger_id))];
const { data: perfis } = await sb.from('profiles').select('id, full_name, stripe_customer_id').in('id', paxIds);
const perfilPor = new Map(
  ((perfis ?? []) as { id: string; full_name: string | null; stripe_customer_id: string | null }[])
    .map((p) => [p.id, p]),
);

// ── 2. Conferência no Stripe ───────────────────────────────────────────────
//
// A pergunta é "existe cobrança de gorjeta para ESTA corrida?", e a resposta
// autoritativa é a CONTA inteira, não o cliente. A primeira versão deste script
// procurava por `customer`, e 12 corridas ficaram sem conferir porque o
// `stripe_customer_id` delas aponta para um cliente que não existe mais nesta
// conta (ids de modo de teste sob a chave de produção — AUDITORIA, item F). Ao
// varrer a conta, o cliente deixa de importar: o vínculo com a corrida é o
// `metadata.rideId`, que está no PaymentIntent e não no cliente.
//
// A varredura é EXAUSTIVA de propósito. Se a paginação estourar o teto sem
// terminar, o script ABORTA em vez de concluir "não achei" — "não terminei de
// procurar" e "não existe" são coisas diferentes, e confundir as duas aqui
// apagaria dinheiro que tem lastro.
const TETO_PAGINAS = 100;
const cobradasPorCorrida = new Map<string, string>(); // rideId -> paymentIntentId
let paginas = 0;
let starting_after: string | undefined;
let exauriu = false;

while (paginas < TETO_PAGINAS) {
  const pagina = await stripe.paymentIntents.list({
    limit: 100,
    ...(starting_after ? { starting_after } : {}),
  });
  paginas += 1;
  for (const pi of pagina.data) {
    if (pi.status !== 'succeeded') continue;
    if (pi.metadata?.type !== 'tip') continue;
    const rideId = pi.metadata?.rideId;
    if (rideId) cobradasPorCorrida.set(rideId, pi.id);
  }
  if (!pagina.has_more) { exauriu = true; break; }
  starting_after = pagina.data[pagina.data.length - 1].id;
}

if (!exauriu) {
  console.error(
    `A varredura do Stripe parou no teto de ${TETO_PAGINAS} páginas sem terminar. ` +
    'NADA foi apagado: sem a lista completa de cobranças, não dá para afirmar que uma gorjeta ' +
    'não tem lastro. Aumente o teto e rode de novo.',
  );
  Deno.exit(1);
}

line(`Conferência no Stripe: ${paginas} página(s) varridas, ${cobradasPorCorrida.size} gorjeta(s) COBRADA(S) na conta.`);
line();

const limpar: RideRow[] = [];
const temCobranca: { r: RideRow; pi: string }[] = [];

for (const r of candidatas) {
  const pi = cobradasPorCorrida.get(r.id);
  if (pi) temCobranca.push({ r, pi });
  else limpar.push(r);
}

// ── 3. Relatório ───────────────────────────────────────────────────────────
const totalLimpar = limpar.reduce((s, r) => s + (Number(r.tip_amount) || 0), 0);

if (temCobranca.length > 0) {
  line('⚠️  TÊM COBRANÇA NO STRIPE — não são fantasmas, são ÓRFÃS. NÃO serão tocadas.');
  line('    Rode supabase/scripts/repair_orphan_tip.ts nelas.');
  for (const { r, pi } of temCobranca) {
    line(`    ${(r.completed_at ?? '').slice(0, 10)}  ${r.id}  ${money(Number(r.tip_amount) || 0)}  → ${pi}`);
  }
  line();
}

line(`A LIMPAR: ${limpar.length} corrida(s), ${money(totalLimpar)} em gorjeta sem cobrança nenhuma por trás.`);
const porPassageiro = new Map<string, { n: number; total: number }>();
for (const r of limpar) {
  const atual = porPassageiro.get(r.passenger_id) ?? { n: 0, total: 0 };
  atual.n += 1;
  atual.total += Number(r.tip_amount) || 0;
  porPassageiro.set(r.passenger_id, atual);
}
for (const [id, v] of porPassageiro) {
  line(`   passageiro ${perfilPor.get(id)?.full_name ?? id}: ${v.n} corrida(s), ${money(v.total)}`);
}
const porMotorista = new Map<string, { n: number; total: number }>();
for (const r of limpar) {
  const k = r.driver_id ?? '(sem motorista)';
  const atual = porMotorista.get(k) ?? { n: 0, total: 0 };
  atual.n += 1;
  atual.total += Number(r.tip_amount) || 0;
  porMotorista.set(k, atual);
}
line('   deixaria de ser repassado, por motorista:');
for (const [id, v] of [...porMotorista.entries()].sort((a, b) => b[1].total - a[1].total)) {
  line(`     ${id}: ${v.n} corrida(s), ${money(v.total)}`);
}
line();

if (!APLICAR) {
  line('ENSAIO — nada foi escrito. Rode de novo com --aplicar para valer.');
  Deno.exit(0);
}

// ── 4. Escrita ─────────────────────────────────────────────────────────────
// O desfazer vem ANTES do apagar. Se a auditoria não gravar, não apagamos nada:
// apagar dinheiro sem deixar como reconstituí-lo não é limpeza, é perda.
const antes = limpar.map((r) => ({
  ride_id: r.id,
  tip_amount: Number(r.tip_amount) || 0,
  driver_id: r.driver_id,
  passenger_id: r.passenger_id,
  completed_at: r.completed_at,
}));

const { error: erroAuditoria } = await sb.from('stripe_reconciliation').upsert({
  event_id: `phantom_tips_cleanup_${new Date().toISOString().slice(0, 19)}`,
  event_type: 'tip.phantom.cleanup',
  object_id: 'clean_phantom_tips',
  amount_cents: Math.round(totalLimpar * 100),
  currency: 'usd',
  needs_attention: false,
  reason:
    `Limpeza de gorjetas fantasma: ${limpar.length} corrida(s), ${money(totalLimpar)} em tip_amount ` +
    'gravado SEM cobrança correspondente no Stripe (conferido corrida por corrida antes de apagar). ' +
    'O campo tip_amount foi zerado para tirá-las da fila de claimPendingTips, que as pagaria com ' +
    'saldo da plataforma. O valor anterior de cada linha está em raw.antes — é por ali que se desfaz.',
  raw: { source: 'clean_phantom_tips', antes },
}, { onConflict: 'event_id' });

if (erroAuditoria) {
  console.error('Falha ao gravar a auditoria — NADA foi apagado:', erroAuditoria.message);
  Deno.exit(1);
}
line('✔ auditoria gravada em stripe_reconciliation (raw.antes tem o desfazer).');

let apagadas = 0;
for (const r of limpar) {
  // Condicional nas MESMAS colunas que qualificaram a linha: se, entre o
  // levantamento e agora, a gorjeta ganhou lastro ou entrou num repasse, quem
  // ganha é essa escrita, não esta.
  const { data: ok, error: erroUpdate } = await sb
    .from('rides')
    .update({ tip_amount: null })
    .eq('id', r.id)
    .is('tip_payment_intent_id', null)
    .is('tip_payout_id', null)
    .select('id');

  if (erroUpdate) {
    line(`   ❌ ${r.id}: ${erroUpdate.message}`);
  } else if ((ok?.length ?? 0) === 0) {
    line(`   ⏭  ${r.id}: mudou de estado no meio do caminho — deixada como está.`);
  } else {
    apagadas += 1;
  }
}

line();
line(`Resumo: ${apagadas} de ${limpar.length} corrida(s) limpas, ${money(totalLimpar)} fora da fila de repasse.`);
line('Confira com: deno run --allow-env --allow-net --allow-read --node-modules-dir=none supabase/scripts/tip_status.ts');
