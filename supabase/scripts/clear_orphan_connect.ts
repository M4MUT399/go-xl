// clear_orphan_connect.ts — desvincula as contas Connect que esta plataforma
// Stripe não alcança mais, para que o motorista possa refazer o onboarding.
//
// ── O QUE É UMA CONTA CONNECT ÓRFÃ ─────────────────────────────────────────
//
// Um `profiles.stripe_account_id` que a chave da plataforma ATUAL não consegue
// ler. A Stripe responde "does not have access to account (or that account does
// not exist). Application access may have been revoked" — a conta existe, mas
// pertence a OUTRA plataforma.
//
// Medido em 05/10/2026, no repasse semanal que rodou às 17:00 com a chave
// `sk_live_` completa (não restrita, portanto sem ambiguidade de permissão):
// Fabricio (`acct_1TqYc6…`) e Interplace Moto (`acct_1TrGex…`) falharam assim,
// deixando US$ 556,14 parados.
//
// A CAUSA. Existiram duas contas Stripe neste projeto, e os identificadores
// provam: a plataforma atual é `acct_1TcCkyCgSu88OSlV`, e todo objeto dela
// termina em `CgSu88OSlV` (ex.: `pi_3UCOkyCgSu88OSlV1kJqXlzz`). Já os objetos
// de julho terminam em `CwnzXWd7Ba` (`pi_3TsmDVCwnzXWd7Ba…`,
// `tr_3TsnipCwnzXWd7Ba…`) — outra conta. Os motoristas fizeram o Connect sob a
// plataforma antiga; na migração, os vínculos não vieram junto, e não têm como
// vir: um `acct_` só é acessível por quem o criou.
//
// ── POR QUE LIMPAR A COLUNA É O QUE DESTRAVA ───────────────────────────────
//
// `connect-onboard-driver` faz `let accountId = p?.stripe_account_id ?? ''` e só
// cria conta nova quando está VAZIO. Com o id órfão gravado, o motorista roda o
// fluxo inteiro de onboarding e sai dele exatamente como entrou — reaproveitando
// a conta inservível. Zerar a coluna é a única coisa que faz o fluxo funcionar.
//
// ── O QUE ESTE SCRIPT NÃO TOCA, E POR QUÊ ──────────────────────────────────
//
//   • `stripe_charges_enabled` / `stripe_payouts_enabled` ficam COMO ESTÃO. É
//     tentador zerá-las junto — elas afirmam uma capacidade que não existe mais
//     —, mas o gate da migração 0038 decide quem pode FICAR ONLINE justamente
//     por esse par. Limpá-las tiraria todos os motoristas do ar, parando a
//     operação para consertar um repasse. O estrago seria maior que o defeito.
//   • Nenhuma corrida é alterada. Com `stripe_account_id` nulo o motorista é
//     PULADO pelo run-weekly-payouts (ele filtra `not is null`), então o dinheiro
//     continua na fila, intacto, até o novo onboarding.
//
// ── A TRAVA QUE IMPORTA ────────────────────────────────────────────────────
//
// Antes de qualquer coisa o script confere se a chave consegue DISTINGUIR "não é
// minha" de "não tenho permissão de ler". São erros diferentes e foi fácil
// confundi-los: numa primeira investigação as nove contas "pareceram" órfãs com
// a chave restrita, que simplesmente não tinha `connected_account_read`. Se a
// chave não puder listar contas, o script ABORTA — apagar vínculo de pagamento
// com base num erro ambíguo é exatamente o que não se faz.
//
// ── USO (VOCÊ roda, dentro de /Users/mamute99/go-xl) ───────────────────────
//
//   ensaio:   deno run --allow-env --allow-net --allow-read --node-modules-dir=none supabase/scripts/clear_orphan_connect.ts
//   aplicar:  deno run --allow-env --allow-net --allow-read --node-modules-dir=none supabase/scripts/clear_orphan_connect.ts --aplicar
//
// Aceita `--motorista <uuid>` para tratar um só.

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
const iUm = Deno.args.indexOf('--motorista');
const SO_ESTE = iUm >= 0 ? Deno.args[iUm + 1] : null;

const sb = createClient(SUPABASE_URL, SERVICE_KEY);
const stripe = new Stripe(STRIPE_KEY, { apiVersion: '2025-01-27.acacia' });
const line = (s = '') => console.log(s);

// ── 0. A chave consegue distinguir "não é minha" de "não posso ler"? ───────
try {
  await stripe.accounts.list({ limit: 1 });
} catch (e) {
  const msg = (e as { raw?: { message?: string }; message?: string })?.raw?.message
    ?? (e as { message?: string })?.message ?? String(e);
  console.error(
    'ABORTADO: esta chave não consegue LISTAR contas Connect, então um erro por conta ' +
    'é ambíguo — pode ser "a conta não é desta plataforma" ou "a chave não pode ler contas". ' +
    'Apagar vínculo de pagamento com base nisso seria chute.\n\n' +
    `Stripe disse: ${msg}\n\n` +
    'Habilite "Accounts Read" (connected_account_read) na chave e rode de novo.',
  );
  Deno.exit(1);
}
line('✔ a chave lista contas Connect — os erros por conta são confiáveis.');
line();

// ── 1. Candidatas ──────────────────────────────────────────────────────────
let consulta = sb
  .from('profiles')
  .select('id, full_name, type, stripe_account_id, stripe_charges_enabled, stripe_payouts_enabled')
  .not('stripe_account_id', 'is', null);
