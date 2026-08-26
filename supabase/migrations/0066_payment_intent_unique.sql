-- 0066 — um PaymentIntent pertence a UMA corrida, e só uma.
--
-- O BURACO. `rides.stripe_payment_intent_id` entrou na 0014 como `text` puro e
-- `rides.tip_payment_intent_id` na 0064 do mesmo jeito: sem UNIQUE, sem índice
-- único, sem nada. Conferido lendo TODAS as migrações 0001–0065 e o
-- supabase/schema.sql — não existe nenhuma restrição de unicidade sobre as duas
-- colunas (isto é leitura de código; não há Postgres neste ambiente para
-- consultar pg_index).
--
-- POR QUE ISSO É DINHEIRO, e não higiene de schema. O repasse saca o transfer da
-- cobrança de origem:
--
--     run-weekly-payouts/index.ts:173-184   resolveChargeId(ride.stripe_payment_intent_id)
--                                           → params.source_transaction = chargeId
--     request-payout/index.ts:154-167       idem
--     _shared/tipPayout.ts:86-91            idem, com tip_payment_intent_id
--
-- e a elegibilidade é POR CORRIDA (`paid = true and payout_id is null`). Duas
-- corridas carregando o MESMO PaymentIntent são, portanto, dois transfers
-- distintos sacados da MESMA cobrança — a segunda corrida paga um motorista com
-- dinheiro que a plataforma recebeu uma vez só. Nenhuma das restrições da 0065
-- pega isso: `rides_driver_amount_sane` compara driver_amount com o `price`
-- DAQUELA linha, e as duas linhas podem estar internamente sãs.
--
-- Como duas linhas chegariam ao mesmo id? Três caminhos que existem hoje:
--   • stripe-webhook/index.ts:207-215 grava `stripe_payment_intent_id` a partir
--     de `pi.metadata.rideId` — um metadata errado/reenviado escreve o mesmo PI
--     numa segunda corrida;
--   • charge-ride/index.ts:105-126 replayava um PaymentIntent antigo pela chave
--     de idempotência (corrigido na mesma leva desta migração, mas as linhas
--     legadas já criadas continuam no banco);
--   • qualquer backfill manual no SQL editor.
--
-- E há um efeito colateral silencioso já hoje, sem repasse nenhum:
-- stripe-webhook/index.ts:326-330 procura a corrida de uma disputa com
-- `.eq('stripe_payment_intent_id', piId).maybeSingle()`. Com duas linhas, o
-- PostgREST devolve erro em vez de linha e o chargeback perde o motorista no
-- alerta.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- POR QUE UM ÍNDICE PARCIAL, E NÃO `unique` NA COLUNA
-- ─────────────────────────────────────────────────────────────────────────────
-- No Postgres, NULLs não colidem entre si num índice único — então um `unique`
-- normal até funcionaria. O índice PARCIAL (`where ... is not null`) é melhor
-- por outro motivo: a esmagadora maioria das linhas de `rides` tem as duas
-- colunas nulas (corridas canceladas, agendadas, e toda corrida antes de ser
-- cobrada). Indexar só as não-nulas mantém o índice do tamanho do que realmente
-- é único e evita carregar milhares de entradas nulas.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- O GATE (mesma disciplina da 0065): DETECTAR E RELATAR, NUNCA APAGAR
-- ─────────────────────────────────────────────────────────────────────────────
-- Esta migração roda contra uma base VIVA (v1.0.5) que pode já conter duplicatas
-- — é exatamente a hipótese que justifica a migração. Um `create unique index`
-- cru falharia com um 23505 sem contexto: sem contagem, sem os ids, sem dizer
-- qual das duas linhas é a boa. E "resolver" sozinho é pior ainda: apagar ou
-- NULar um `stripe_payment_intent_id` destrói o lastro do `source_transaction` e
-- ainda por cima colide com a restrição `rides_paid_requires_payment_intent` da
-- 0065 (uma linha `paid = true` sem PaymentIntent passa a ser ilegal).
--
-- Escolher qual linha fica é decisão HUMANA, com o painel do Stripe aberto: o PI
-- pertence à corrida cujo valor/horário/passageiro batem com a cobrança. Por
-- isso o gate ABORTA com a contagem e a consulta pronta, e não toca em dado
-- nenhum.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠️ COMO APLICAR — LEIA ANTES DE RODAR
-- ─────────────────────────────────────────────────────────────────────────────
--
-- JANELA DE BLOQUEIO. O gate abaixo pega ACCESS EXCLUSIVE em `public.rides`, que
-- bloqueia TODO mundo — inclusive quem só lê. Enquanto ele estiver segurado, a
-- assinatura de corrida ativa do passageiro e a tela de navegação do motorista
-- param. A migração é curta (duas contagens agregadas + dois índices numa tabela
-- pequena), mas o risco NÃO é a duração dela: é a ESPERA. Um ACCESS EXCLUSIVE
-- que fica na fila atrás de uma transação em aberto passa a bloquear, ele
-- próprio, toda query que chegar depois — o efeito sanfona clássico do Postgres.
-- Uma sessão `idle in transaction` transforma isso em queda total do despacho.
--
-- Por isso o `lock_timeout` de 3 s na PRIMEIRA LINHA DO ARQUIVO (`set`, sem
-- `local`): a migração FALHA RÁPIDO e é seguro rodar de novo (ela não altera
-- dado nenhum; ver o gate).
--
-- POR QUE `set` E NÃO SÓ `set local`. `set local` é TRANSACIONAL: ele vale até o
-- fim da transação corrente e mais nada. O `set local` que está dentro do bloco
-- `do $$` protege o `lock table` do gate — e SÓ ele. Os dois
-- `create unique index` do fim do arquivo estão FORA daquele bloco, e cada um
-- deles pega o seu próprio ACCESS EXCLUSIVE em `public.rides`. Nos três modos de
-- aplicação que NÃO envolvem o arquivo numa transação (ver ATOMICIDADE abaixo:
-- `psql -f` sem `--single-transaction`, `supabase db push` e o editor SQL do
-- painel), o `set local` já morreu quando os índices são criados, e eles ficavam
-- esperando o lock SEM TIMESTAMP NENHUM — indefinidamente, enfileirando atrás de
-- si toda query que chegasse em `rides`. Exatamente a queda que o timeout existe
-- para evitar, um comando depois. O `set` de sessão, na primeira linha, vale
-- para o arquivo inteiro em TODOS os modos; o `set local` do bloco fica onde
-- está porque, no modo `--single-transaction`, ele mantém o escopo restrito à
-- transação da migração e não vaza para a sessão do operador.
--
-- Se der `lock_timeout`, ache o bloqueador e rode de novo:
--   select pid, state, wait_event_type, left(query, 120)
--     from pg_stat_activity
--    where state <> 'idle' or state = 'idle in transaction';
--
-- RODE EM JANELA DE MANUTENÇÃO, com tráfego baixo. Não aplique no horário de
-- pico de corridas.
--
-- ATOMICIDADE — E O QUE SE PERDE SEM ELA. O lock do gate só protege os
-- `create unique index` do fim do arquivo se as duas coisas estiverem na MESMA
-- transação. Aplique assim:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 \
--     -f supabase/migrations/0066_payment_intent_unique.sql
--
-- Um `psql -f` SEM `--single-transaction` roda cada comando na sua própria
-- transação implícita: o bloco `do $$` comita e SOLTA o lock, e os índices são
-- criados desprotegidos — exatamente a corrida que o lock existe para fechar
-- (uma cobrança concorrente grava a duplicata que o gate acabou de não ver, e o
-- `create unique index` falha com um 23505 cru, sem contagem e sem instrução).
-- O mesmo vale para `supabase db push` e para o editor SQL do painel, que não
-- envolvem o arquivo numa transação. Isso NÃO corrompe nada: o pior caso é a
-- migração abortar no índice com uma mensagem ruim, e ela é segura para repetir.
-- Mas a garantia de "ou tudo, ou nada" só existe com `--single-transaction`.
--
-- O QUE MUDA NESSES TRÊS MODOS, agora que o `set lock_timeout` é de SESSÃO: o
-- gate e os DOIS índices passam a falhar em 3 s se o lock não vier, em vez de
-- só o gate. A perda de atomicidade continua a mesma (o lock do gate não
-- alcança os índices), mas nenhum comando do arquivo espera para sempre.
--
-- Por isso NÃO usamos `create index concurrently` (que é proibido dentro de
-- transação): `rides` é pequena o bastante para o índice comum, e o lock que ele
-- pega é o mesmo que o gate já segura.
--
-- (Não foi possível executar nada disto: não há Postgres/psql neste ambiente.
-- O gate é código, não uma medição — ele nunca foi rodado contra um banco.)

