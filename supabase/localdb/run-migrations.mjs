#!/usr/bin/env node
/*
 * Constrói o banco do GoXL do ZERO num Postgres LOCAL e descartável, e depois
 * confere o que construiu. Cinco passos, nesta ordem:
 *
 *   1. 00_supabase_bootstrap.sql — o dublê do Supabase (auth, storage, cron…).
 *   2. supabase/schema.sql — o snapshot histórico, com o override que ele
 *      documenta. Nenhuma migration cria `profiles` ou `rides`; sem este passo
 *      não há de onde partir.
 *   3. Ajustes de baseline — o snapshot é POSTERIOR a algumas migrations e já
 *      traz objetos que elas criam. Sem desfazer isso, elas colidem com o
 *      próprio futuro delas. Cada ajuste é impresso com o motivo.
 *   4. supabase/migrations/ — todas, em ordem de nome.
 *   5. 99_verificacao.sql — assevera o estado final. "Aplicou sem erro" e "está
 *      no estado pretendido" são coisas diferentes: a 0012 aplicou por anos sem
 *      surtir efeito nenhum.
 *
 * Cada migration roda dentro de UMA transação, que é como o `supabase db push`
 * se comporta — e é a razão de nenhuma delas usar `create index concurrently`
 * (proibido em transação; as migrations 0066, 0068 e 0069 dizem isso em
 * comentário). Rodar fora de transação aqui daria um resultado mais fácil e
 * menos parecido com produção.
 *
 * Instalação (uma vez, FORA do repositório — são ~130 MB de binário):
 *   mkdir -p ~/.goxl-localdb && cd ~/.goxl-localdb && npm init -y
 *   npm install embedded-postgres@17.10.0-beta.17 pg
 *   BIN=node_modules/@embedded-postgres/darwin-arm64/native/bin
 *   $BIN/initdb -D data -U postgres --auth=trust --encoding=UTF8 --locale=C
 *   $BIN/pg_ctl -D data -l logfile -o "-p 54329 -k /tmp" start
 *
 * Uso:
 *   node run-migrations.mjs            # para no primeiro erro (padrão)
 *   node run-migrations.mjs --continue # segue e lista tudo (erros podem cascatear)
 *   node run-migrations.mjs --reset    # recria o banco antes
 *
 * Leia o cabeçalho de 00_supabase_bootstrap.sql antes de citar qualquer
 * resultado: este banco é um dublê do Supabase, não o Supabase.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';

// O driver mora na instalação de fora do repositório — o `pg` NÃO entra no
// package.json do app, que é bundle de React Native e não deve carregar um
// cliente de Postgres.
const exigir = createRequire(join(homedir(), '.goxl-localdb', 'package.json'));
const pg = exigir('pg');

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..', '..');
const MIGRATIONS = join(RAIZ, 'supabase', 'migrations');

const CONN = {
  host: process.env.PGHOST || '/tmp',
  port: Number(process.env.PGPORT || 54329),
  user: process.env.PGUSER || 'postgres',
  database: process.env.PGDATABASE || 'goxl',
};

const seguir = process.argv.includes('--continue');
const resetar = process.argv.includes('--reset');

/*
 * AJUSTES DE BASELINE — a ponte entre o snapshot híbrido e a ordem histórica.
 *
 * `schema.sql` não é o estado anterior à 0001: é um snapshot TIRADO DEPOIS,
 * que já traz objetos criados por migrations posteriores. Aplicá-lo e em
 * seguida rodar 0001→0072 faz as migrations colidirem com o próprio futuro
 * delas. Este passo desfaz essa antecipação, um objeto por vez.
 *
 * Nada aqui é aplicado em silêncio: cada ajuste é impresso no relatório com o
 * motivo. Um deles (o da view) faz uma migration DEFEITUOSA aparecer como OK, e
 * é por isso que o motivo tem de estar à vista — sem ele, este arquivo mentiria
 * por omissão, que é o defeito exato que esta auditoria existe para não cometer.
 */
