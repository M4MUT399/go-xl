// list_active_rides.ts — RELATÓRIO somente-leitura das corridas atualmente
// "ativas" (não terminais) no banco, para investigar corridas presas.
//
// Por que existe:
//   Um passageiro ficou com uma corrida "travada" na tela (ActiveRideScreen).
//   Uma causa possível é puramente de front-end (já corrigida — ver
//   ActiveRideScreen.tsx: a navegação para fora da tela agora reage a
//   `ride.status` de QUALQUER fonte, não só do realtime). Outra causa possível
//   é a corrida estar REALMENTE presa no banco (status nunca virou 'completed'/
//   'cancelled'), por ex. porque a escrita em `updateRideStatus` (useRide.ts)
//   falhou silenciosamente sem retry.
//
//   Este script NÃO MUDA NADA — só lista o que está ativo agora e há quanto
//   tempo, pra decidirmos junto (você + eu) qual encerrar e como (cancelar vs.
//   marcar concluída), já que isso pode ter implicação financeira (cobrança ao
//   passageiro / repasse ao motorista via Stripe). Depois deste relatório,
//   escrevemos um script de finalização à parte, específico pro que for
//   necessário.
//
// Como rodar (você roda; a IA nunca tem a service_role key):
//
//   OPÇÃO A (mais fácil) — arquivo local, git-ignorado:
//     1) copie supabase/scripts/.env.example para supabase/scripts/.env
//     2) abra supabase/scripts/.env num editor de texto (não no terminal) e
//        cole os valores reais de SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY
//     3) deno run --allow-env --allow-net --allow-read --node-modules-dir=auto \
//          supabase/scripts/list_active_rides.ts
//
//   OPÇÃO B — variáveis de ambiente na sessão do terminal:
//     export SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...
//     deno run --allow-env --allow-net --node-modules-dir=auto \
//       supabase/scripts/list_active_rides.ts
//
//   # opcional (qualquer opção): só corridas com mais de N horas de idade (default 1h)
//   ... supabase/scripts/list_active_rides.ts --hours=2

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { load } from 'jsr:@std/dotenv';

// Carrega supabase/scripts/.env se existir (Opção A). Se não existir, segue
// só com o que já estiver no ambiente (Opção B) — não é erro nenhum dos casos.
try {
  await load({ envPath: new URL('./.env', import.meta.url).pathname, export: true });
} catch {
  // arquivo .env ausente — normal se o usuário optou pela Opção B.
}

type RideStatus = 'scheduled' | 'requesting' | 'accepted' | 'driver_en_route' | 'in_progress' | 'completed' | 'cancelled';

interface RideRow {
  id: string;
  status: RideStatus;
  passenger_id: string;
  driver_id: string | null;
  price: number | null;
  paid: boolean | null;
  stripe_payment_intent_id: string | null;
  created_at: string;
  accepted_at: string | null;
  scheduled_for: string | null;
}

// Mesma lista de status "ativos" usada pelo app (ver ACTIVE_RIDE_STATUSES em
// src/hooks/useRide.ts). Deliberadamente exclui 'scheduled' — corrida
// agendada pro futuro não é "presa".
const ACTIVE_RIDE_STATUSES: RideStatus[] = ['requesting', 'accepted', 'driver_en_route', 'in_progress'];

const hoursArg = Deno.args.find((a) => a.startsWith('--hours='));
const MIN_AGE_HOURS = hoursArg ? Number(hoursArg.split('=')[1]) : 1;

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

function line(s = '') { console.log(s); }

function fmtAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h${m}m`;
}

async function main() {
  line('════════════════════════════════════════════════════════');
  line(' list_active_rides — relatório (NÃO MUDA NADA)');
  line('════════════════════════════════════════════════════════');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error('Faltam SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY no ambiente.');
  }

  // Diagnóstico (NUNCA imprime a chave em si — só metadados pra confirmar que
  // o .env foi carregado corretamente, sem vazar nada sensível):
  line(`(diag) SUPABASE_URL: ${SUPABASE_URL}`);
  line(`(diag) SERVICE_KEY carregada: ${SERVICE_KEY.length} caracteres`);
  line(`(diag) formato: ${SERVICE_KEY.startsWith('eyJ') ? 'legacy JWT (eyJ...)' : SERVICE_KEY.startsWith('sb_secret_') ? 'novo (sb_secret_...)' : 'formato não reconhecido'}`);
  if (SERVICE_KEY !== SERVICE_KEY.trim()) {
    line('(diag) ⚠ a chave tem espaço/quebra de linha sobrando no início ou fim!');
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY.trim());

  const { data, error } = await admin
    .from('rides')
    .select('id, status, passenger_id, driver_id, price, paid, stripe_payment_intent_id, created_at, accepted_at, scheduled_for')
    .in('status', ACTIVE_RIDE_STATUSES)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Falha ao consultar rides: ${error.message}`);

  const rows = (data as RideRow[]) ?? [];
  const stuck = rows.filter((r) => (Date.now() - new Date(r.created_at).getTime()) / 3_600_000 >= MIN_AGE_HOURS);

  line(`\nTotal de corridas ativas (qualquer idade): ${rows.length}`);
  line(`Com ${MIN_AGE_HOURS}h+ de idade (candidatas a "presas"): ${stuck.length}\n`);

  if (!stuck.length) {
    line('Nenhuma corrida ativa com idade suficiente pra ser considerada presa. Nada a fazer.');
    return;
  }

  for (const r of stuck) {
    line('──────────────────────────────────────────────────────');
    line(`  id:              ${r.id}`);
    line(`  status:          ${r.status}`);
    line(`  idade:           ${fmtAge(r.created_at)}  (criada em ${r.created_at})`);
    line(`  accepted_at:     ${r.accepted_at ?? '—'}`);
    line(`  passenger_id:    ${r.passenger_id}`);
    line(`  driver_id:       ${r.driver_id ?? '—'}`);
    line(`  price:           ${r.price != null ? `$${r.price.toFixed(2)}` : '—'}`);
    line(`  paid:            ${r.paid ? 'SIM' : 'não'}`);
    line(`  payment_intent:  ${r.stripe_payment_intent_id ?? '—'}`);
  }

  line('\n──────────────────────────────────────────────────────');
  line('Nenhuma alteração foi feita. Com esta lista em mãos, decidimos juntos');
  line('o que fazer com cada uma (cancelar sem cobrança, ou marcar concluída)');
  line('antes de eu escrever o script de finalização.');
}

main().catch((e) => {
  console.error(`\n✗ ABORTADO: ${String(e?.message ?? e)}`);
  Deno.exit(1);
});
