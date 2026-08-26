// check_driver_names.ts — RELATÓRIO somente-leitura para diagnosticar por que o
// card de corrida agendada (tela do PASSAGEIRO, ScheduledRidesScreen) mostra o
// rótulo genérico "Driver" em vez do NOME do motorista que aceitou.
//
// Contexto do bug (áudio do Edson, 2026-07-17):
//   Em dois agendamentos já confirmados (um pela Cristiane, outro pelo
//   "Fabrício Driver"), o card mostra CERTINHO a placa e o modelo do carro,
//   MAS no lugar do nome do motorista aparece só "Driver". O ideal — como a
//   Uber faz — é aparecer o nome (Fabrício, Cristiane, Douglas, Pedro…).
//
// A tela busca o nome assim (ScheduledRidesScreen.tsx):
//   supabase.from('profiles_public').select('full_name').eq('id', driver_id).single()
//   -> name = data?.full_name ?? 'Driver'
//
// Ou seja: se aparece "Driver", é porque `full_name` voltou VAZIO/NULL para
// aquele motorista. Este script confirma isso lendo, para cada corrida agendada
// COM motorista, o full_name real em `profiles` e o que a view `profiles_public`
// devolve — lado a lado com o veículo (que sabemos que aparece). Assim decidimos
// se é problema de DADO (nome vazio no cadastro do motorista) ou de CÓDIGO.
//
// NÃO MUDA NADA — só lê e imprime.
//
// Como rodar (VOCÊ roda; a IA nunca tem a service_role key):
//   1) confirme que supabase/scripts/.env tem SUPABASE_URL e
//      SUPABASE_SERVICE_ROLE_KEY (o mesmo .env do list_active_rides.ts)
//   2) deno run --allow-env --allow-net --allow-read --node-modules-dir=auto \
//        supabase/scripts/check_driver_names.ts

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

interface RideRow { id: string; driver_id: string | null; scheduled_for: string | null; status: string; }
interface ProfileRow { id: string; full_name: string | null; type: string | null; }
interface VehicleRow { driver_id: string; model: string | null; plate: string | null; color: string | null; }

function show(v: string | null | undefined): string {
  if (v === null) return '⟨NULL⟩';
  if (v === undefined) return '⟨ausente⟩';
  if (v === '') return '⟨string vazia⟩';
  return `"${v}"`;
}

async function main() {
  line('════════════════════════════════════════════════════════');
  line(' check_driver_names — relatório (NÃO MUDA NADA)');
  line('════════════════════════════════════════════════════════');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error('Faltam SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY no ambiente (veja supabase/scripts/.env).');
  }
  line(`(diag) SUPABASE_URL: ${SUPABASE_URL}`);
  line(`(diag) SERVICE_KEY carregada: ${SERVICE_KEY.length} caracteres\n`);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY.trim());

  // 1) Corridas agendadas COM motorista confirmado
  const { data: rideData, error: rideErr } = await admin
    .from('rides')
    .select('id, driver_id, scheduled_for, status')
    .eq('status', 'scheduled')
    .not('driver_id', 'is', null)
    .order('scheduled_for', { ascending: true });
  if (rideErr) throw new Error(`Falha ao ler rides: ${rideErr.message}`);

  const rides = (rideData as RideRow[]) ?? [];
  line(`Corridas agendadas com motorista confirmado: ${rides.length}\n`);
  if (rides.length === 0) {
    line('Nenhuma corrida agendada com motorista. Sem o que diagnosticar.');
    return;
  }

  const driverIds = Array.from(new Set(rides.map((r) => r.driver_id!).filter(Boolean)));

  // 2) full_name direto de profiles (fonte da verdade)
  const { data: profData, error: profErr } = await admin
    .from('profiles')
    .select('id, full_name, type')
    .in('id', driverIds);
  if (profErr) throw new Error(`Falha ao ler profiles: ${profErr.message}`);
  const profById = new Map((profData as ProfileRow[] ?? []).map((p) => [p.id, p]));

  // 3) o que a VIEW profiles_public devolve (é o que o app lê)
  const { data: pubData, error: pubErr } = await admin
    .from('profiles_public')
    .select('id, full_name')
    .in('id', driverIds);
  if (pubErr) throw new Error(`Falha ao ler profiles_public: ${pubErr.message}`);
  const pubById = new Map((pubData as { id: string; full_name: string | null }[] ?? []).map((p) => [p.id, p.full_name]));

  // 4) veículo (sabemos que aparece — serve de controle)
  const { data: vehData, error: vehErr } = await admin
    .from('vehicles')
    .select('driver_id, model, plate, color')
    .in('driver_id', driverIds);
  if (vehErr) throw new Error(`Falha ao ler vehicles: ${vehErr.message}`);
  const vehById = new Map((vehData as VehicleRow[] ?? []).map((v) => [v.driver_id, v]));

  for (const r of rides) {
    const did = r.driver_id!;
    const prof = profById.get(did);
    const pubName = pubById.get(did);
    const veh = vehById.get(did);
    line('──────────────────────────────────────────────────────');
    line(`  ride_id:                 ${r.id}`);
    line(`  scheduled_for:           ${r.scheduled_for ?? '—'}`);
    line(`  driver_id:               ${did}`);
    line(`  profile.type:            ${prof?.type ?? '⟨motorista sem linha em profiles!⟩'}`);
    line(`  profiles.full_name:      ${show(prof?.full_name)}   ← fonte da verdade`);
    line(`  profiles_public.full_name: ${show(pubName)}   ← o que o app lê`);
    line(`  vehicle:                 ${veh ? `${show(veh.model)} · ${show(veh.color)}  placa ${show(veh.plate)}` : '⟨sem veículo⟩'}`);
    const appMostra = (pubName ?? '') === '' ? '"Driver" (fallback)' : `"${pubName}"`;
    line(`  → app EXIBIRIA:          ${appMostra}`);
  }

  line('\n──────────────────────────────────────────────────────');
  line('Leitura:');
  line('  • Se profiles.full_name aparece ⟨NULL⟩/⟨string vazia⟩ → é problema de DADO');
  line('    (esses motoristas foram cadastrados sem nome). O fix é preencher o');
  line('    nome no cadastro do motorista; nenhuma mudança de tela resolve.');
  line('  • Se profiles.full_name TEM o nome mas profiles_public.full_name volta');
  line('    vazio → é a VIEW/permissão. Fix no banco.');
  line('  • Se AMBOS têm o nome → é bug de CÓDIGO na tela (a consulta .single()).');
  line('Nenhuma alteração foi feita.');
}

main().catch((e) => {
  console.error(`\n✗ ABORTADO: ${String(e?.message ?? e)}`);
  Deno.exit(1);
});
