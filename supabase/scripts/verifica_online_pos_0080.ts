// verifica_online_pos_0080.ts — RELATÓRIO somente-leitura.
//
// PERGUNTA: depois da migração 0080, os motoristas voltaram a conseguir
// PUBLICAR POSIÇÃO?
//
// ── POR QUE ESTE SCRIPT NÃO TESTA A PERMISSÃO DIRETAMENTE ──────────────────
//
// A tentação seria fazer aqui o mesmo upsert que o app faz e ver se passa.
// Isso não provaria NADA: este script roda com a `service_role`, que ignora
// RLS e ignora grants de coluna. Ele passaria mesmo com a 0080 revertida.
// Teste que passa nas duas hipóteses não separa hipótese nenhuma.
//
// O que ele faz em vez disso é olhar a CONSEQUÊNCIA: `driver_locations.
// updated_at` só avança quando um cliente autenticado de verdade — o app, no
// papel `authenticated` — conseguiu escrever. Se avançou depois de 0080 ter
// sido aplicada, a escrita voltou. Se todas as linhas continuam paradas em
// data antiga, ou ninguém abriu o app ainda, ou o conserto não bastou.
//
// ── O QUE ERA O DEFEITO ────────────────────────────────────────────────────
//
// Todo upsert do PostgREST vira INSERT ... ON CONFLICT DO UPDATE, e o SET lê
// `excluded.lat` — leitura exige privilégio de SELECT na coluna. A migração
// 0069 tinha revogado SELECT de lat/lng/heading para `authenticated`, então
// desde 30/08 toda tentativa de ficar Online morria em 42501. A 0080 devolve
// esse SELECT; a política de RLS voltou a ser a única camada de proteção.
//
// NÃO MUDA NADA — só lê e imprime.
//
// Como rodar (VOCÊ roda; a IA nunca tem a service_role key):
//   deno run --allow-env --allow-net --allow-read --node-modules-dir=auto \
//     supabase/scripts/verifica_online_pos_0080.ts

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { load } from 'jsr:@std/dotenv';

try {
  await load({ envPath: new URL('./.env', import.meta.url).pathname, export: true });
} catch {
  // .env ausente — segue com o que estiver no ambiente
}

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

/** Quando a 0080 foi aplicada em produção. Escrita depois disto é o que interessa. */
const APLICACAO_0080 = new Date('2026-09-02T00:00:00Z');

function line(s = '') { console.log(s); }

function idade(iso: string | null): string {
  if (!iso) return '⟨sem updated_at⟩';
  const ms = Date.now() - new Date(iso).getTime();
  const min = ms / 60000;
  if (min < 60) return `${min.toFixed(0)} min atrás`;
  const h = min / 60;
  if (h < 48) return `${h.toFixed(1)} h atrás`;
  return `${(h / 24).toFixed(1)} dias atrás`;
}

interface LocRow {
  driver_id: string;
  lat: number | null;
  lng: number | null;
  heading: number | null;
  is_online: boolean | null;
  updated_at: string | null;
}

async function main() {
  line('════════════════════════════════════════════════════════');
  line(' verifica_online_pos_0080 — relatório (NÃO MUDA NADA)');
  line('════════════════════════════════════════════════════════');

  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error('Faltam SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY (veja supabase/scripts/.env).');
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY.trim());

  const { data, error } = await admin
    .from('driver_locations')
    .select('driver_id, lat, lng, heading, is_online, updated_at')
    .order('updated_at', { ascending: false });
  if (error) throw new Error(`Falha ao ler driver_locations: ${error.message}`);

  const linhas = (data as LocRow[]) ?? [];
  line(`Linhas em driver_locations: ${linhas.length}\n`);
  if (linhas.length === 0) {
    line('Tabela vazia. Nenhum motorista jamais publicou posição — nada a concluir.');
    return;
  }

  const ids = linhas.map((l) => l.driver_id);
  const { data: profData, error: profErr } = await admin
    .from('profiles')
    .select('id, full_name')
    .in('id', ids);
  if (profErr) throw new Error(`Falha ao ler profiles: ${profErr.message}`);
  const nome = new Map((profData as { id: string; full_name: string | null }[] ?? [])
    .map((p) => [p.id, p.full_name ?? '⟨sem nome⟩']));

  let depoisDa0080 = 0;
  let onlineAgora = 0;

  for (const l of linhas) {
    const t = l.updated_at ? new Date(l.updated_at) : null;
    const nova = !!t && t >= APLICACAO_0080;
    if (nova) depoisDa0080++;
    if (l.is_online) onlineAgora++;
    const temPos = l.lat !== null && l.lng !== null;
    line('──────────────────────────────────────────────────────');
    line(`  motorista:   ${nome.get(l.driver_id) ?? '⟨sem perfil⟩'}`);
    line(`  driver_id:   ${l.driver_id}`);
    line(`  is_online:   ${l.is_online === null ? '⟨NULL⟩' : l.is_online}`);
    line(`  posição:     ${temPos ? `${l.lat}, ${l.lng}  (heading ${l.heading ?? '—'})` : '⟨sem lat/lng⟩'}`);
    line(`  updated_at:  ${l.updated_at ?? '⟨NULL⟩'}   ${idade(l.updated_at)}`);
    line(`  → escrita depois da 0080? ${nova ? 'SIM ✅' : 'não'}`);
  }

  line('\n──────────────────────────────────────────────────────');
  line('Veredito:');
  line(`  linhas escritas DEPOIS da 0080: ${depoisDa0080} de ${linhas.length}`);
  line(`  marcadas is_online agora:       ${onlineAgora}`);
  line('');
  if (depoisDa0080 > 0) {
    line('  ✅ Pelo menos um cliente autenticado gravou depois da 0080.');
    line('     A escrita de posição voltou a funcionar em produção.');
  } else {
    line('  ⚠️  Nenhuma escrita depois da 0080. Isso é AMBÍGUO:');
    line('     ou ninguém abriu o app como motorista desde então (mais');
    line('     provável, já que a frota é pequena), ou o conserto não bastou.');
    line('     Para desempatar: ligue a chave Online no app e rode isto de novo.');
  }
  line('');
  line('Nenhuma alteração foi feita.');
}

main().catch((e) => {
  console.error(`\n✗ ABORTADO: ${String(e?.message ?? e)}`);
  Deno.exit(1);
});
