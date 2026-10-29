import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * Amarra o portão do cron (SQL, migration 0071) ao `ACTIVE_DISPATCH` da Edge
 * Function (TypeScript). São dois arquivos que precisam listar exatamente os
 * mesmos estados e que nada mais obriga a andar juntos:
 *
 *   • se o SQL listar A MENOS que o TS, o cron não acorda a função para um
 *     estado que o motor considera ativo — o pedido congela naquele estado, sem
 *     erro, sem log, sem oferta;
 *   • se listar A MAIS, a função é acordada para pedidos que `loadState` nem
 *     carrega — desperdício, e um sinal de que alguém mexeu num lado só.
 *
 * A asserção Z.4 dentro da própria 0071 NÃO cobre isto: o Postgres não lê
 * `index.ts`, e migration roda uma vez. Este teste roda a cada `npx jest`.
 */

const ROOT = join(__dirname, '..', '..', '..');
const ENGINE = join(ROOT, 'supabase', 'functions', 'dispatch-engine', 'index.ts');
const MIGRATION = join(ROOT, 'supabase', 'migrations', '0071_dispatch_tick_cron.sql');
const SCHEMA = join(ROOT, 'supabase', 'migrations', '0054_dispatch_engine_v2.sql');

function statesFromTypeScript(): string[] {
  const src = readFileSync(ENGINE, 'utf8');
  const decl = /const\s+ACTIVE_DISPATCH\s*=\s*\[([^\]]*)\]/.exec(src);
  if (!decl) throw new Error(`ACTIVE_DISPATCH não encontrado em ${ENGINE}`);
  return [...decl[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/**
 * Extrair a lista do portão passou por três versões, e as duas primeiras eram
 * sequestráveis. Vale registrar por quê, porque a terceira só se justifica
 * contra o defeito das anteriores:
 *
 *   1ª — `/where exists\s*\([\s\S]*?status in \(([^)]*)\)/`: casava a partir do
 *        `where exists (select 1 from cron.job ...)` do `unschedule`, 49 linhas
 *        ANTES do portão. Acertava a lista por acidente de ordenação.
 *   2ª — ancorada em `from public.trip_requests ... where status in (...)`, com
 *        `.exec`. Melhor, e ainda assim sequestrável por UMA LINHA: `.exec`
 *        devolve o PRIMEIRO match e nada verificava que ele era único. Uma
 *        linha de comentário de diagnóstico para operador — no mesmo formato
 *        que o arquivo JÁ usa em `0071:396` — inserida antes do portão passa a
 *        ser a lista lida, e o portão de verdade pode então virar
 *        `('REQUESTED','COMPLETED')` (ofertas nunca mais expiram, cron acorda
 *        para sempre por um estado terminal) com os 4 testes VERDES.
 *   3ª — a unicidade acima passou a valer DENTRO do corpo, mas o corpo em si
 *        continuava vindo de um `.exec`: o PRIMEIRO `cron.schedule` com o
 *        jobname 'dispatch-engine-tick'. `cron.schedule(jobname, ...)` é UPSERT
 *        por jobname — quem vale é o ÚLTIMO. Bastava um `cron.schedule` isca
 *        antes do real (com a lista honesta) para o teste ler a isca enquanto o
 *        Postgres executa o de baixo. A asserção Z.4 da própria 0071 também não
 *        pega: ela é `like '%''REQUESTED'',''MATCHING'',''OFFERING''%'`, uma
 *        SUBSTRING — acrescentar estados ao fim do `in (...)` a mantém verde.
 *
 * Daí as quatro defesas abaixo, cada uma fechando um caminho distinto:
 *   (a) comentários somem antes de casar — a isca não pode ser um comentário;
 *   (b) o casamento acontece DENTRO do corpo do `cron.schedule` de
 *       'dispatch-engine-tick' — a isca não pode ser fora do agendamento;
 *   (c) o CORPO tem de ser único — dois `cron.schedule` com o mesmo jobname
 *       falham alto, em vez de o teste ler um e o Postgres honrar o outro;
 *   (d) o portão dentro do corpo tem de ser único, pelo mesmo motivo.
 *
 * `/i`, o alias opcional (com ou sem `as`) e a tag de dólar nomeada existem
 * porque `pg_format`, `trip_requests as tr ... where tr.status` e `$job$...$job$`
 * derrubavam os testes por formatação, sem nada de errado no SQL.
 *
 * A forma `status = any(array[...])` NÃO é aceita, de propósito: ampliar a regex
 * amplia também a superfície de sequestro, e essa reescrita faz o teste falhar
 * ALTO com mensagem acionável — que é o desfecho certo para uma mudança que
 * merece um par de olhos.
 */
function agendamentoDoTick(sql: string): { inteiro: string; corpo: string } {
  const semComentarios = sql.replace(/--[^\n]*/g, '');
  const corpos = [
    ...semComentarios.matchAll(
      /cron\.schedule\(\s*'dispatch-engine-tick'[\s\S]*?\$(\w*)\$([\s\S]*?)\$\1\$/g,
    ),
  ];
  if (corpos.length !== 1) {
    throw new Error(
      `esperado exatamente 1 \`cron.schedule('dispatch-engine-tick', ...)\` — pg_cron faz upsert por jobname, então N agendamentos significam que o teste lê um e o banco honra outro. Achei ${corpos.length} em ${MIGRATION}`,
    );
  }
  return { inteiro: corpos[0][0], corpo: corpos[0][2] };
}

/**
 * A lista de estados é só METADE do contrato do tick. Enquanto nada olhava o
 * resto do agendamento, duas mutações de UMA PALAVRA na 0071 deixavam a suíte
 * inteira verde e desligavam o despacho em produção:
 *
 *   • `'10 seconds'` → `'0 3 * * *'`: o motor passa a rodar uma vez por dia, às
 *     3 da manhã. Nenhum passageiro é atendido, e o portão de estados continua
 *     perfeitamente correto — ele só nunca é consultado;
 *   • a URL → `.../dispatch-engine-old`: todo tick bate em 404, para sempre.
 *     `net.http_post` é assíncrono e não levanta erro no cron, então isso é
 *     silencioso dos dois lados.
 *
 * Ambos passam por cima do `agendamentoDoTick`, que garante que estamos lendo o
 * agendamento que o Postgres de fato honra.
 */
function cadenciaDoTick(sql: string = readFileSync(MIGRATION, 'utf8')): string {
  const { inteiro } = agendamentoDoTick(sql);
  const m = /'dispatch-engine-tick'\s*,\s*'([^']*)'/.exec(inteiro);
  if (!m) throw new Error(`não achei a cadência do tick em ${MIGRATION}`);
  // Só a forma `N seconds` é aceita. Uma expressão cron de cinco campos tem
  // resolução MÍNIMA de um minuto — qualquer uma delas, mesmo `* * * * *`, já é
  // seis vezes mais lenta que o intervalo de hoje.
  if (!/^\d+ seconds$/.test(m[1])) {
    throw new Error(
      `cadência do tick não está em segundos em ${MIGRATION}: ${JSON.stringify(m[1])}. Expressão cron tem resolução mínima de 1 minuto e faria o despacho parar de responder em tempo de corrida.`,
    );
  }
  return m[1];
}

function urlDoTick(sql: string = readFileSync(MIGRATION, 'utf8')): string {
  const { corpo } = agendamentoDoTick(sql);
  const urls = [...corpo.matchAll(/url\s*:?=\s*'([^']*)'/gi)];
  if (urls.length !== 1) {
    throw new Error(
      `esperado exatamente 1 \`url := '...'\` no corpo do tick, achei ${urls.length} em ${MIGRATION}`,
    );
  }
  return urls[0][1];
}

/** Teto da cadência. Ver o comentário do teste que o usa. */
const CADENCIA_MAXIMA_S = 15;

/**
 * O resto do contrato de TRANSPORTE do tick. Estados, cadência e URL já não
 * eram amarrados por nada e passaram a ser; estes três seguem a mesma lógica —
 * cada um desliga o despacho inteiro, em silêncio, com a mudança de uma palavra:
 *
 *   • `action` fora do que o motor atende: `index.ts` responde 400 "ação
 *     desconhecida" e nunca despacha;
 *   • segredo do Vault ou esquema errado no `Authorization`: 401 eterno;
 *   • um `cron.unschedule` DEPOIS do `cron.schedule`: o job simplesmente não
 *     existe ao fim da migration.
 *
 * `net.http_post` é assíncrono e não levanta erro no cron: nos três casos não há
 * exceção, não há log de migration, e o portão de estados continua correto — só
 * nunca é consultado.
 */
function acaoDoTick(sql: string = readFileSync(MIGRATION, 'utf8')): string {
  const { corpo } = agendamentoDoTick(sql);
  const body = /body\s*:?=\s*'([^']*)'/i.exec(corpo);
  if (!body) throw new Error(`não achei o \`body := '...'\` do tick em ${MIGRATION}`);
  const acao = /"action"\s*:\s*"([^"]+)"/.exec(body[1]);
  if (!acao) throw new Error(`o corpo do tick não traz "action" em ${MIGRATION}: ${body[1]}`);
  return acao[1];
}

