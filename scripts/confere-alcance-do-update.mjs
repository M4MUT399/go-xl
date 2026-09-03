#!/usr/bin/env node
/*
 * confere-alcance-do-update — o update publicado alcança ALGUMA build?
 *
 * ── POR QUE ISTO EXISTE ────────────────────────────────────────────────────
 *
 * `eas update` não falha quando publica para um runtimeVersion que build
 * nenhuma tem. Ele diz "published", imprime uma URL, e o conserto não chega a
 * aparelho nenhum. Esse silêncio é o modo de falha que o OTA foi instalado para
 * eliminar — seria irônico reintroduzi-lo por outra porta.
 *
 * A causa concreta: com a política `fingerprint`, o runtimeVersion é um hash do
 * projeto, e as chaves do Google Maps entram nele (o fingerprint carrega a
 * config PRIVADA). Elas vêm de env — `.env.local` no laptop, ambiente da EAS na
 * build. Publicar de um lugar com env diferente produz um runtime órfão.
 *
 * ── A REGRA DESTE SCRIPT: NA DÚVIDA, VERMELHO ─────────────────────────────
 *
 * A primeira versão dele tinha um defeito que o tornava pior que inútil: ela lia
 * `canal.currentPage` como se fosse uma LISTA de ramos. Não é — o eas-cli monta
 * `{ currentPage: { ...canal, updateBranches: [...] } }`, um OBJETO. O laço
 * nunca rodava, e o script imprimia "nenhum update publicado ainda" e saía com
 * 0. Um update órfão de verdade produzia exatamente a mesma saída verde.
 *
 * Por isso agora ele só sai com 0 se tiver de fato ENCONTRADO updates e todos
 * casarem. Não conseguir ler é VERMELHO, nunca verde.
 *
 * ── O QUE ELE NÃO FAZ ──────────────────────────────────────────────────────
 *
 * Não prova que o update funciona nem que algum aparelho o baixou — só que
 * existe build compatível. Condição necessária, não suficiente.
 *
 * E ele vê pouco: `eas channel:view` devolve no máximo o grupo de update MAIS
 * RECENTE de cada ramo. Não é varredura do histórico; é conferência do último
 * publicado, que é justamente o que interessa logo depois de publicar.
 *
 * Uso:
 *   node scripts/confere-alcance-do-update.mjs [canal]     (padrão: production)
 *   npm run update:confere
 */
import { execFileSync } from 'node:child_process';

const CANAL = process.argv[2] ?? 'production';
/**
 * Builds a considerar. 50 é o TETO do `eas build:list` ("--limit must be between
 * 1 and 50", medido). Janela estreita transforma build viva em "órfã" falsa, e
 * como não dá para pedir mais numa chamada, o aviso de saturação abaixo existe
 * para você não confiar num vermelho que talvez seja só falta de alcance.
 */
const JANELA_DE_BUILDS = 50;

