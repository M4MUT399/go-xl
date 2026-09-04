// testa_pedagio_mco.ts — a Routes API devolve pedágio de verdade?
//
// ── POR QUE ESTE SCRIPT E NÃO UM CURL PARA A GOOGLE ───────────────────────
//
// Um curl direto testaria a chave. Isto testa o CAMINHO: usuário autenticado →
// Edge Function `toll-quote` → Routes API → resposta. É o percurso que o app do
// passageiro faz quando `tolls_enabled` estiver ligada, e é onde um erro de
// FieldMask, de restrição de chave ou de formato apareceria.
//
// Também não exige que a chave da Routes API passe por lugar nenhum: ela já
// está no segredo do Supabase, e quem a usa é a função.
//
// ── O QUE ELE FAZ ─────────────────────────────────────────────────────────
//
// Cria um usuário descartável (a função exige sessão), chama a `toll-quote`
// para a rota MCO → College Park — a mesma corrida do Ryan, que sobe a
// Beachline (SR-528), pedagiada — e APAGA o usuário no fim, inclusive se der
// erro no meio.
//
// ⚠️ Cada chamada com `tollInfo` no FieldMask custa ~US$ 0,015 (faixa Routes
// Preferred). Este script faz UMA.
//
// NÃO MUDA CONFIGURAÇÃO NENHUMA. Não liga flag, não mexe em corrida.
//
// Como rodar (VOCÊ roda; a IA nunca tem a service_role key):
//   deno run --allow-env --allow-net --allow-read --node-modules-dir=auto \
//     supabase/scripts/testa_pedagio_mco.ts

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { load } from 'jsr:@std/dotenv';

try {
  await load({ envPath: new URL('./.env', import.meta.url).pathname, export: true });
} catch { /* segue com o ambiente */ }

const URL_SB = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
const ANON = Deno.env.get('SUPABASE_ANON_KEY')
  ?? 'sb_publishable_Tu3TmYgQa6gOII2X-AbDLg_A0eLlIbd';

// MCO → 395 Mashie Lane, College Park (a corrida do Ryan).
const MCO = { lat: 28.4230, lng: -81.3041 };
const COLLEGE_PARK = { lat: 28.5729, lng: -81.4001 };

function line(s = '') { console.log(s); }

if (!URL_SB || !SERVICE) {
  console.error('✗ faltam SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (supabase/scripts/.env)');
  Deno.exit(1);
}

const admin = createClient(URL_SB, SERVICE.trim());
const email = `pedagio_teste_${Date.now()}@goxl.express`;
const senha = `T${Math.random().toString(36).slice(2)}${Date.now().toString(36)}!`;
let userId: string | null = null;

line('════════════════════════════════════════════════════════');
line(' teste de pedágio — MCO → College Park (Beachline)');
line('════════════════════════════════════════════════════════\n');

try {
  const { data: criado, error: errCria } = await admin.auth.admin.createUser({
    email, password: senha, email_confirm: true,
  });
  if (errCria || !criado.user) throw new Error(`não criei o usuário de teste: ${errCria?.message}`);
  userId = criado.user.id;
  line(`usuário descartável: ${email}`);

  const publico = createClient(URL_SB, ANON);
  const { data: sessao, error: errLogin } =
    await publico.auth.signInWithPassword({ email, password: senha });
  if (errLogin || !sessao.session) throw new Error(`não consegui sessão: ${errLogin?.message}`);

  line('chamando toll-quote…\n');
  const res = await fetch(`${URL_SB}/functions/v1/toll-quote`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: ANON,
      Authorization: `Bearer ${sessao.session.access_token}`,
    },
    body: JSON.stringify({ origin: MCO, dest: COLLEGE_PARK }),
  });

  const texto = await res.text();
  line(`HTTP ${res.status}`);
  line(texto);
  line('');
  line('──────────────────────────────────────────────────────');

  let corpo: Record<string, unknown> = {};
  try { corpo = JSON.parse(texto); } catch { /* resposta não-JSON */ }

  if (res.status === 501) {
    line('✗ a função diz que a Routes API NÃO está configurada.');
    line('  O segredo GOOGLE_ROUTES_API_KEY não chegou nela.');
  } else if (res.status === 502) {
    line('✗ a Google recusou a chamada. Causas típicas: a chave não permite a');
    line('  Routes API, ou a API não está habilitada no projeto.');
    line('  O motivo exato está no log da função (Supabase → Edge Functions →');
    line('  toll-quote → Logs), na linha "[toll-quote] Routes API".');
  } else if (res.ok && corpo.semPedagio === true) {
    line('⚠️ A Google respondeu, mas NÃO devolveu pedágio para esta rota.');
    line('  Isso é resposta legítima: ela só cobre pedágio em cidades');
    line('  selecionadas. Ligar a flag não vai cobrar pedágio nenhum aqui —');
    line('  o valor virá 0, igual a hoje.');
  } else if (res.ok && typeof corpo.amount === 'number') {
    const km = typeof corpo.distanceMeters === 'number'
      ? (corpo.distanceMeters / 1000).toFixed(1) : '—';
    line(`✅ PEDÁGIO REAL: US$ ${corpo.amount.toFixed(2)}  (rota de ${km} km)`);
    line('  O caminho inteiro funciona. Pode ligar as flags.');
  } else {
    line('✗ resposta inesperada — ver o corpo acima.');
  }
} catch (e) {
  console.error(`\n✗ ABORTADO: ${String((e as Error)?.message ?? e)}`);
} finally {
  if (userId) {
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    line(`\n(usuário de teste removido)`);
  }
}