function autorizacaoDoTick(sql: string = readFileSync(MIGRATION, 'utf8')): {
  esquema: string;
  segredo: string;
} {
  const { corpo } = agendamentoDoTick(sql);
  const esquema = /'Authorization'\s*,\s*'([^']*)'/i.exec(corpo);
  const segredo = /decrypted_secrets\s+where\s+name\s*=\s*'([^']+)'/i.exec(corpo);
  if (!esquema || !segredo) {
    throw new Error(
      `o tick não se identifica com \`Authorization: Bearer <segredo do vault>\` em ${MIGRATION}`,
    );
  }
  return { esquema: esquema[1], segredo: segredo[1] };
}

/**
 * Os outros três crons do projeto. O nome do segredo no Vault é provisionado UMA
 * vez pelo operador, à mão, e os quatro crons têm de concordar sobre ele — daí
 * dar para checar o do tick contra os irmãos em vez de transcrever o literal
 * aqui. Que o segredo EXISTA no banco é PENDÊNCIA HUMANA: não há Postgres nesta
 * máquina e nenhum teste pode verificá-lo.
 */
const CRONS_IRMAOS = [
  '0035_weekly_payout_cron.sql',
  '0058_telematics_export_cron.sql',
  '0068_stale_requesting_sweep_cron.sql',
];