-- PRIMEIRA INSTRUÇÃO DO ARQUIVO, de propósito: cobre o gate E os dois
-- `create unique index` do fim, em qualquer modo de aplicação. Ver "POR QUE
-- `set` E NÃO SÓ `set local`" no cabeçalho.
set lock_timeout = '3s';

do $$
declare
  v_dup_fare bigint;
  v_dup_tip  bigint;
  v_remedy   text;
begin
  -- FALHA RÁPIDO em vez de derrubar o despacho. Sem isto, o ACCESS EXCLUSIVE
  -- abaixo espera indefinidamente por qualquer transação em aberto e, enquanto
  -- espera, enfileira atrás de si toda query que chegar em `rides` — leituras
  -- inclusive.
  --
  -- REDUNDANTE COM O `set` DE SESSÃO DA PRIMEIRA LINHA, e mantido de propósito:
  -- no modo `--single-transaction` este `set local` restringe o efeito à
  -- transação da migração (não deixa o operador com um `lock_timeout` alterado
  -- na sessão depois que ela termina) e garante o timeout mesmo se alguém rodar
  -- SÓ este bloco, colado no editor SQL. Ele NÃO cobre os `create unique index`
  -- do fim do arquivo: `set local` morre no fim desta transação.
  set local lock_timeout = '3s';

  -- Mesmo raciocínio do lock da 0065: o gate CONTA e o `create unique index`
  -- logo abaixo APLICA. Entre os dois há uma janela em que um `charge-ride`
  -- concorrente poderia gravar a duplicata que o gate acabou de não ver, e aí o
  -- índice falharia com um 23505 cru — sem contagem, sem hint. ACCESS EXCLUSIVE
  -- é o mesmo lock que o CREATE INDEX vai pegar; antecipá-lo só fecha a janela.
  -- Liberado no fim da transação (ver ATOMICIDADE no cabeçalho).
  lock table public.rides in access exclusive mode;

  select
    (select count(*) from (
       select stripe_payment_intent_id
         from public.rides
        where stripe_payment_intent_id is not null
        group by stripe_payment_intent_id
       having count(*) > 1
     ) d),
    (select count(*) from (
       select tip_payment_intent_id
         from public.rides
        where tip_payment_intent_id is not null
        group by tip_payment_intent_id
       having count(*) > 1
     ) d)
    into v_dup_fare, v_dup_tip;

  if v_dup_fare > 0 or v_dup_tip > 0 then
    v_remedy :=
      'Liste as duplicatas: '
      'select stripe_payment_intent_id as pi, count(*), array_agg(id order by created_at) as corridas, '
      'array_agg(price order by created_at) as precos, array_agg(payout_id order by created_at) as repasses '
      'from public.rides where stripe_payment_intent_id is not null '
      'group by 1 having count(*) > 1 '
      'union all '
      'select tip_payment_intent_id, count(*), array_agg(id order by created_at), '
      'array_agg(tip_amount order by created_at), array_agg(tip_payout_id order by created_at) '
      'from public.rides where tip_payment_intent_id is not null '
      'group by 1 having count(*) > 1; '
      '-- Abra cada PI no painel do Stripe: valor, horario e customer dizem a QUAL corrida ele '
      'pertence. Na corrida DONA, nao mexa. Na(s) outra(s): se ela nunca foi cobrada de verdade, '
      'ponha paid = false e stripe_payment_intent_id = null (nessa ordem, para nao bater na CHECK); '
      'se ela FOI cobrada por um PI proprio, preencha o id correto. Se a corrida intrusa ja tem '
      'payout_id preenchido, o dinheiro JA SAIU: confira o transfer no Stripe antes de mexer. '
      'Depois rode a migracao de novo.';

    -- O procedimento sai TAMBEM como NOTICE, e nao so como HINT da excecao.
    -- Motivo pratico: `psql` imprime HINT no nivel de verbosidade padrao, mas
    -- `supabase db push` e o editor SQL do painel costumam mostrar apenas o
    -- `message`. Sem isto, o operador que aplica pelo painel veria "abortada:
    -- N duplicatas" e nenhuma instrucao do que fazer a respeito.
    raise notice '0066 — COMO RESOLVER: %', v_remedy;

    raise exception using
      errcode = 'unique_violation',
      message = format(
        '0066 abortada: %s PaymentIntent(s) de TARIFA e %s de GORJETA aparecem em mais de uma corrida. '
        'Nenhum dado foi alterado. Procedimento de resolucao no NOTICE acima (e no HINT): %s',
        v_dup_fare, v_dup_tip, v_remedy),
      detail =
        'Enquanto a duplicata existir, o repasse pode sacar DOIS transfers da MESMA cobranca via '
        'source_transaction (run-weekly-payouts/index.ts:181, request-payout/index.ts:166, '
        '_shared/tipPayout.ts:87) — a segunda corrida paga um motorista com dinheiro que a plataforma '
        'recebeu uma vez so. A migracao NAO escolhe qual linha fica: apagar ou NULar um '
        'stripe_payment_intent_id destroi o lastro do transfer e ainda colide com a restricao '
        'rides_paid_requires_payment_intent (0065).',
      hint = v_remedy;
  end if;
