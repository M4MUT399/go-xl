// finalize_rides.ts — FINALIZAÇÃO manual de corridas presas em status ativo.
//
// O que faz:
//   Aplica, corrida por corrida, a ação que VOCÊ decidiu (cancel ou complete)
//   depois de ver o relatório do list_active_rides.ts. Este script NUNCA
//   decide sozinho o que fazer com uma corrida — sem plano explícito, não roda.
//
// O que NÃO faz (de propósito):
//   • NÃO mexe em Stripe: não extorna, não captura, não cria transfer. Se uma
//     corrida cancelada tiver pagamento (paid=true / payment_intent), o script
//     só AVISA — o acerto financeiro é decisão sua, feita à parte.
//   • NÃO toca em corridas 'scheduled' nem já terminais ('completed'/
//     'cancelled'): o alvo são só corridas presas em status ativo.
//
// Segurança de execução (mesmo padrão do reset_test_balances.ts):
//   • DRY-RUN por padrão: sem `--yes` só RELATA o que faria, sem mudar nada.
//   • Escrita confirmada: cada UPDATE usa .select() e é validado por linha
//     retornada — falha silenciosa não passa (é exatamente o bug que criou
//     as corridas presas; ver updateRideStatus em src/hooks/useRide.ts).
//   • Guarda atômica: o UPDATE só pega a corrida se ela AINDA estiver num
//     status ativo no momento da escrita (não sobrescreve corrida que mudou
//     entre o relatório e o apply).
//   • Idempotente: rodar de novo o mesmo plano não re-aplica nada (as
//     corridas já não estão mais ativas) — só reporta "pulada".
//
// Como rodar (VOCÊ roda; a IA nunca tem a service_role key):
//
//   Credenciais — iguais ao list_active_rides.ts:
//     OPÇÃO A: supabase/scripts/.env com SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY
//     OPÇÃO B: export SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...
//     (atenção: variável já exportada no terminal GANHA do .env — ver nota
//      sobre @std/dotenv no fim deste cabeçalho)
//
//   Plano pela linha de comando (id:ação, separados por espaço):
//     deno run --allow-env --allow-net --allow-read --node-modules-dir=auto \
//       supabase/scripts/finalize_rides.ts \
//       11111111-2222-3333-4444-555555555555:cancel \
//       aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee:complete
//
//   Ou plano por arquivo (uma corrida por linha; '#' comenta):
//     deno run --allow-env --allow-net --allow-read --node-modules-dir=auto \
//       supabase/scripts/finalize_rides.ts --file=plano.txt
//
//     # plano.txt:
//     #   <ride-id> cancel     (ou "<ride-id>:cancel")
//     #   <ride-id> complete
//
//   Depois de conferir o dry-run, repita o MESMO comando com --yes no final.
//
// Nota @std/dotenv: load({export:true}) NÃO sobrescreve variável que já
// existe no ambiente do processo. Se você exportou a chave nesta sessão do
// terminal, é ELA que vale, não a do .env. Na dúvida: rode num terminal novo
// ou `unset SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY` antes.

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { load } from 'jsr:@std/dotenv';

// Carrega supabase/scripts/.env se existir (Opção A). Ausente = Opção B.
try {
  await load({ envPath: new URL('./.env', import.meta.url).pathname, export: true });
} catch {
  // arquivo .env ausente — normal se o usuário optou pela Opção B.
}

type RideStatus = 'scheduled' | 'requesting' | 'accepted' | 'driver_en_route' | 'in_progress' | 'completed' | 'cancelled';
type Action = 'cancel' | 'complete';

interface RideRow {
  id: string;
  status: RideStatus;
  passenger_id: string;
  driver_id: string | null;
  price: number | null;
  paid: boolean | null;
  stripe_payment_intent_id: string | null;
  created_at: string;
}