function eas(args) {
  try {
    const saida = execFileSync('npx', ['eas', ...args, '--json', '--non-interactive'], {
      encoding: 'utf8',
      // stderr vai para 'pipe' e é mostrado só em caso de erro: é lá que o
      // eas-cli escreve o motivo de verdade ("Could not find channel with the
      // name production"). Engolir o diagnóstico numa ferramenta cujo único
      // produto é diagnóstico seria defeito de projeto.
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, dados: JSON.parse(saida) };
  } catch (e) {
    const detalhe = String(e?.stderr ?? '').trim() || String(e?.message ?? e).split('\n')[0];
    return { ok: false, erro: detalhe };
  }
}

function linha(s = '') { console.log(s); }

linha('════════════════════════════════════════════════════════');
linha(` alcance do update — canal "${CANAL}"`);
linha('════════════════════════════════════════════════════════\n');

// ── 1. runtimeVersion das builds DESTE canal ───────────────────────────────
const rBuilds = eas(['build:list', '--limit', String(JANELA_DE_BUILDS)]);
if (!rBuilds.ok) {
  console.error(`✗ não consegui listar as builds:\n${rBuilds.erro}`);
  process.exit(1);
}

const todas = rBuilds.dados.filter((b) => b.status === 'FINISHED');
// O canal importa: uma build de `preview` compartilhando runtimeVersion não
// torna um update de `production` entregue a passageiro nenhum.
const doCanal = todas.filter((b) => b.channel === CANAL && b.runtimeVersion);
const semRuntime = todas.filter((b) => !b.runtimeVersion).length;

linha(`builds concluídas na janela         : ${todas.length} (limite ${JANELA_DE_BUILDS})`);
linha(`  no canal "${CANAL}" com runtimeVersion : ${doCanal.length}`);
linha(`  sem runtimeVersion                : ${semRuntime}  (anteriores ao expo-updates — nunca recebem OTA)`);
linha('');

if (todas.length === JANELA_DE_BUILDS) {
  linha(`⚠️  a janela de ${JANELA_DE_BUILDS} builds está saturada; uma build viva mais antiga`);
  linha('    pode estar fora daqui e ser chamada de órfã por engano. Aumente JANELA_DE_BUILDS.');
  linha('');
}

if (doCanal.length === 0) {
  linha(`Nenhuma build no canal "${CANAL}" tem runtimeVersion.`);
  linha('Enquanto isso for verdade, QUALQUER update publicado aqui alcança');
  linha('ZERO aparelhos. É preciso publicar antes uma build com o');
  linha('expo-updates embarcado e o canal declarado no eas.json.');
  process.exit(2);
}

const runtimesDeBuild = new Set(doCanal.map((b) => b.runtimeVersion));
for (const rv of runtimesDeBuild) {
  linha(`  ${rv}`);
  for (const b of doCanal.filter((x) => x.runtimeVersion === rv)) {
    linha(`      ← ${b.platform} ${b.appVersion} (${b.appBuildVersion})`);
  }
}
linha('');

// ── 2. updates do canal ────────────────────────────────────────────────────
const rCanal = eas(['channel:view', CANAL]);
if (!rCanal.ok) {
  console.error(`✗ não consegui ler o canal "${CANAL}":\n${rCanal.erro}`);
  console.error('  (o canal só passa a existir depois da primeira build que o declara)');
  process.exit(1);
}

// FORMATO REAL (eas-cli build/channel/queries.js): o comando imprime
// `{ currentPage: { ...canal, updateBranches: [...] } }`. `currentPage` é
// OBJETO, não lista — foi exatamente aqui que a versão anterior deu verde falso.
const canal = rCanal.dados?.currentPage;
const ramos = canal?.updateBranches;

if (!Array.isArray(ramos)) {
  console.error('✗ não reconheci o formato de `eas channel:view --json`.');
  console.error('  Esperava `currentPage.updateBranches` como lista; veio:');
  console.error(`  ${JSON.stringify(rCanal.dados).slice(0, 400)}`);
  console.error('  NÃO estou dizendo que está tudo bem — estou dizendo que não sei.');
  process.exit(1);
}

const updates = [];
for (const r of ramos) {
  for (const grupo of r.updateGroups ?? []) {
    for (const u of Array.isArray(grupo) ? grupo : [grupo]) {
      updates.push({ rv: u.runtimeVersion, msg: u.message, plataforma: u.platform, ramo: r.name });
    }
  }
  for (const u of r.updates ?? []) {
    updates.push({ rv: u.runtimeVersion, msg: u.message, plataforma: u.platform, ramo: r.name });
  }
}

if (updates.length === 0) {
  linha(`Nenhum update encontrado no canal "${CANAL}" (${ramos.length} ramo(s) lidos).`);
  linha('Se você ACABOU de publicar, isto é um problema — não uma boa notícia.');
  process.exit(2);
}

let orfaos = 0;
linha(`updates encontrados (o mais recente de cada ramo): ${updates.length}`);
for (const u of updates) {
  const alcanca = runtimesDeBuild.has(u.rv);
  if (!alcanca) orfaos++;
  linha(`  ${alcanca ? '✅' : '✗ ÓRFÃO'}  ${u.plataforma ?? '—'}  rv=${u.rv}  ramo=${u.ramo}  ${String(u.msg ?? '').slice(0, 40)}`);
}
linha('');

if (orfaos > 0) {
  linha(`✗ ${orfaos} update(s) publicados para um runtimeVersion que nenhuma build`);
  linha(`  do canal "${CANAL}" tem. Não vão chegar a aparelho nenhum, e não`);
  linha('  houve erro ao publicar.');
  linha('  Causa provável: publicado sem `--environment production`, então as');
  linha('  variáveis diferiram das da build e o hash mudou.');
  linha('  Republique com `npm run update:producao`.');
  process.exit(1);
}

linha(`✅ Os ${updates.length} update(s) LIDOS correspondem a alguma build do canal "${CANAL}".`);
linha('   Isso é compatibilidade, não entrega — e cobre só o mais recente de');
linha('   cada ramo, que é o que o eas-cli devolve.');