function segredosDosCronsIrmaos(): string[] {
  return CRONS_IRMAOS.map((arquivo) => {
    const sql = readFileSync(join(ROOT, 'supabase', 'migrations', arquivo), 'utf8');
    const m = /decrypted_secrets\s+where\s+name\s*=\s*'([^']+)'/i.exec(sql);
    if (!m) throw new Error(`nenhum segredo do vault em ${arquivo}`);
    return m[1];
  });
}

/**
 * A 0071 desagenda o tick ANTES de agendar, de propósito: é o que a torna
 * re-executável. Depois, não — `cron.unschedule` ali apaga tudo que veio acima e
 * deixa a migration verde.
 */
function desagendamentosDepoisDoAgendamento(
  sql: string = readFileSync(MIGRATION, 'utf8'),
): number {
  const semComentarios = sql.replace(/--[^\n]*/g, '');
  const { inteiro } = agendamentoDoTick(sql);
  const fim = semComentarios.indexOf(inteiro) + inteiro.length;
  return [
    ...semComentarios.slice(fim).matchAll(/cron\.unschedule\(\s*'dispatch-engine-tick'/g),
  ].length;
}

function statesFromCronGate(sql: string = readFileSync(MIGRATION, 'utf8')): string[] {
  const { corpo } = agendamentoDoTick(sql);

  const gates = [
    ...corpo.matchAll(
      /from\s+public\.trip_requests(?:\s+(?:as\s+)?(?!where\b)\w+)?\s+where\s+(?:\w+\.)?status\s+in\s*\(([^)]*)\)/gi,
    ),
  ];
  if (gates.length !== 1) {
    throw new Error(
      `esperado exatamente 1 portão \`from public.trip_requests ... where status in (...)\` no corpo do cron, achei ${gates.length} em ${MIGRATION}`,
    );
  }

  // A LISTA de estados não é o portão inteiro — o portão é o predicado. Enquanto
  // nada olhava o que vem DEPOIS do `in (...)`, um `and created_at > now() -
  // interval '1 hour'` acrescentado ali deixava os seis testes verdes e fazia o
  // cron parar de acordar a função para pedidos mais velhos que uma hora: eles
  // congelam em REQUESTED para sempre, sem erro e sem log — o mesmo desfecho que
  // esta suíte inteira existe para impedir, entrando por outra porta.
  //
  // A exigência é que o próximo caractere não-branco FECHE o `exists(`. Isso
  // reprova também coisas inofensivas como um `limit 1`, de propósito: o teste
  // falha ALTO e com mensagem acionável, que é o desfecho certo para uma mudança
  // no predicado do portão — ela merece um par de olhos, não silêncio.
  const gate = gates[0];
  const resto = corpo.slice((gate.index ?? 0) + gate[0].length);
  if (!/^\s*\)/.test(resto)) {
    throw new Error(
      `o portão do cron tem predicado ALÉM de \`status in (...)\` em ${MIGRATION}: ${JSON.stringify(resto.slice(0, 120))}. Filtrar por qualquer outra coisa congela pedidos que o motor considera ativos.`,
    );
  }
  return [...gate[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** Domínio real de `trip_requests.status`, lido da 0054 — não transcrito à mão. */
function statusDomain(): string[] {
  const sql = readFileSync(SCHEMA, 'utf8');
  const chk = /constraint\s+trip_requests_status_chk\s+check\s*\(status\s+in\s*\(([^)]*)\)/i.exec(sql);
  if (!chk) throw new Error(`trip_requests_status_chk não encontrado em ${SCHEMA}`);
  return [...chk[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/**
 * DIGITADO de propósito. Uma versão anterior calculava a lista como
 * `statusDomain() \ statesFromTypeScript()`, o que parecia mais robusto e era o
 * contrário: com essa definição o teste "as duas listas são idênticas" JÁ
 * IMPLICA o de estados fora do despacho, e acrescentar `'ACCEPTED'` aos DOIS
 * lados deixava a suíte inteira verde. Trocar transcrição independente por valor
 * derivado do próprio objeto sob teste é exatamente a circularidade que este
 * item existe para remover. Quem impede esta lista de apodrecer é o teste de
 * cobertura do domínio.
 *
 * "Fora do despacho", e não "terminal": `CANCELLED` e `NO_DRIVERS` de fato nunca
 * mais mudam, mas `ACCEPTED` e `ONGOING` são corridas VIVAS — só não são mais
 * assunto do motor de oferta.
 */
const FORA_DO_DESPACHO = ['ACCEPTED', 'ONGOING', 'CANCELLED', 'NO_DRIVERS'];

describe('portão do cron do dispatch (0071) × ACTIVE_DISPATCH (dispatch-engine)', () => {
  it('lê ACTIVE_DISPATCH do TypeScript e não vem vazio', () => {
    expect(statesFromTypeScript().length).toBeGreaterThan(0);
  });

  it('lê a lista de estados do portão do cron e não vem vazia', () => {
    expect(statesFromCronGate().length).toBeGreaterThan(0);
  });

  it('as duas listas são idênticas', () => {
    // Ordenadas: o que importa é o CONJUNTO, não a ordem em que cada lado escreve.
    expect([...statesFromCronGate()].sort()).toEqual([...statesFromTypeScript()].sort());
  });

  it('nenhum estado fora do despacho entrou no portão', () => {
    // Um `CANCELLED` aqui faria o cron acordar a Edge Function a cada 10 s,
    // para sempre, por causa de pedidos que nunca mais mudam de estado.
    expect(statesFromCronGate().filter((s) => FORA_DO_DESPACHO.includes(s))).toEqual([]);
  });

  it('todo estado do domínio da 0054 está coberto por um dos dois lados', () => {
    // O elo que mantém a lista digitada acima honesta. Um estado novo em
    // `trip_requests_status_chk` quebra aqui, forçando alguém a decidir
    // conscientemente de que lado ele fica — em vez de o estado novo
    // simplesmente não ser coberto por ninguém, em silêncio.
    //
    // COBERTURA, e não igualdade. A primeira versão era
    // `expect([...ativos, ...FORA].sort()).toEqual([...dominio].sort())`, e essa
    // igualdade IMPLICAVA os testes 1, 2, 4 e 6 acima: nenhum deles conseguia
    // mais falhar sozinho, e a suíte tinha seis testes com o poder de dois. A
    // direção que importa aqui é uma só — nada do domínio pode ficar de fora. O
    // sentido inverso (nenhum lado inventa estado que a tabela não tem) é assunto
    // do último teste, e agora os dois podem falhar de forma independente.
    const cobertos = new Set([...statesFromTypeScript(), ...FORA_DO_DESPACHO]);
    expect(statusDomain().filter((s) => !cobertos.has(s))).toEqual([]);
  });

  it('o tick acorda em segundos, não uma vez por dia', () => {
    // O portão de estados pode estar perfeito e o despacho ainda assim não
    // existir, se ninguém for consultá-lo. O teto não é um número de conforto:
    // o critério do produto é despachar em menos de 3 s, e a espera média até o
    // próximo tick é metade da cadência. Com 15 s a espera média já é 7,5 s —
    // ou seja, o teto aqui é o LIMITE DO ABSURDO, não a meta.
    const cadencia = cadenciaDoTick();
    expect(Number(cadencia.split(' ')[0])).toBeLessThanOrEqual(CADENCIA_MAXIMA_S);
  });

  it('o tick bate na Edge Function que existe', () => {
    // `net.http_post` é assíncrono: um 404 aqui não levanta erro no cron, não
    // aparece em log de migration e não muda estado nenhum. O despacho
    // simplesmente para, em silêncio, por causa de um sufixo numa string.
    expect(urlDoTick()).toMatch(/^https:\/\/[\w.-]+\/functions\/v1\/dispatch-engine$/);
  });

  it('o tick bate no projeto DESTE app, não em outro', () => {
    // O padrão acima amarra o formato, não o destino: trocar o host por um
    // projeto de staging o mantém verde e faz o cron de produção despachar
    // corrida no banco errado — ou em nenhum. O ponto de apoio é o cliente do
    // app: os dois têm de falar com o mesmo projeto.
    const cliente = readFileSync(join(ROOT, 'src', 'lib', 'supabase.ts'), 'utf8');
    const fallback = /FALLBACK_SUPABASE_URL\s*=\s*'([^']+)'/.exec(cliente);
    if (!fallback) throw new Error('FALLBACK_SUPABASE_URL não encontrado em src/lib/supabase.ts');
    expect(urlDoTick()).toBe(`${fallback[1]}/functions/v1/dispatch-engine`);
  });

  it('a ação que o tick manda é uma que o motor atende', () => {
    // `'tik'` no lugar de `'tick'` cai no 400 "ação desconhecida" e o despacho
    // nunca roda. Quem responde se a ação existe é o próprio motor, não uma
    // transcrição — por isso a lista sai de `index.ts`.
    const engine = readFileSync(ENGINE, 'utf8');
    const atendidas = [...engine.matchAll(/action\s*===\s*'([^']+)'/g)].map((m) => m[1]);
    expect(atendidas.length).toBeGreaterThan(0);
    expect(atendidas).toContain(acaoDoTick());
    // E, entre as que o motor atende, tem de ser a PERIÓDICA. As outras
    // (`create`, `accept`, `reject`, `cancel`) são iniciadas por gente e exigem
    // um pedido no corpo: mandar qualquer uma delas a cada 10 s passaria no
    // teste acima e não despacharia nada. Literal digitado de propósito — não há
    // como derivar "qual delas é a do relógio" do texto do motor.
    expect(acaoDoTick()).toBe('tick');
  });

  it('o tick se identifica com o mesmo segredo dos outros crons', () => {
    // Errar o nome do segredo no Vault, ou o esquema do header, é 401 em todo
    // tick, para sempre, sem erro visível em lugar nenhum.
    const { esquema, segredo } = autorizacaoDoTick();
    expect(esquema).toBe('Bearer ');
    expect(segredosDosCronsIrmaos()).toEqual(
      segredosDosCronsIrmaos().map(() => segredo),
    );
  });

  it('ninguém desagenda o tick depois de agendá-lo', () => {
    expect(desagendamentosDepoisDoAgendamento()).toBe(0);
  });

  /**
   * As defesas do extrator, provadas contra SQL hostil escrito à mão. Sem este
   * bloco elas são só afirmações no comentário: a 0071 é um arquivo só, ninguém
   * pode mutá-la para checar, e "o teste passa no arquivo bom" não distingue uma
   * regex que fecha o buraco de uma que nunca fechou nada.
   */
  describe('o extrator do portão recusa o SQL que o sequestraria', () => {
    const honesto = (
      gate: string,
      cadencia = '10 seconds',
      url = 'https://exemplo.supabase.co/functions/v1/dispatch-engine',
      acao = 'tick',
    ) => `
      select cron.schedule(
        'dispatch-engine-tick',
        '${cadencia}',
        $$
          select net.http_post(
            url     := '${url}',
            headers := jsonb_build_object(
              'Content-Type', 'application/json',
              'Authorization', 'Bearer ' || (
                select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key'
              )
            ),
            body    := '{"action":"${acao}"}'::jsonb
          )
          where exists (
            select 1 from public.trip_requests
             ${gate}
          );
        $$
      );
    `;
    const GATE = "where status in ('REQUESTED','MATCHING')";

    it('aceita o portão honesto (o teste abaixo não passa por vacuidade)', () => {
      expect(statesFromCronGate(honesto("where status in ('REQUESTED','MATCHING')"))).toEqual([
        'REQUESTED',
        'MATCHING',
      ]);
    });

    it('recusa predicado além da lista de estados', () => {
      expect(() =>
        statesFromCronGate(
          honesto("where status in ('REQUESTED','MATCHING') and created_at > now() - interval '1 hour'"),
        ),
      ).toThrow(/predicado ALÉM/);
    });

    it('recusa dois agendamentos com o mesmo jobname', () => {
      // `cron.schedule(jobname, ...)` é UPSERT: quem vale é o ÚLTIMO. Sem esta
      // recusa, uma isca honesta em cima faz o teste ler uma lista enquanto o
      // Postgres executa outra.
      const isca = honesto("where status in ('REQUESTED','MATCHING')");
      const real = honesto("where status in ('REQUESTED','COMPLETED')");
      expect(() => statesFromCronGate(isca + real)).toThrow(/upsert por jobname/);
    });

    it('um portão comentado não é lido como o portão', () => {
      const comIsca = honesto(
        "-- where status in ('CANCELLED')\n       where status in ('REQUESTED','MATCHING')",
      );
      expect(statesFromCronGate(comIsca)).toEqual(['REQUESTED', 'MATCHING']);
    });

    it('lê a cadência honesta, e recusa a expressão cron que a disfarça', () => {
      expect(cadenciaDoTick(honesto(GATE))).toBe('10 seconds');
      expect(() => cadenciaDoTick(honesto(GATE, '0 3 * * *'))).toThrow(/não está em segundos/);
      // `* * * * *` é a expressão cron MAIS RÁPIDA que existe e ainda assim é
      // seis vezes mais lenta que hoje. Se ela passasse, o teste de teto acima
      // nem chegaria a rodar — `Number('*')` é NaN, e `NaN <= 15` é falso, mas
      // por acidente, com mensagem ilegível.
      expect(() => cadenciaDoTick(honesto(GATE, '* * * * *'))).toThrow(/não está em segundos/);
      // O teto é do teste, não do extrator: aqui só se prova que uma cadência
      // absurda CHEGA como número e reprova lá em cima.
      expect(Number(cadenciaDoTick(honesto(GATE, '86400 seconds')).split(' ')[0])).toBeGreaterThan(
        CADENCIA_MAXIMA_S,
      );
    });

    it('lê a URL honesta, e a URL trocada não passa pelo padrão exigido', () => {
      const padrao = /^https:\/\/[\w.-]+\/functions\/v1\/dispatch-engine$/;
      expect(urlDoTick(honesto(GATE))).toMatch(padrao);
      expect(
        urlDoTick(honesto(GATE, '10 seconds', 'https://x.supabase.co/functions/v1/dispatch-engine-old')),
      ).not.toMatch(padrao);
    });

    it('lê a ação do corpo, e enxerga o erro de digitação', () => {
      const URL_OK = 'https://exemplo.supabase.co/functions/v1/dispatch-engine';
      expect(acaoDoTick(honesto(GATE))).toBe('tick');
      expect(acaoDoTick(honesto(GATE, '10 seconds', URL_OK, 'tik'))).toBe('tik');
    });

    it('lê a autorização, e recusa o tick que não se identifica', () => {
      expect(autorizacaoDoTick(honesto(GATE))).toEqual({
        esquema: 'Bearer ',
        segredo: 'service_role_key',
      });
      const semHeader = `
        select cron.schedule('dispatch-engine-tick', '10 seconds', $$
          select net.http_post(url := 'x', body := '{"action":"tick"}'::jsonb)
          where exists (select 1 from public.trip_requests where status in ('REQUESTED'));
        $$);
      `;
      expect(() => autorizacaoDoTick(semHeader)).toThrow(/não se identifica/);
    });

    it('vê o unschedule que vem DEPOIS, e ignora o que vem antes', () => {
      // O de antes é o que torna a 0071 re-executável; ele não pode reprovar.
      const antes = `select cron.unschedule('dispatch-engine-tick');\n${honesto(GATE)}`;
      expect(desagendamentosDepoisDoAgendamento(antes)).toBe(0);
      expect(
        desagendamentosDepoisDoAgendamento(`${antes}\nselect cron.unschedule('dispatch-engine-tick');`),
      ).toBe(1);
    });
  });

  it('os dois lados só usam estados que existem no domínio da tabela', () => {
    // O teste "as duas listas são idênticas" NÃO pega isto: um `'OFFERRING'`
    // digitado errado nos DOIS arquivos passa idêntico e o pedido congela em
    // produção. O domínio da 0054 é o terceiro ponto de apoio.
    const dominio = statusDomain();
    expect(statesFromTypeScript().filter((s) => !dominio.includes(s))).toEqual([]);
    expect(statesFromCronGate().filter((s) => !dominio.includes(s))).toEqual([]);
  });
});