if (SO_ESTE) consulta = consulta.eq('id', SO_ESTE);

const { data, error } = await consulta.order('created_at');
if (error) { console.error('Falha ao ler os perfis:', error.message); Deno.exit(1); }
const perfis = (data ?? []) as {
  id: string; full_name: string | null; type: string | null; stripe_account_id: string;
  stripe_charges_enabled: boolean | null; stripe_payouts_enabled: boolean | null;
}[];

line(`Perfis com conta Connect gravada: ${perfis.length}`);
line(APLICAR ? 'Modo: APLICAR (vai escrever)' : 'Modo: ENSAIO (não escreve nada)');
line();

// ── 2. Conferência conta por conta, no momento da escrita ─────────────────
const orfas: typeof perfis = [];
const boas: typeof perfis = [];
const indefinidas: { p: typeof perfis[number]; motivo: string }[] = [];

for (const p of perfis) {
  const rotulo = `${(p.full_name ?? '(sem nome)').padEnd(20)} ${p.stripe_account_id}`;
  try {
    const a = await stripe.accounts.retrieve(p.stripe_account_id);
    line(`✅ ${rotulo} — ACESSÍVEL (criada ${new Date((a.created ?? 0) * 1000).toISOString().slice(0, 10)}). Não será tocada.`);
    boas.push(p);
  } catch (e) {
    const msg = (e as { raw?: { message?: string }; message?: string })?.raw?.message
      ?? (e as { message?: string })?.message ?? String(e);
    if (/does not have access to account|No such account/i.test(msg)) {
      line(`🧹 ${rotulo} — ÓRFÃ (outra plataforma).`);
      orfas.push(p);
    } else {
      // Qualquer outro erro é desconhecido. Não se apaga no escuro.
      line(`⚠️  ${rotulo} — INDEFINIDA: ${msg.slice(0, 110)}`);
      indefinidas.push({ p, motivo: msg });
    }
  }
}

line();
line(`Acessíveis: ${boas.length} | Órfãs: ${orfas.length} | Indefinidas: ${indefinidas.length}`);
if (indefinidas.length > 0) line('As indefinidas NÃO serão tocadas — resolva o motivo e rode de novo.');
line();

if (orfas.length === 0) { line('Nada a desvincular.'); Deno.exit(0); }

line('Ao desvincular, cada motorista precisa refazer o onboarding do Connect no app');
line('(Perfil → Pagamentos → conectar conta). Até lá, o repasse o PULA — o dinheiro');
line('dele continua na fila, intacto.');
line();

if (!APLICAR) {
  line('ENSAIO — nada foi escrito. Rode de novo com --aplicar para valer.');
  Deno.exit(0);
}

// ── 3. Escrita ─────────────────────────────────────────────────────────────
// O desfazer vem ANTES. Se a auditoria não gravar, nada é alterado: um
// `stripe_account_id` apagado sem registro é um vínculo que ninguém reconstrói.
const antes = orfas.map((p) => ({
  profile_id: p.id,
  full_name: p.full_name,
  stripe_account_id: p.stripe_account_id,
  stripe_charges_enabled: p.stripe_charges_enabled,
  stripe_payouts_enabled: p.stripe_payouts_enabled,
}));

const { error: erroAuditoria } = await sb.from('stripe_reconciliation').upsert({
  event_id: `orphan_connect_cleanup_${new Date().toISOString().slice(0, 19)}`,
  event_type: 'connect.orphan.cleanup',
  object_id: 'clear_orphan_connect',
  amount_cents: 0,
  currency: 'usd',
  needs_attention: true,
  reason:
    `Desvinculadas ${orfas.length} conta(s) Connect que a plataforma atual (acct_1TcCkyCgSu88OSlV) ` +
    'não alcança — pertencem à plataforma Stripe anterior. O stripe_account_id foi apagado para que ' +
    'connect-onboard-driver possa criar uma conta nova (ele só cria quando a coluna está vazia). ' +
    'needs_attention fica TRUE de propósito: cada motorista desta lista precisa refazer o onboarding, ' +
    'e isso é trabalho humano. Os ids anteriores estão em raw.antes.',
  raw: { source: 'clear_orphan_connect', plataforma_atual: 'acct_1TcCkyCgSu88OSlV', antes },
}, { onConflict: 'event_id' });

if (erroAuditoria) {
  console.error('Falha ao gravar a auditoria — NADA foi alterado:', erroAuditoria.message);
  Deno.exit(1);
}
line('✔ auditoria gravada em stripe_reconciliation (raw.antes tem o desfazer).');

let limpas = 0;
for (const p of orfas) {
  // Condicional no MESMO id que qualificou a linha: se o motorista refez o
  // onboarding entre o levantamento e agora, quem ganha é a escrita dele.
  const { data: ok, error: erroUpdate } = await sb
    .from('profiles')
    .update({ stripe_account_id: null })
    .eq('id', p.id)
    .eq('stripe_account_id', p.stripe_account_id)
    .select('id');

  if (erroUpdate) line(`   ❌ ${p.full_name}: ${erroUpdate.message}`);
  else if ((ok?.length ?? 0) === 0) line(`   ⏭  ${p.full_name}: mudou no meio do caminho — deixado como está.`);
  else { limpas += 1; line(`   ✔ ${p.full_name} desvinculado.`); }
}

line();
line(`Resumo: ${limpas} de ${orfas.length} desvinculado(s).`);
line('Próximo passo, e é humano: chamar cada um para refazer o Connect no app.');
