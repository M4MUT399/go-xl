// verify_qr_lock_test.ts — verificação pontual, somente-leitura, do teste
// manual do fix de vinculação de QR Code (AppNavigator.tsx).
//
// Busca a corrida mais recente e mostra driver_id + o perfil (nome, driver_code)
// do motorista associado, para conferir visualmente que bate com o motorista
// dono do QR escaneado no teste. NÃO MUDA NADA no banco.
//
// Como rodar:
//   deno run --allow-env --allow-net --allow-read --node-modules-dir=auto \
//     supabase/scripts/verify_qr_lock_test.ts

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { load } from 'jsr:@std/dotenv';

try {
  await load({ envPath: new URL('./.env', import.meta.url).pathname, export: true });
} catch {
  // segue só com env do processo, se não houver .env local
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

if (!SUPABASE_URL || !SERVICE_KEY) {
  throw new Error('Faltam SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY no ambiente.');
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY.trim());

const { data: rides, error } = await admin
  .from('rides')
  .select('id, status, passenger_id, driver_id, created_at')
  .order('created_at', { ascending: false })
  .limit(1);

if (error) throw new Error(`Falha ao consultar rides: ${error.message}`);
if (!rides?.length) {
  console.log('Nenhuma corrida encontrada.');
  Deno.exit(0);
}

const ride = rides[0];
console.log('Última corrida criada:');
console.log(`  id:           ${ride.id}`);
console.log(`  status:       ${ride.status}`);
console.log(`  criada em:    ${ride.created_at}`);
console.log(`  passenger_id: ${ride.passenger_id}`);
console.log(`  driver_id:    ${ride.driver_id ?? '— (não travada)'}`);

if (ride.driver_id) {
  const { data: driver, error: dErr } = await admin
    .from('profiles')
    .select('id, full_name, driver_code, type')
    .eq('id', ride.driver_id)
    .single();
  if (dErr) {
    console.log(`\n(não consegui buscar o perfil do motorista: ${dErr.message})`);
  } else {
    console.log('\nMotorista vinculado (driver_id):');
    console.log(`  nome:        ${driver.full_name}`);
    console.log(`  driver_code: ${driver.driver_code}`);
    console.log(`  type:        ${driver.type}`);
  }
} else {
  console.log('\n⚠ Esta corrida NÃO tem driver_id definido — não foi travada via QR.');
}