const AJUSTES_DE_BASELINE = [
  {
    sql: 'drop policy if exists "Usuário cria o próprio perfil" on public.profiles;',
    motivo:
      'O snapshot é posterior à 0002 e já traz a policy que ela cria. Removê-la ' +
      'devolve a 0002 ao seu lugar na história; sem isso ela aborta com 42710.',
  },
  {
    sql: 'drop table if exists public.messages;',
    motivo:
      'Mesmo caso, com a 0005: o snapshot já traz a tabela `messages`, as duas ' +
      'policies dela e a inclusão na publicação de realtime.',
  },
  {
    sql: 'drop view if exists public.rides_with_locations;',
    motivo:
      'ATENÇÃO — este é o único ajuste que muda o VEREDITO de uma migration. Com a ' +
      'view presente, a 0012 aborta (P0-12: `create or replace view` não insere ' +
      'coluna no meio da lista). Sem ela, a 0012 CRIA a view e aparece como OK no ' +
      'relatório abaixo. A 0012 continua defeituosa; quem conserta o banco de ' +
      'produção é a 0072, não este ajuste.',
  },
];

/**
 * Remove o que o Postgres puro não consegue executar — e DEVOLVE o que removeu.
 *
 * Nada some em silêncio: cada linha retirada é impressa no relatório. Um
 * strip silencioso transformaria "a migration passou" numa meia verdade, que é
 * o defeito exato que esta auditoria existe para não cometer.
 */
/*
 * Aqui existia um remendo que enxertava `driver_code` no meio do schema.sql: a
 * view profiles_public seleciona a coluna, e o `create table public.profiles`
 * não a declarava, então o snapshot não chegava ao fim nem com o override que
 * ele próprio documenta. O remendo foi removido porque o defeito foi corrigido
 * na ORIGEM — a coluna agora está no schema.sql, com o motivo ao lado dela.
 *
 * O que ele revelou continua registrado em AUDITORIA §4, P1 nº 0: a 0007 indexa
 * profiles(driver_code) 42 migrations antes de a 0049 criar a coluna, o que só
 * é possível se em produção ela tiver sido criada à mão.
 */

function prepararSql(sql) {
  const removidas = [];
  const linhas = sql.split('\n').map((linha) => {
    // Comentário é conteúdo, não comando: não se mexe nele. Sem esta saída
    // antecipada, um comentário que MENCIONA `create extension pg_cron` era
    // contado como remoção e poluía o relatório com um falso positivo.
    if (/^\s*--/.test(linha)) return linha;

    // Meta-comandos do psql (só o schema.sql tem): o driver não os entende.
    if (/^\s*\\/.test(linha)) {
      removidas.push({ motivo: 'meta-comando psql', linha: linha.trim() });
      return '';
    }
    // `\gset` vem grudado no FIM da linha, não no começo.
    if (/\\gset\s*$/.test(linha)) {
      removidas.push({ motivo: 'meta-comando psql (\\gset ao fim da linha)', linha: linha.trim() });
      return linha.replace(/\\gset\s*$/, ';');
    }
    // pg_cron e pg_net não existem aqui; os dublês do bootstrap fazem o papel.
    if (/create\s+extension\s+(if\s+not\s+exists\s+)?"?(pg_cron|pg_net)"?/i.test(linha)) {
      removidas.push({ motivo: 'extensão indisponível (dublê no bootstrap)', linha: linha.trim() });
      return '';
    }
    return linha;
  });
  return { sql: linhas.join('\n'), removidas };
}

async function aplicar(cliente, rotulo, sqlBruto, { transacao = true, ajustes = [] } = {}) {
  const { sql, removidas } = prepararSql(sqlBruto);
  const base = { rotulo, removidas, ajustes };
  try {
    if (transacao) await cliente.query('begin');
    await cliente.query(sql);
    if (transacao) await cliente.query('commit');
    return { ...base, ok: true };
  } catch (e) {
    if (transacao) await cliente.query('rollback').catch(() => {});
    return {
      ...base,
      ok: false,
      erro: { mensagem: e.message, codigo: e.code, detalhe: e.detail, dica: e.hint, posicao: e.position },
    };
  }
}

async function recriarBanco() {
  const admin = new pg.Client({ ...CONN, database: 'postgres' });
  await admin.connect();
  await admin.query(`drop database if exists ${CONN.database} with (force)`);
  await admin.query(`create database ${CONN.database}`);
  await admin.end();
  console.log(`banco ${CONN.database} recriado\n`);
}

