// set_profile_jurisdiction.ts — atribui `jurisdiction` a um conjunto de perfis
// (passageiros e/ou motoristas), para o rollout gradual do dispatch_engine_v2
// por região-piloto (ver migration 0055_profile_jurisdiction.sql).
//
// Por que existe:
//   `profiles.jurisdiction` é protegida por trigger (guard_profile_privileged_fields)
//   contra auto-edição — só service_role pode alterá-la. Não existe UI de admin
//   para isso ainda, então este script é a forma oficial de o admin (você)
//   definir a jurisdição de um piloto.
//
// IMPORTANTE — consistência piloto (ler antes de rodar):
//   Um passageiro e um motorista só "se enxergam" no motor v2 se tiverem a
//   MESMA jurisdiction (a config `dispatch_engine_v2` é resolvida por
//   jurisdiction no lado de quem chama). Se você marcar só os motoristas de
//   uma região com `fl_orlando_pilot` mas deixar os passageiros em `global`,
//   as corridas desses passageiros continuarão indo pelo fluxo legado — o que
//   é seguro, mas não testa o motor novo. Para testar de verdade, marque
//   AMBOS os lados (passageiros de teste + motoristas de teste) com a mesma
//   jurisdiction, e ative os flags (`dispatch_multi_offer_fix`,
//   `dispatch_engine_v2`) para essa jurisdiction em `system_config`.
//
// Segurança de execução:
//   • DRY-RUN por padrão: sem `--yes` só RELATA o que faria, sem mudar nada.
//   • Só aceita e-mails explícitos (nunca "todos os perfis") — evita marcar
//     gente errada por engano.
//   • Idempotente: rodar de novo com o mesmo `--jurisdiction` não muda nada
//     se já estiver aplicado.
//
// Como rodar (você roda; a IA nunca tem a service_role key):
//
//   OPÇÃO A (mais fácil) — arquivo local, git-ignorado:
//     1) copie supabase/scripts/.env.example para supabase/scripts/.env
//        (se ainda não tiver feito isso para os outros scripts)
//     2) abra supabase/scripts/.env num editor de texto e cole os valores
//        reais de SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY
//     3) deno run --allow-env --allow-net --allow-read --node-modules-dir=auto \
//          supabase/scripts/set_profile_jurisdiction.ts \
//          --jurisdiction=fl_orlando_pilot \
//          --emails=motorista1@x.com,motorista2@x.com,passageiro1@x.com
//
//   OPÇÃO B — variáveis de ambiente na sessão do terminal:
//     export SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=...
//     deno run --allow-env --allow-net --node-modules-dir=auto \
//       supabase/scripts/set_profile_jurisdiction.ts \
//       --jurisdiction=fl_orlando_pilot --emails=a@x.com,b@x.com
//
//   # relatório (não muda nada — padrão):
//   ... --jurisdiction=fl_orlando_pilot --emails=a@x.com
//   # aplicar de verdade:
//   ... --jurisdiction=fl_orlando_pilot --emails=a@x.com --yes
//   # reverter alguém para o padrão global:
//   ... --jurisdiction=global --emails=a@x.com --yes

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { load } from 'jsr:@std/dotenv';

// Carrega supabase/scripts/.env se existir (Opção A). Se não existir, segue
// só com o que já estiver no ambiente (Opção B) — não é erro em nenhum caso.
try {
  await load({ envPath: new URL('./.env', import.meta.url).pathname, export: true });
} catch {
  // arquivo .env ausente — normal se o usuário optou pela Opção B.
}

interface ProfileRow {
  id: string;
  email: string | null;
  type: 'passenger' | 'driver' | string;
  name: string | null;
  jurisdiction: string;
}

const APPLY = Deno.args.includes('--yes') || Deno.args.includes('-y');

const jurisdictionArg = Deno.args.find((a) => a.startsWith('--jurisdiction='));
const JURISDICTION = jurisdictionArg ? jurisdictionArg.split('=')[1]?.trim() : '';

