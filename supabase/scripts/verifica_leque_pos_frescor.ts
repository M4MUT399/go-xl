// verifica_leque_pos_frescor.ts — RELATÓRIO somente-leitura.
//
// PERGUNTA: depois do deploy de 02/09/2026, o leque de push parou de incluir
// motorista fantasma?
//
// ── POR QUE ESTE SCRIPT NÃO CHAMA A FUNÇÃO ────────────────────────────────
//
// A tentação seria invocar `send-ride-push` e ver quem ela devolve. Isso não
// serviria: a função não devolve o leque, ela DISPARA o push — e chamá-la faria
// telefones de verdade tocarem por uma corrida que não existe.
//
// O que este script lê é a testemunha que a própria função deixa: a tabela
// `ride_push_offers` (migration 0070), onde ela registra CADA par
// (corrida, motorista) para quem tocou. É registro de produção, escrito pelo
// código implantado — não por mim, e não derivado do meu raciocínio.
//
// ── COMO LER O RESULTADO ──────────────────────────────────────────────────
//
// Para a corrida mais recente, o script cruza quem recebeu o toque com quão
// fresco estava o fix daquele motorista. Antes do deploy, `send-ride-push`
// filtrava só por `is_online = true` — então motorista parado desde julho
// entrava no leque. Depois, entra só quem publicou posição nos últimos 10 min.
//
//   • Toda linha com fix fresco  → o filtro está valendo.
//   • Alguma linha com fix velho → ou o deploy não pegou, ou a corrida é
//     ANTERIOR ao deploy. O script mostra os horários para você distinguir.
//
// ⚠️ Uma corrida pedida ANTES de 02/09 21:44 UTC não diz nada sobre o conserto.
// Peça uma corrida de teste depois disso e rode isto em seguida.
//
// NÃO MUDA NADA — só lê e imprime.
//
// Como rodar (VOCÊ roda; a IA nunca tem a service_role key):
//   deno run --allow-env --allow-net --allow-read --node-modules-dir=auto \
//     supabase/scripts/verifica_leque_pos_frescor.ts

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { load } from 'jsr:@std/dotenv';

try {
  await load({ envPath: new URL('./.env', import.meta.url).pathname, export: true });
} catch {
  // .env ausente — segue com o ambiente
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

/** Quando send-ride-push e dispatch-engine foram implantadas com o filtro. */
const DEPLOY_FILTRO = new Date('2026-09-02T21:44:00Z');
/** A mesma janela de _shared/driverFreshness.ts. */
const JANELA_MS = 10 * 60 * 1000;

function line(s = '') { console.log(s); }

async function main() {
  line('════════════════════════════════════════════════════════');
  line(' verifica_leque_pos_frescor — relatório (NÃO MUDA NADA)');
  line('════════════════════════════════════════════════════════');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error('Faltam SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY (veja supabase/scripts/.env).');
  }
  const admin = createClient(SUPABASE_URL, SERVICE_KEY.trim());

  // A corrida mais recente que teve leque registrado.
  const { data: ofertas, error: errOf } = await admin
    .from('ride_push_offers')
    .select('ride_id, driver_id, offered_at')
    .order('offered_at', { ascending: false })
    .limit(60);
  if (errOf) throw new Error(`Falha ao ler ride_push_offers: ${errOf.message}`);

  const linhas = (ofertas as { ride_id: string; driver_id: string; offered_at: string }[]) ?? [];
  if (linhas.length === 0) {
    line('Nenhum leque registrado em ride_push_offers. Nada a concluir —');
    line('peça uma corrida de teste e rode de novo.');
    return;
  }

  const rideId = linhas[0].ride_id;
  const doLeque = linhas.filter((o) => o.ride_id === rideId);
  const quando = new Date(doLeque[0].offered_at);

  line(`corrida:      ${rideId}`);
  line(`leque em:     ${quando.toISOString()}`);
  line(`deploy em:    ${DEPLOY_FILTRO.toISOString()}`);
  const depois = quando > DEPLOY_FILTRO;
  line(`→ ${depois
    ? 'a corrida é POSTERIOR ao deploy: o resultado abaixo VALE.'
    : '⚠️ a corrida é ANTERIOR ao deploy: o resultado abaixo NÃO diz nada sobre o conserto.'}`);
  line('');

  const ids = doLeque.map((o) => o.driver_id);
  const { data: locs } = await admin
    .from('driver_locations')
    .select('driver_id, is_online, updated_at')
    .in('driver_id', ids);
  const porId = new Map((locs as { driver_id: string; is_online: boolean | null; updated_at: string | null }[] ?? [])
    .map((l) => [l.driver_id, l]));

  const { data: profs } = await admin.from('profiles').select('id, full_name').in('id', ids);
  const nome = new Map((profs as { id: string; full_name: string | null }[] ?? [])
    .map((p) => [p.id, p.full_name ?? '⟨sem nome⟩']));

  let velhos = 0;
  line(`Motoristas que receberam o toque: ${doLeque.length}\n`);
  for (const o of doLeque) {
    const l = porId.get(o.driver_id);
    const t = l?.updated_at ? new Date(l.updated_at).getTime() : null;
    const idadeMin = t === null ? null : (quando.getTime() - t) / 60000;
    const fresco = idadeMin !== null && idadeMin * 60000 < JANELA_MS;
    if (!fresco) velhos++;
    line('──────────────────────────────────────────────────────');
    line(`  ${nome.get(o.driver_id) ?? '⟨sem perfil⟩'}`);
    line(`  fix publicado: ${idadeMin === null ? '⟨nunca⟩' : `${idadeMin.toFixed(1)} min antes do leque`}`);
    line(`  → ${fresco ? 'FRESCO ✅' : 'VELHO ⚠️ — não deveria estar no leque'}`);
  }

  line('\n──────────────────────────────────────────────────────');
  line('Veredito:');
  if (!depois) {
    line('  ⚠️ Inconclusivo — a corrida é anterior ao deploy.');
  } else if (velhos === 0) {
    line('  ✅ Todo o leque tinha fix fresco. O filtro está valendo em produção.');
  } else {
    line(`  ✗ ${velhos} motorista(s) com fix velho entraram no leque mesmo`);
    line('    depois do deploy. O filtro NÃO está surtindo efeito — investigar.');
  }
  line('\nNenhuma alteração foi feita.');
}

main().catch((e) => {
  console.error(`\n✗ ABORTADO: ${String(e?.message ?? e)}`);
  Deno.exit(1);
});