// Mesma lista do list_active_rides.ts / ACTIVE_RIDE_STATUSES do app.
// 'scheduled' fica de fora de propósito: agendamento não é corrida presa.
const ACTIVE_RIDE_STATUSES: RideStatus[] = ['requesting', 'accepted', 'driver_en_route', 'in_progress'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const APPLY = Deno.args.includes('--yes') || Deno.args.includes('-y');
const fileArg = Deno.args.find((a) => a.startsWith('--file='));

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

function line(s = '') { console.log(s); }

function fmtAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h${m}m`;
}

/** Converte um item "<id>:<ação>" (ou "<id> <ação>") num par validado. */
function parsePlanItem(raw: string, origin: string): { id: string; action: Action } {
  const norm = raw.trim().replace(/\s+/g, ':');
  const parts = norm.split(':');
  if (parts.length !== 2) {
    throw new Error(`Item inválido (${origin}): "${raw}" — use <ride-id>:cancel ou <ride-id>:complete`);
  }
  const [id, actionRaw] = parts;
  const action = actionRaw.toLowerCase();
  if (!UUID_RE.test(id)) {
    throw new Error(`Item inválido (${origin}): "${id}" não parece um ride-id (UUID).`);
  }
  if (action !== 'cancel' && action !== 'complete') {
    throw new Error(`Item inválido (${origin}): ação "${actionRaw}" desconhecida — só "cancel" ou "complete".`);
  }
  return { id: id.toLowerCase(), action: action as Action };
}

async function buildPlan(): Promise<Map<string, Action>> {
  const positional = Deno.args.filter((a) => !a.startsWith('--') && a !== '-y');

  if (fileArg && positional.length) {
    throw new Error('Use OU itens na linha de comando OU --file=..., não os dois juntos.');
  }

  const items: { id: string; action: Action }[] = [];

  if (fileArg) {
    const path = fileArg.slice('--file='.length);
    if (!path) throw new Error('--file= veio vazio.');
    const text = await Deno.readTextFile(path);
    text.split('\n').forEach((l, i) => {
      const clean = l.replace(/#.*$/, '').trim();
      if (!clean) return;
      items.push(parsePlanItem(clean, `${path}:${i + 1}`));
    });
  } else {
    for (const arg of positional) items.push(parsePlanItem(arg, 'linha de comando'));
  }

  if (!items.length) {
    throw new Error(
      'Nenhuma corrida no plano. Este script não decide nada sozinho: informe ' +
      '<ride-id>:cancel|complete na linha de comando ou via --file=plano.txt. ' +
      'Pra levantar as corridas presas, rode antes o list_active_rides.ts.'
    );
  }

  const plan = new Map<string, Action>();
  for (const { id, action } of items) {
    const prev = plan.get(id);
    if (prev && prev !== action) {
      throw new Error(`Conflito no plano: corrida ${id} aparece como "${prev}" E "${action}". Resolva antes de rodar.`);
    }
    if (prev) line(`  (aviso) corrida ${id} duplicada no plano com a mesma ação — considerada uma vez.`);
    plan.set(id, action);
  }
  return plan;
}

async function main() {
  line('════════════════════════════════════════════════════════');
  line(' finalize_rides — finalização manual de corridas presas');
  line('════════════════════════════════════════════════════════');

  const plan = await buildPlan();

  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error('Faltam SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY no ambiente.');
  }

  // Diagnóstico (NUNCA imprime a chave — só metadados):
  line(`(diag) SUPABASE_URL: ${SUPABASE_URL}`);
  line(`(diag) SERVICE_KEY carregada: ${SERVICE_KEY.length} caracteres`);
  line(`(diag) formato: ${SERVICE_KEY.startsWith('eyJ') ? 'legacy JWT (eyJ...)' : SERVICE_KEY.startsWith('sb_secret_') ? 'novo (sb_secret_...)' : 'formato não reconhecido'}`);
  if (SERVICE_KEY !== SERVICE_KEY.trim()) {
    line('(diag) ⚠ a chave tem espaço/quebra de linha sobrando no início ou fim!');
  }

  line(APPLY
    ? '\n► MODO: APLICAR (--yes) — vai alterar dados.'
    : '\n► MODO: DRY-RUN — nada será alterado. Use --yes para aplicar.');

  const admin = createClient(SUPABASE_URL, SERVICE_KEY.trim());

  // ── Levantamento: busca as corridas do plano e valida o estado atual ──────
  const ids = [...plan.keys()];
  const { data, error } = await admin
    .from('rides')
    .select('id, status, passenger_id, driver_id, price, paid, stripe_payment_intent_id, created_at')
    .in('id', ids);
  if (error) throw new Error(`Falha ao consultar rides: ${error.message}`);

  const byId = new Map<string, RideRow>(((data as RideRow[]) ?? []).map((r) => [r.id, r]));

  const applicable: { ride: RideRow; action: Action }[] = [];
  let skipped = 0;

  line('\n── Plano ───────────────────────────────────────────────');
  for (const [id, action] of plan) {
    const ride = byId.get(id);
    if (!ride) {
      line(`  ✗ ${id} → ${action}: NÃO ENCONTRADA no banco — pulada.`);
      skipped += 1;
      continue;
    }
    if (!ACTIVE_RIDE_STATUSES.includes(ride.status)) {
      line(`  • ${id} → ${action}: status atual '${ride.status}' não é ativo — pulada (nada a finalizar).`);
      skipped += 1;
      continue;
    }
    const alvo = action === 'cancel' ? 'cancelled' : 'completed';
    line(`  ✓ ${id}: '${ride.status}' → '${alvo}'  (idade ${fmtAge(ride.created_at)})`);
    if (action === 'cancel' && (ride.paid || ride.stripe_payment_intent_id)) {
      line(`      ⚠ paga (paid=${ride.paid ? 'SIM' : 'não'}, payment_intent=${ride.stripe_payment_intent_id ?? '—'})`);
      line('        Este script NÃO extorna — trate o reembolso à parte (painel do Stripe).');
    }
    if (action === 'complete' && !ride.paid) {
      line('      ℹ completar SEM pagamento (paid=não): não entra no saldo do motorista.');
    }
    applicable.push({ ride, action });
  }

  line('\n──────────────────────────────────────────────────────');
  line(`  Aplicáveis: ${applicable.length}   Puladas: ${skipped}`);

  if (!applicable.length) {
    line('\nNada aplicável. Nenhuma alteração foi feita.');
    return;
  }

  if (!APPLY) {
    line('\nDRY-RUN concluído. Nenhuma alteração foi feita.');
    line('Confira o plano acima e repita o MESMO comando com --yes para aplicar.');
    return;
  }

  // ── Aplicação: um UPDATE por corrida, guardado por status ativo ───────────
  let okCount = 0;
  let failCount = 0;
  for (const { ride, action } of applicable) {
    const patch = action === 'cancel'
      ? { status: 'cancelled' as RideStatus }
      : { status: 'completed' as RideStatus, completed_at: new Date().toISOString() };

    const { data: updated, error: upErr } = await admin
      .from('rides')
      .update(patch)
      .eq('id', ride.id)
      .in('status', ACTIVE_RIDE_STATUSES) // guarda: só se AINDA estiver ativa
      .select('id, status');

    const row = (updated as { id: string; status: RideStatus }[] | null)?.[0];
    if (upErr || !row) {
      failCount += 1;
      line(`  ✗ ${ride.id}: FALHOU — ${upErr ? upErr.message : 'nenhuma linha atualizada (status mudou entre o relatório e o apply?)'}`);
      continue;
    }
    okCount += 1;
    line(`  ✓ ${ride.id}: agora '${row.status}'.`);
  }

  line('\n──────────────────────────────────────────────────────');
  line(`✅ Concluído: ${okCount} aplicada(s), ${failCount} falha(s), ${skipped} pulada(s).`);
  if (failCount) {
    line('Reveja as falhas acima; rodar de novo é seguro (guarda por status ativo).');
    Deno.exit(1);
  }
}

main().catch((e) => {
  console.error(`\n✗ ABORTADO: ${String(e?.message ?? e)}`);
  Deno.exit(1);
});