async function main() {
  if (resetar) await recriarBanco();

  const cliente = new pg.Client(CONN);
  await cliente.connect();

  const resultados = [];

  // 1) Dublê do Supabase.
  resultados.push(
    await aplicar(cliente, '00_supabase_bootstrap.sql', readFileSync(join(AQUI, '00_supabase_bootstrap.sql'), 'utf8'))
  );

  // 2) Schema histórico. Nenhuma migration cria `public.profiles` nem
  //    `public.rides` — o schema base só existe neste snapshot. O override é o
  //    que o próprio arquivo documenta para banco descartável; ele nasce com os
  //    buracos de `anon` abertos, e as migrations 0048/0050/0067 é que fecham.
  //    Reproduzir isso é de propósito: é o histórico real de produção.
  await cliente.query(`set goxl.allow_legacy_schema_sql = 'yes-i-know-this-reopens-anon-holes'`);
  resultados.push(
    await aplicar(
      cliente,
      'schema.sql (snapshot histórico)',
      readFileSync(join(RAIZ, 'supabase', 'schema.sql'), 'utf8')
    )
  );

  // 3) Ajustes de baseline: desfaz o que o snapshot antecipou das migrations.
  resultados.push(
    await aplicar(cliente, 'ajustes de baseline', AJUSTES_DE_BASELINE.map((a) => a.sql).join('\n'), {
      ajustes: AJUSTES_DE_BASELINE,
    })
  );

  // 4) As migrations, em ordem.
  const arquivos = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  for (const arquivo of arquivos) {
    const anterior = resultados[resultados.length - 1];
    if (!anterior.ok && !seguir) break;
    resultados.push(await aplicar(cliente, arquivo, readFileSync(join(MIGRATIONS, arquivo), 'utf8')));
  }

  // 5) Verificação do estado final. Só roda se tudo acima aplicou: asseverar
  //    sobre um banco construído pela metade produz erro sem significado.
  //    São três, e elas provam coisas diferentes: a 97 grava como o motorista
  //    grava (o privilégio e a RLS de ESCRITA), a 98 ataca o banco com um
  //    usuário de verdade (o EFEITO das regras), a 99 confere a FORMA delas.
  const tudoOk = resultados.every((r) => r.ok);
  if (tudoOk) {
    // A 97 prova a ESCRITA (o motorista consegue publicar posição sob os grants
    // reais?), a 98 prova o EFEITO das regras sob ataque, a 99 confere a FORMA
    // delas. As três provam coisas diferentes e nenhuma cobre a outra.
    for (const verificacao of ['95_passageiro_nao_comeca_viagem.sql', '96_trava_versao_minima.sql', '97_escrita_driver_locations.sql', '98_rls_comportamento.sql', '99_verificacao.sql']) {
      resultados.push(await aplicar(cliente, verificacao, readFileSync(join(AQUI, verificacao), 'utf8')));
    }
  }

  await cliente.end();

  // ─── Relatório ────────────────────────────────────────────────────────────
  const oks = resultados.filter((r) => r.ok);
  const falhas = resultados.filter((r) => !r.ok);

  for (const r of resultados) {
    console.log(`${r.ok ? 'OK  ' : 'FALHA'} ${r.rotulo}`);
    for (const rem of r.removidas) console.log(`      · removido (${rem.motivo}): ${rem.linha}`);
    for (const a of r.ajustes) console.log(`      · ${a.sql}\n        motivo: ${a.motivo}`);
    if (!r.ok) {
      console.log(`      erro ${r.erro.codigo}: ${r.erro.mensagem}`);
      if (r.erro.detalhe) console.log(`      detalhe: ${r.erro.detalhe}`);
      if (r.erro.dica) console.log(`      dica: ${r.erro.dica}`);
    }
  }

  console.log(`\n${oks.length} aplicadas, ${falhas.length} falharam, ${arquivos.length} migrations no diretório`);
  if (falhas.length && seguir) {
    console.log('AVISO: com --continue, uma falha pode ser só consequência da anterior.');
  }
  process.exit(falhas.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