end;
$$;

-- ── Um PaymentIntent de TARIFA por corrida ───────────────────────────────────
create unique index if not exists rides_stripe_payment_intent_uniq
  on public.rides (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

-- ── Um PaymentIntent de GORJETA por corrida (0064) ───────────────────────────
create unique index if not exists rides_tip_payment_intent_uniq
  on public.rides (tip_payment_intent_id)
  where tip_payment_intent_id is not null;

comment on index public.rides_stripe_payment_intent_uniq is
  'Um PaymentIntent de tarifa pertence a UMA corrida. Sem isto, duas corridas com o mesmo id geram dois transfers sacados da mesma cobranca (source_transaction) e quebram a busca .maybeSingle() da disputa no stripe-webhook.';
comment on index public.rides_tip_payment_intent_uniq is
  'Mesma garantia para o PaymentIntent da gorjeta (0064), que lastreia o transfer proprio da gorjeta em _shared/tipPayout.ts.';

-- ─────────────────────────────────────────────────────────────────────────────
-- O QUE ESTES DOIS ÍNDICES NÃO COBREM (deliberado)
-- ─────────────────────────────────────────────────────────────────────────────
-- Eles são independentes um do outro: nada impede que o MESMO id apareça como
-- `stripe_payment_intent_id` de uma corrida e `tip_payment_intent_id` de outra.
-- Um índice único ATRAVÉS das duas colunas exigiria uma tabela de ponteiros ou
-- uma constraint de exclusão sobre uma expressão em UNION, que o Postgres não
-- oferece diretamente — custo alto para um cenário que nenhum caminho do código
-- produz: tarifa e gorjeta nascem de PaymentIntents distintos por construção
-- (`charge_<id>` e `tip_<id>`, ver 0064) e são gravadas por funções diferentes.
-- Fica registrado como limite conhecido, não como esquecimento.