const emailsArg = Deno.args.find((a) => a.startsWith('--emails='));
const EMAILS = (emailsArg ? emailsArg.split('=').slice(1).join('=') : '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

function line(s = '') { console.log(s); }

// Slug simples: minúsculas, dígitos, underscore. Evita espaços/acentos que
// dificultariam bater com o valor usado nas linhas de system_config.
const JURISDICTION_SLUG_RE = /^[a-z0-9_]+$/;

async function main() {
  line('════════════════════════════════════════════════════════');
  line(' set_profile_jurisdiction — atribuição de região-piloto');
  line('════════════════════════════════════════════════════════');

  if (!JURISDICTION) {
    throw new Error('Faltou --jurisdiction=<slug> (ex.: --jurisdiction=fl_orlando_pilot).');
  }
  if (!JURISDICTION_SLUG_RE.test(JURISDICTION)) {
    throw new Error(
      `--jurisdiction inválido: "${JURISDICTION}". Use só minúsculas, dígitos e "_" (ex.: fl_orlando_pilot).`,
    );
  }
  if (!EMAILS.length) {
    throw new Error('Faltou --emails=a@x.com,b@x.com (lista explícita — não existe modo "todos").');
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    throw new Error('Faltam SUPABASE_URL e/ou SUPABASE_SERVICE_ROLE_KEY no ambiente.');
  }

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  line(APPLY ? '\n► MODO: APLICAR (--yes) — vai alterar dados.' : '\n► MODO: DRY-RUN — nada será alterado. Use --yes para aplicar.');
  line(`  jurisdiction alvo: "${JURISDICTION}"`);
  line(`  e-mails (${EMAILS.length}): ${EMAILS.join(', ')}`);

  // ── Levantamento: busca os perfis pelos e-mails informados ─────────────────
  const { data: rows, error: selErr } = await admin
    .from('profiles')
    .select('id, email, type, name, jurisdiction')
    .in('email', EMAILS);
  if (selErr) throw new Error(`Falha ao buscar perfis: ${selErr.message}`);

  const found = (rows as ProfileRow[]) ?? [];
  const foundEmails = new Set(found.map((p) => (p.email ?? '').toLowerCase()));
  const missing = EMAILS.filter((e) => !foundEmails.has(e));

  line('\n── Perfis encontrados ──────────────────────────────────');
  const passengers = found.filter((p) => p.type === 'passenger');
  const drivers = found.filter((p) => p.type === 'driver');
  for (const p of found) {
    const already = p.jurisdiction === JURISDICTION;
    line(`  [${p.type}] ${p.email ?? p.id} — atual: "${p.jurisdiction}"${already ? ' (já correto)' : ` → "${JURISDICTION}"`}`);
  }
  line(`\n  Total: ${found.length} (${passengers.length} passageiro(s), ${drivers.length} motorista(s))`);
  if (missing.length) {
    line(`  ! Não encontrados (verifique o e-mail): ${missing.join(', ')}`);
  }
  if (passengers.length === 0 || drivers.length === 0) {
    line(
      '\n  ⚠ Aviso: para testar o motor v2 de verdade, marque AMBOS os lados ' +
        '(ao menos 1 passageiro E 1 motorista) com a mesma jurisdiction — ver ' +
        'nota de consistência no topo deste arquivo.',
    );
  }

  const toUpdate = found.filter((p) => p.jurisdiction !== JURISDICTION);
  if (!toUpdate.length) {
    line('\nNada a fazer — todos os perfis encontrados já estão na jurisdiction alvo.');
    return;
  }

  if (!APPLY) {
    line(`\nDRY-RUN concluído. ${toUpdate.length} perfil(is) seriam atualizados. Rode de novo com --yes para aplicar.`);
    return;
  }

  // ── Aplica: só service_role passa pelo trigger guard_profile_privileged_fields ──
  const { error: updErr } = await admin
    .from('profiles')
    .update({ jurisdiction: JURISDICTION })
    .in('id', toUpdate.map((p) => p.id));
  if (updErr) throw new Error(`Falha ao atualizar: ${updErr.message}`);

  line(`\n✅ ${toUpdate.length} perfil(is) atualizado(s) para jurisdiction="${JURISDICTION}".`);
  line('\nPróximo passo: ativar os flags para essa jurisdiction em system_config, ex.:');
  line(`  insert into system_config (key, jurisdiction, value)`);
  line(`  values ('dispatch_multi_offer_fix', '${JURISDICTION}', 'true'::jsonb)`);
  line(`  on conflict (key, jurisdiction) do update set value = excluded.value;`);
}

main().catch((e) => {
  console.error(`\n✗ ABORTADO: ${String(e?.message ?? e)}`);
  Deno.exit(1);
});
