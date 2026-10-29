-- 0065 — o cliente deixa de ser dono do dinheiro.
--
-- CAUSA RAIZ (uma só, vários exploits): o app escreve direto nas colunas de
-- dinheiro de `rides` e nas colunas de comissão/Stripe de `profiles`. RLS no
-- Postgres é por LINHA, não por COLUNA — a policy "Motorista aceita corrida"
-- (schema.sql:116-122) autoriza o UPDATE da linha inteira e as policies de
-- INSERT (schema.sql:113-114, 0002_profiles_insert_policy.sql:4-5) autorizam o
-- INSERT da linha inteira, inclusive `price`, `driver_amount`, `paid`,
-- `is_admin` e `driver_share_percent`. Não há GRANT por coluna nem trigger
-- guardando nada. Consequência prática, hoje, em produção:
--
--   1. `price` sai calculado do cliente (useRide.requestRide) e `charge-ride`
--      cobra esse número verbatim → passageiro escolhe a própria tarifa.
--   2. `driver_amount` saía calculado do cliente e `run-weekly-payouts`/
--      `request-payout` transferem verbatim → motorista escolhe o repasse.
--   3. `paid` é gravável pelo cliente → marcar como paga uma corrida nunca
--      cobrada gera repasse de dinheiro que a plataforma nunca recebeu.
--   4. `driver_share_percent` e as flags `stripe_*` ficaram DE FORA do guard de
--      0018/0043/0055 (que cobre só type/is_admin/verification_*/jurisdiction)
--      → motorista se dá 100% de comissão e se auto-habilita para repasse.
--   5. E, o mais grave: guardar só o UPDATE não guarda nada, porque as duas
--      linhas NASCEM pelo cliente. `rides` é inserida pelo passageiro
--      (useRide.ts:588-610) e `profiles` é inserida pelo próprio usuário no
--      cadastro (AuthContext.tsx:175-185 — a 0062 derrubou de propósito o
--      trigger handle_new_user, então o cliente é o ÚNICO criador do perfil).
--      Um guard BEFORE UPDATE deixa o atacante simplesmente JÁ NASCER com o
--      valor que quer:
--        • rides: insert com passenger_id = driver_id = self, paid = true,
--          driver_amount = 999999.99 → request-payout aceita (a elegibilidade
--          em request-payout/index.ts:229-235 não olha `status` nem exige
--          PaymentIntent), resolveChargeId(null) devolve null, o transfer sai
--          SEM `source_transaction` e é sacado do saldo da PLATAFORMA;
--        • profiles: insert com is_admin = true, driver_share_percent = 1.000,
--          verification_status = 'approved', stripe_*_enabled = true. E o 1.000
--          é PERMANENTE: assign_driver_tier retorna cedo quando a fatia já não
--          é nula, então a própria função SECURITY DEFINER da plataforma passa
--          a pagar 100% de toda corrida àquele motorista.
--
-- O que esta migração faz:
--   A. trigger BEFORE INSERT OR UPDATE em `rides` que (i) no INSERT do cliente
--      ZERA as colunas de dinheiro para o default do servidor, (ii) no UPDATE
--      do cliente REVERTE qualquer mudança nelas, e (iii) CALCULA o split no
--      próprio trigger quando o motorista entra na corrida;
--   B. o guard de `profiles` estendido para comissão/flags Stripe MAIS um
--      BEFORE INSERT que nasce o perfil sem privilégio nenhum;
--   C. `apply_driver_split(uuid)` como caminho IDEMPOTENTE de reparo/backfill;
--   D. CHECKs de sanidade em preço, componentes de tarifa, colunas de repasse e
--      coordenadas — precedidos de um GATE que aborta a migração se houver
--      linha legada violando (ver "A ARMADILHA DO NOT VALID", abaixo);
--   E. `payouts` deixa de aceitar INSERT do cliente.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- A ARMADILHA DO SECURITY DEFINER (leia antes de mexer)
-- ─────────────────────────────────────────────────────────────────────────────
-- `auth.role()` NÃO é o papel efetivo do Postgres: é uma leitura da claim
-- `role` do JWT (request.jwt.claims). Dentro de uma função SECURITY DEFINER
-- chamada por um usuário logado, ela continua devolvendo 'authenticated' — o
-- SECURITY DEFINER troca o dono da execução no Postgres, não o JWT da requisição.
--
-- Portanto um guard escrito apenas como
--
--     if auth.role() <> 'service_role' then ... reverte ... end if;
--
-- reverteria TAMBÉM a escrita feita pela própria `apply_driver_split`. E em
-- silêncio: o UPDATE reportaria 1 linha afetada, o RPC devolveria sucesso, e
-- todo motorista de 85% continuaria recebendo 80% para sempre, sem um único
-- erro em lugar nenhum. É exatamente o tipo de falha que passa em revisão.
--
-- Mecanismo escolhido para distinguir os dois casos: um GUC TRANSACTION-LOCAL
-- (`set_config(..., is_local => true)`) que a própria função levanta logo antes
-- do UPDATE e derruba logo depois. O guard libera a escrita quando o GUC está
-- levantado.
--
-- Por que isso não vira um bypass para o cliente:
--   • o valor do GUC não é 'on'/'true', é o UUID DA LINHA. Mesmo que o GUC
--     vazasse, ele só destravaria aquela linha específica, não a tabela;
--   • `is_local => true` amarra o valor à TRANSAÇÃO. No PostgREST cada
--     requisição HTTP é uma transação própria, então o valor morre no fim da
--     chamada do RPC — não sobrevive para o request seguinte;
--   • a função ainda o zera explicitamente depois do UPDATE, então nem dentro
--     da mesma transação um segundo statement herda a permissão;
--   • o cliente não tem como levantá-lo sozinho: PostgREST só expõe funções do
--     schema público (`set_config` é do pg_catalog) e os GUCs que ele mesmo
--     define ficam no namespace `request.*`, nunca em `app.*`.
--
-- DOIS GUCs, NÃO UM. A versão anterior desta migração usava o mesmo nome
-- (`app.money_write`) ora como UUID de corrida, ora como UUID de perfil. Como
-- `rides.id` tem só `default gen_random_uuid()` — e default não é enforcement:
-- a policy de INSERT não impede o cliente de ESCOLHER o id — um cliente podia
-- criar uma corrida cujo id fosse igual ao id do próprio perfil e, com isso,
-- fazer uma válvula levantada para um namespace destravar o outro. Hoje isso
-- não é explorável porque cada request do PostgREST é uma transação de um
-- statement só, mas "não é explorável hoje" não é uma propriedade que se possa
-- manter. Agora são `app.ride_money_write` e `app.profile_money_write`, e o
-- trigger de INSERT força `new.id := gen_random_uuid()` para o cliente.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- POR QUE O SPLIT MORA NO TRIGGER, E NÃO NUMA RPC QUE O CLIENTE CHAMA
-- ─────────────────────────────────────────────────────────────────────────────
-- Enquanto o split dependia do app chamar `apply_driver_split` DEPOIS do UPDATE
-- de aceite, existia uma janela entre "a corrida virou minha" e "meu percentual
-- foi aplicado". Nessa janela `charge-ride` já marcou `paid = true`
-- (useRide.ts:1608, muito antes da RPC em :1714; e em activate(), :844 contra
-- :876), então `request-payout` ou o cron semanal podiam reservar a corrida com
-- o split PADRÃO de 80%. Depois disso `payout_id` deixa de ser nulo e qualquer
-- recálculo vira no-op — um motorista de 85% pago a menos, para sempre, sem
-- nenhum erro. Perda de rede ou crash do app entre o UPDATE e a RPC dava o
-- mesmo resultado permanente.
--
-- Agora o split é ATÔMICO com o aceite: o trigger BEFORE atribui `NEW.driver_amount`
-- e `NEW.platform_fee` na MESMA linha que está sendo gravada, no mesmo statement.
-- Atribuir a NEW num trigger BEFORE não grava linha nenhuma — é só a linha que o
-- statement já ia escrever — logo não há recursão e não é preciso GUC neste
-- caminho. Não existe mais janela: ou o aceite acontece com o split certo, ou
-- não acontece.
--
-- `apply_driver_split(uuid)` continua existindo como caminho de REPARO/backfill
-- (linhas antigas, correção de `driver_share_percent` atribuída tarde). Ela faz
-- um UPDATE de verdade, então continua precisando do GUC.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- A ARMADILHA DO NOT VALID (por isso o gate do bloco D)
-- ─────────────────────────────────────────────────────────────────────────────
-- `NOT VALID` só pula a varredura inicial da tabela. A restrição É aplicada em
-- todo INSERT e todo UPDATE posterior daquela linha — inclusive num UPDATE que
-- não toca a coluna restringida. Numa base viva (v1.0.5) com corridas antigas de
-- teste, uma linha com origin_lat/lng = (0,0) ou price > 2000 passaria a
-- REJEITAR qualquer update de status/telemetria/cancelamento com SQLSTATE 23514:
-- uma corrida morta, impossível de completar e impossível de cancelar.
--
-- Pior: os rollbacks em lote de repasse
--   request-payout/index.ts:361 e run-weekly-payouts/index.ts:217
--   update rides set payout_id = null where payout_id = X
-- abortam INTEIROS na primeira linha ofensora. O resultado é toda corrida
-- daquele payout falho ficar com `payout_id` preenchido para sempre — dinheiro
-- fora do saldo do motorista, em silêncio.
--
-- Por isso o bloco D começa com um GATE EXECUTÁVEL: se existir uma única linha
-- violando, a migração ABORTA com a contagem e a instrução de limpeza. O
-- operador limpa o legado ANTES das restrições existirem — em vez de descobrir
-- o problema meses depois, num rollback de repasse que estranha ninguém. Como o
-- gate prova que a tabela está limpa, as restrições entram JÁ VALIDADAS (não há
-- nada a pular) e não fica dívida de `validate constraint` pendente.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ESCOPO: preço continua vindo do cliente no INSERT.
-- ─────────────────────────────────────────────────────────────────────────────
-- Esta migração congela `price` DEPOIS do insert. O insert em si ainda aceita o
-- número que o app mandar (idem `toll_amount` e `airport_port_fee`). Derivar a
-- tarifa no servidor (tabela de tarifário + rota verificada + surge assinado) é
-- um projeto próprio e está FORA do escopo aqui — ver o TODO GRANDE no bloco D,
-- logo abaixo.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ESTE ARQUIVO PRECISA SER APLICADO NUMA ÚNICA TRANSAÇÃO.
-- ─────────────────────────────────────────────────────────────────────────────
-- O bloco D abaixo é um GATE que ABORTA a migração se houver linha legada
-- violando as novas restrições. Se o arquivo NÃO estiver dentro de uma
-- transação, um gate que aborta no meio deixa o pior dos mundos: parte das
-- funções/triggers instalada, restrições ausentes e a policy de INSERT de
-- `payouts` ainda de pé. Por isso o gate foi movido para o TOPO (antes de
-- qualquer `create or replace function`): mesmo no cenário sem transação, um
-- aborto aqui não deixa NADA aplicado.
--
-- Como confirmar a atomicidade antes de aplicar:
--   • caminho garantido — aplicar com psql em transação explícita:
--       psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 \
--         -f supabase/migrations/0065_money_write_guard.sql
--     `--single-transaction` embrulha o arquivo inteiro em BEGIN/COMMIT e
--     `ON_ERROR_STOP=1` garante o ROLLBACK no primeiro erro.
--   • com a CLI — `supabase db push --debug` e conferir no log que sai um
--     `BEGIN` ANTES do primeiro statement deste arquivo e um `COMMIT` só depois
--     do último. Se não sair, use o caminho do psql acima.
--   • este arquivo NÃO contém `commit;` nem `begin;` de propósito: emitir um
--     COMMIT no meio quebraria a atomicidade externa.
-- (Não foi possível verificar isso aqui: não há Postgres/psql/CLI neste
-- ambiente. É uma instrução de operação, não uma medição.)

-- ═════════════════════════════════════════════════════════════════════════════
-- D. Gate + sanidade de preço, componentes, repasse e coordenadas
--    (ordem física: PRIMEIRO no arquivo — ver a nota de atomicidade acima)
-- ═════════════════════════════════════════════════════════════════════════════
-- Com `price` congelado depois do insert (bloco A), o que resta é o insert. A
-- derivação da tarifa NO SERVIDOR é o conserto de verdade e NÃO está feita aqui.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ TODO (P0, projeto próprio — o CONSERTO DE VERDADE dos componentes)        │
-- ├───────────────────────────────────────────────────────────────────────────┤
-- │ `toll_amount` e `airport_port_fee` ainda vêm DO CLIENTE no INSERT         │
-- │ (useRide.ts:615-616 e :712-713). Os dois já têm tabela de configuração no │
-- │ servidor e NENHUMA delas é consultada no momento de gravar a corrida:     │
-- │                                                                           │
-- │   • pedágio  → system_config: `tolls_enabled`, `toll_provider`,           │
-- │                `mock_toll_flat`, `mock_toll_per_km` (migração 0028),      │
-- │                lidos hoje só pelo APP em src/lib/tolls.ts;                │
-- │   • taxa de local → system_config: `airport_port_fees` (migração 0030),   │
-- │                uma lista de geofences com pickupFee/dropoffFee, lida hoje │
-- │                só pelo APP em src/lib/airportFees.ts.                     │
-- │                                                                           │
-- │ O conserto é DERIVAR os dois NO SERVIDOR a partir dessas mesmas tabelas    │
-- │ (origem/destino/distância da corrida → valor), e passar a IGNORAR o que o │
-- │ cliente mandar — exatamente como o bloco A já faz com driver_amount.      │
-- │ Enquanto isso não existir, os CHECKs abaixo são LIMITE DE ESTRAGO, não    │
-- │ correção: um app modificado continua declarando um pedágio que não        │
-- │ aconteceu, só que agora limitado.                                         │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- Os demais CHECKs também apenas limitam o estrago: impedem tarifa negativa,
-- tarifa absurda, repasse maior que a cobrança e coordenadas impossíveis. Eles
-- NÃO impedem um passageiro de pedir uma corrida de $5 que deveria custar $50.

do $$
declare
  v_bad_price    bigint;
  v_bad_fees     bigint;
  v_bad_ceiling  bigint;
  v_bad_payout   bigint;
  v_bad_paid     bigint;
  v_bad_origin   bigint;
  v_bad_dest     bigint;
  v_total        bigint;
  v_have_cons    bigint;
  v_null_paid    bigint;
begin
  -- ══ TRAVA ═════════════════════════════════════════════════════════════════
  -- O gate conta linhas e, logo depois, o ALTER TABLE aplica a restrição. Entre
  -- as duas coisas há uma janela: uma corrida inserida por um cliente nesse
  -- intervalo faz o ALTER falhar com um 23514 cru — sem a contagem, sem o hint,
  -- sem a instrução de limpeza que o gate existe para dar. Pior, num arquivo que
  -- não esteja em transação, isso deixa a base pela metade.
  --
  -- ACCESS EXCLUSIVE é o mesmo lock que o próprio ALTER TABLE vai pegar daqui a
  -- pouco: pegá-lo AGORA só antecipa a espera e fecha a janela. Ele é liberado
  -- no fim da transação.
  --
  -- ⚠️ JANELA DE MANUTENÇÃO (P2). Este arquivo NÃO deve ser aplicado com a
  -- operação em pico. ACCESS EXCLUSIVE conflita com TUDO, inclusive SELECT:
  -- numa base viva o pedido entra na fila atrás de qualquer transação em voo
  -- (uma corrida sendo aceita, um cron de repasse, uma sessão ociosa em
  -- transação aberta) e, ENQUANTO ESPERA, todo leitor posterior de `rides`
  -- fica atrás dele na mesma fila — o app inteiro trava, não só a migração.
  --
  -- `lock_timeout` é o que transforma "app parado por tempo indeterminado" em
  -- "migração falha rápido e some da fila". 5s é folgado para uma base ociosa e
  -- curto o bastante para não derrubar a operação; se estourar, o erro é 55P03
  -- (lock_not_available), a transação inteira rola de volta (nada aplicado, ver
  -- a nota de atomicidade no topo) e é só reaplicar num momento mais calmo.
  --
  -- `is_local => true` = `SET LOCAL`: vale só até o fim desta transação. Os
  -- statements seguintes do arquivo (os ALTERs, os CREATE TRIGGER) o herdam de
  -- propósito — os que pegam lock em `rides` já o têm nas mãos daqui em diante,
  -- e nos poucos que tocam `profiles`/`payouts` um timeout é preferível a um
  -- travamento silencioso, pelo mesmo motivo.
  perform set_config('lock_timeout', '5s', true);

  lock table public.rides in access exclusive mode;

  -- ══ GATE ══════════════════════════════════════════════════════════════════
  -- Ver "A ARMADILHA DO NOT VALID" no topo. Uma restrição que entra sem a base
  -- estar limpa não é uma restrição: é uma corrida morta esperando acontecer, e
  -- um rollback de repasse que aborta inteiro e deixa dinheiro fora do saldo do
  -- motorista. Então a migração PARA aqui, com os números na mão, em vez de
  -- deixar o problema para o dia do payout.
  select
    count(*) filter (where price is not null and (price < 0 or price > 2000)),
    count(*) filter (where coalesce(toll_amount, 0) < 0 or coalesce(toll_amount, 0) > 2000
                        or coalesce(airport_port_fee, 0) < 0 or coalesce(airport_port_fee, 0) > 2000
                        or coalesce(tip_amount, 0) < 0 or coalesce(tip_amount, 0) > 2000
                        or coalesce(toll_amount, 0) + coalesce(airport_port_fee, 0) > coalesce(price, 0)),
    -- Teto por componente (ver a justificativa das constantes logo abaixo, na
    -- restrição rides_fee_components_bounded_by_price).
    count(*) filter (where coalesce(toll_amount, 0) > least(floor(coalesce(price, 0) * 60) / 100, 120)
                        or coalesce(airport_port_fee, 0) > least(floor(coalesce(price, 0) * 60) / 100, 120)),
    count(*) filter (where driver_amount is not null
                       and (driver_amount < 0
                            or driver_amount > coalesce(price, 0) + coalesce(tip_amount, 0))),
    count(*) filter (where paid and stripe_payment_intent_id is null),
    count(*) filter (where origin_lat is null or origin_lng is null
                        or not (origin_lat between -90 and 90)
                        or not (origin_lng between -180 and 180)
                        or (origin_lat = 0 and origin_lng = 0)),
    count(*) filter (where destination_lat is null or destination_lng is null
                        or not (destination_lat between -90 and 90)
                        or not (destination_lng between -180 and 180)
                        or (destination_lat = 0 and destination_lng = 0))
    into v_bad_price, v_bad_fees, v_bad_ceiling, v_bad_payout, v_bad_paid,
         v_bad_origin, v_bad_dest
    from public.rides;

  v_total := v_bad_price + v_bad_fees + v_bad_ceiling + v_bad_payout + v_bad_paid
           + v_bad_origin + v_bad_dest;

  if v_total > 0 then
    raise exception using
      errcode = 'check_violation',
      message = format(
        '0065 abortada: %s linha(s) de public.rides violam as novas restrições '
        '(price=%s, componentes=%s, teto_componente=%s, driver_amount=%s, '
        'paid_sem_payment_intent=%s, origem=%s, destino=%s).',
        v_total, v_bad_price, v_bad_fees, v_bad_ceiling, v_bad_payout, v_bad_paid,
        v_bad_origin, v_bad_dest),
      detail =
        'Uma CHECK adicionada com base suja (mesmo NOT VALID) passa a rejeitar QUALQUER update '
        'posterior dessas linhas — inclusive mudança de status, telemetria e cancelamento — e faz '
        'o rollback em lote de repasse (update rides set payout_id = null where payout_id = X) '
        'abortar inteiro, deixando todas as corridas daquele payout com payout_id preso e o '
        'dinheiro fora do saldo do motorista.',
      hint =
        'Liste as ofensoras e limpe antes de reaplicar: '
        'select id, status, price, toll_amount, airport_port_fee, tip_amount, driver_amount, paid, '
        'stripe_payment_intent_id, origin_lat, origin_lng, destination_lat, destination_lng '
        'from public.rides where (price is not null and (price < 0 or price > 2000)) '
        'or coalesce(toll_amount,0) < 0 or coalesce(toll_amount,0) > 2000 '
        'or coalesce(airport_port_fee,0) < 0 or coalesce(airport_port_fee,0) > 2000 '
        'or coalesce(tip_amount,0) < 0 or coalesce(tip_amount,0) > 2000 '
        'or coalesce(toll_amount,0) + coalesce(airport_port_fee,0) > coalesce(price,0) '
        'or coalesce(toll_amount,0) > least(floor(coalesce(price,0) * 60) / 100, 120) '
        'or coalesce(airport_port_fee,0) > least(floor(coalesce(price,0) * 60) / 100, 120) '
        'or (driver_amount is not null and (driver_amount < 0 or driver_amount > coalesce(price,0) + coalesce(tip_amount,0))) '
        'or (paid and stripe_payment_intent_id is null) '
        'or origin_lat is null or origin_lng is null or destination_lat is null or destination_lng is null '
        'or not (origin_lat between -90 and 90) or not (origin_lng between -180 and 180) '
        'or not (destination_lat between -90 and 90) or not (destination_lng between -180 and 180) '
        'or (origin_lat = 0 and origin_lng = 0) or (destination_lat = 0 and destination_lng = 0); '
        '-- corridas de teste antigas: apagar. Corridas reais: corrigir a coluna. '
        'O caso legado MAIS provável é paid = true sem stripe_payment_intent_id: são cobranças '
        'anteriores à 0014 (que criou a coluna) ou cobradas fora do app. Ache o PaymentIntent no '
        'painel do Stripe e preencha a coluna, ou — se a corrida nunca foi cobrada de verdade — '
        'ponha paid = false. NÃO invente um id: ele lastreia o source_transaction do repasse. '
        'Depois rode a migração de novo.';
  end if;

  -- ══ RESTRIÇÕES ════════════════════════════════════════════════════════════
  -- VALIDADAS, não NOT VALID: o gate acima acabou de provar que não há linha
  -- ofensora, então não sobra nada para a varredura pular — e não fica dívida de
  -- `alter table ... validate constraint` esquecida no backlog.
  --
  -- UM ÚNICO `alter table` com todas as cláusulas `add constraint`: um lock, uma
  -- varredura da tabela. Oito ALTERs separados pegariam o ACCESS EXCLUSIVE oito
  -- vezes e varreriam `rides` oito vezes. (Não meço o ganho — não há banco aqui;
  -- o argumento é de forma, não de tempo.)
  --
  -- ── Idempotência (P2-11) ──────────────────────────────────────────────────
  -- A versão anterior guardava o ALTER com `not exists (... conname = any
  -- (array[...]))`, isto é: "se ALGUMA das oito já existe, não adiciona
  -- NENHUMA". O raciocínio era "as oito só existem em conjunto, porque um único
  -- statement tudo-ou-nada as cria". A premissa é FALSA na prática: este arquivo
  -- já circulou numa versão com SETE restrições, e qualquer reaplicação sobre um
  -- banco que tenha rodado aquela versão cairia no ramo "existe alguma ⇒ nada a
  -- fazer" e pularia em silêncio justamente a restrição que falta — inclusive
  -- rides_fee_components_bounded_by_price, que é o teto por componente do P0-1.
  -- Um guard de idempotência que silenciosamente NÃO aplica uma restrição de
  -- dinheiro é pior que não ter guard nenhum.
  --
  -- Agora a decisão é por CONTAGEM, e o caso parcial é tratado em vez de
  -- ignorado:
  --   • 8 de 8 → nada a fazer (reaplicação limpa);
  --   • 0 de 8 → adiciona as oito (aplicação nova);
  --   • 1..7   → derruba as que existem e adiciona as oito de novo.
  --
  -- Derrubar e readicionar é seguro e barato: `drop constraint` de um CHECK é
  -- só catálogo (não varre a tabela), o drop e o add acontecem na MESMA
  -- transação e sob o ACCESS EXCLUSIVE que já está nas nossas mãos desde o topo
  -- deste bloco — nenhuma outra sessão chega a ver a tabela sem restrição. E o
  -- gate acima acabou de provar que não há linha ofensora, então o re-add
  -- valida sem erro.
  --
  -- Isto também preserva a propriedade "um lock, uma varredura": continua sendo
  -- UM único `alter table ... add constraint` com as oito cláusulas.
  select count(*)
    into v_have_cons
    from pg_constraint
   where conrelid = 'public.rides'::regclass
     and conname = any (array[
       'rides_price_sane',
       'rides_fee_components_sane',
       'rides_fee_components_within_price',
       'rides_fee_components_bounded_by_price',
       'rides_driver_amount_sane',
       'rides_paid_requires_payment_intent',
       'rides_origin_coords_valid',
       'rides_destination_coords_valid'
     ]);

  if v_have_cons between 1 and 7 then
    raise notice
      '0065: % de 8 restrições de sanidade já existem em public.rides (execução parcial anterior). Derrubando e readicionando as oito na mesma transação.',
      v_have_cons;
    alter table public.rides
      drop constraint if exists rides_price_sane,
      drop constraint if exists rides_fee_components_sane,
      drop constraint if exists rides_fee_components_within_price,
      drop constraint if exists rides_fee_components_bounded_by_price,
      drop constraint if exists rides_driver_amount_sane,
      drop constraint if exists rides_paid_requires_payment_intent,
      drop constraint if exists rides_origin_coords_valid,
      drop constraint if exists rides_destination_coords_valid;
  end if;

  if v_have_cons < 8 then
    alter table public.rides

      -- Teto de $2000: uma corrida XL Orlando→Key West (~400 mi, ~8 h) com surge
      -- 2× dá cerca de $1.290 pela tarifa de estimatePrice() (useRide.ts:477),
      -- mais pedágio. $2000 folga o suficiente para não barrar corrida real
      -- nenhuma e ainda assim mata a cobrança de $99.999,99. Não é um preço
      -- "correto" — é um limite de estrago, ver o TODO acima.
      add constraint rides_price_sane
        check (price is null or (price >= 0 and price <= 2000)),

      -- Componentes da tarifa não podem ser negativos (um pedágio negativo
      -- viraria desconto no split, um airport fee negativo viraria dinheiro
      -- extra).
      --
      -- P2-10 — `tip_amount <= 2000` conversa com tip-ride/index.ts:19, onde
      -- MAX_TIP_CENTS é lido de variável de ambiente (default 20000 = $200).
      -- Enquanto o env fica no default, o teto do app é 10× mais apertado que
      -- este e nada colide. Mas o env é ajustável em produção sem passar por
      -- este arquivo: um MAX_TIP_CENTS acima de 200000 faria o Stripe COBRAR a
      -- gorjeta e o UPDATE seguinte (tip-ride:~118) bater neste CHECK — dinheiro
      -- capturado, gorjeta não registrada, motorista não recebe. Por isso
      -- tip-ride passou a limitar o valor do env por um DB_MAX_TIP_CENTS =
      -- 200000 rígido, que é a tradução em centavos deste 2000. Os dois números
      -- são um só: mexer aqui obriga a mexer lá.
      add constraint rides_fee_components_sane
        check (
          (toll_amount is null or (toll_amount >= 0 and toll_amount <= 2000))
          and (airport_port_fee is null or (airport_port_fee >= 0 and airport_port_fee <= 2000))
          and (tip_amount is null or (tip_amount >= 0 and tip_amount <= 2000))
        ),

      -- Lado da ENTRADA, parte 1. O teto de $2000 por componente, sozinho, não
      -- relacionava nada com o preço: price = 1.00 com toll_amount = 2000.00
      -- passava — e o pedágio é pass-through, então o motorista "recebia" $2000
      -- de uma cobrança de $1.
      add constraint rides_fee_components_within_price
        check (coalesce(toll_amount, 0) + coalesce(airport_port_fee, 0) <= coalesce(price, 0)),

      -- ── Lado da ENTRADA, parte 2 — P0-1 ────────────────────────────────────
      -- `toll + venue <= price` (acima) fecha o furto do SALDO da plataforma,
      -- mas NÃO fecha o furto da COMISSÃO dela. Com toll_amount = price:
      --   fare = price - toll - venue = 0 → driver_cut = 0
      --   driver_amount = 0 + toll  = price
      --   platform_fee  = 0 + venue = 0
      -- ou seja, repasse de 100% e comissão ZERO em toda corrida de um app
      -- modificado — e a restrição anterior aceita (price + 0 <= price).
      --
      -- O espelho disso ferra o MOTORISTA: airport_port_fee = price zera o
      -- repasse dele numa corrida real (a taxa de local fica com a plataforma).
      -- Por isso o teto vale para os DOIS componentes.
      --
      -- AS CONSTANTES (as duas são LIMITE DE ESTRAGO, não medição):
      --
      --   60% do preço — o preço da corrida JÁ INCLUI o componente
      --     (`price = fare + toll + venueFee`, useRide.ts:590 e :695), então a
      --     razão componente/preço só chega a 50% quando o componente iguala a
      --     tarifa inteira. Nos números do próprio tarifário: a corrida mais
      --     barata possível é o mínimo de $13,09 (estimatePrice com o piso de
      --     $8,90 + booking $3,00, +10%); para o pedágio chegar a 60% dela
      --     seriam ~$19,60 de praça numa corrida de tarifa mínima. 60% é folga
      --     deliberada sobre qualquer corrida plausível — e mesmo assim garante
      --     tarifa (e portanto COMISSÃO) de no mínimo 40% do preço em toda
      --     corrida, que é precisamente o buraco que este CHECK fecha.
      --
      --   $120 absolutos — teto duro para as corridas caras, onde 60% seria
      --     $1.200. NÃO é um valor medido numa tabela de praças: o único
      --     provider implementado (MockTollProvider, src/lib/tolls.ts:56-65)
      --     calcula `flat + perKm * distanceKm` com `mock_toll_flat` e
      --     `mock_toll_per_km` semeados em 0 e `tolls_enabled` = false
      --     (migração 0028) — isto é, HOJE o app produz sempre pedágio $0 e
      --     nenhuma corrida real pode ser barrada por este teto. Idem para a
      --     taxa de local: `airport_port_fees` é semeada como lista VAZIA
      --     (migração 0030), sem nenhum teto configurado — não existe número de
      --     referência no repositório para copiar. $120 é a ordem de grandeza
      --     folgada acima de qualquer combinação de praças de um único trajeto
      --     na Flórida. Se um dia a operação precisar de mais, ISTO tem que ser
      --     alterado deliberadamente numa migração — e não descoberto como um
      --     23514 no insert de uma corrida real.
      --
      -- `floor(price * 60) / 100` em vez de `price * 0.60`: as duas expressões
      -- são equivalentes para uma coluna numeric(8,2) (nenhum valor de 2 casas
      -- cai entre elas), mas o floor é a MESMA forma usada no grampo de
      -- public.compute_ride_split e em composeRideSplit() (src/lib/split.ts),
      -- que trabalham em centavos inteiros. Escritas iguais nos três lugares
      -- para que não haja como divergirem em meio centavo.
      add constraint rides_fee_components_bounded_by_price
        check (
          coalesce(toll_amount, 0) <= least(floor(coalesce(price, 0) * 60) / 100, 120)
          and coalesce(airport_port_fee, 0) <= least(floor(coalesce(price, 0) * 60) / 100, 120)
        ),

      -- As duas colunas que o repasse REALMENTE lê. `numeric(8,2)` aceita
      -- 999999.99, e request-payout/run-weekly-payouts transferem
      -- `driver_amount` verbatim. O teto é `price + tip_amount` porque é
      -- literalmente o máximo que foi (ou pode ser) cobrado do passageiro por
      -- esta corrida — o repasse nunca pode passar da cobrança que o lastreia.
      add constraint rides_driver_amount_sane
        check (
          driver_amount is null
          or (driver_amount >= 0
              and driver_amount <= coalesce(price, 0) + coalesce(tip_amount, 0))
        ),

      -- ESTE sozinho mata o "marcar como paga sem cobrança", que é a chave de
      -- todo o exploit de repasse: sem PaymentIntent, `resolveChargeId` devolve
      -- null, o transfer sai sem `source_transaction` e é sacado do saldo da
      -- PLATAFORMA.
      --
      -- Seguro contra as escritas legítimas? Conferido uma a uma:
      --   charge-ride/index.ts:123-126   → update({ paid: true, stripe_payment_intent_id })
      --                                    NO MESMO statement. CHECK de linha é
      --                                    avaliado depois de todas as atribuições
      --                                    do statement, então nunca vê o estado
      --                                    intermediário.
      --   stripe-webhook/index.ts:213    → idem, os dois campos juntos.
      --   stripe-webhook/index.ts:227    → update({ paid: false }) — libera.
      --   refund-ride/index.ts:107       → update({ paid: false }) — libera.
      --   tip-ride/index.ts:116-121      → escreve tip_amount/tip_payment_intent_id,
      --                                    não toca em paid; a linha já tinha os dois
      --                                    campos da tarifa (tip-ride exige corrida
      --                                    completa e cobrada).
      --   _shared/tipPayout.ts:46-52     → update({ tip_payout_id }); filtra por
      --                                    paid = true, ou seja, linhas que por
      --                                    construção já têm PaymentIntent.
      --   request-payout/:361, run-weekly-payouts/:217 → update({ payout_id: null }),
      --                                    não tocam paid.
      -- Nenhum caminho grava `paid = true` antes ou sem o PaymentIntent.
      add constraint rides_paid_requires_payment_intent
        check (not paid or stripe_payment_intent_id is not null),

      -- Coordenadas: hoje a coluna é double precision sem restrição nenhuma,
      -- então (0,0) no golfo da Guiné, 999 e 'NaN'::float8 entram sem reclamar —
      -- e uma coordenada NaN envenena toda distância haversine derivada dela.
      -- `between` é falso para NaN, então o NaN é barrado pelo mesmo teste.
      --
      -- `is not null` explícito (P2-9): sem ele, `NULL between -90 and 90` é
      -- NULL, e um CHECK que devolve NULL PASSA — a restrição aceitaria a linha
      -- que o gate acima conta como ofensora. As colunas já são NOT NULL em
      -- schema.sql:80-84, então isto não muda comportamento nenhum; só alinha as
      -- duas metades para que a contagem do gate e a restrição digam a MESMA
      -- coisa (se um dia o NOT NULL cair, elas continuam concordando).
      add constraint rides_origin_coords_valid
        check (
          origin_lat is not null and origin_lng is not null
          and origin_lat between -90 and 90
          and origin_lng between -180 and 180
          and not (origin_lat = 0 and origin_lng = 0)
        ),

      add constraint rides_destination_coords_valid
        check (
          destination_lat is not null and destination_lng is not null
          and destination_lat between -90 and 90
          and destination_lng between -180 and 180
          and not (destination_lat = 0 and destination_lng = 0)
        );
  end if;

  -- ══ `paid` DEIXA DE SER NULLABLE (P2-12) ══════════════════════════════════
  -- schema.sql:104 declara `paid boolean default false` — DEFAULT, não NOT NULL.
  -- Um default só age quando a coluna é OMITIDA; `insert ... (paid) values
  -- (null)` e `update ... set paid = null` gravam NULL sem reclamar, e a policy
  -- de INSERT do passageiro (schema.sql:113-114) autoriza a linha inteira.
  --
  -- NULL aqui envenena a lógica de três valores em todo lugar que lê `paid`:
  --   • a restrição rides_paid_requires_payment_intent acima é
  --     `not paid or stripe_payment_intent_id is not null`. Com paid = NULL isso
  --     é `NULL or false` = NULL — e um CHECK que devolve NULL PASSA. Ou seja: a
  --     restrição que existe justamente para impedir "paga sem PaymentIntent"
  --     seria contornável gravando NULL em vez de true;
  --   • _shared/tipPayout.ts:46-52 filtra por `paid = true`, que também é NULL
  --     para essas linhas — a corrida some do repasse de gorjeta em silêncio.
  -- O NOT NULL é o que fecha o buraco de três valores de uma vez só, em vez de
  -- espalhar `coalesce(paid, false)` por cada leitor.
  --
  -- Ordem: o backfill vem ANTES do `set not null` (senão o ALTER falha em
  -- qualquer linha legada NULL), e os dois vêm DEPOIS das restrições, dentro da
  -- mesma transação e do mesmo ACCESS EXCLUSIVE do topo deste bloco.
  --
  -- O UPDATE de backfill é seguro contra o trigger de A.2 mesmo numa reaplicação
  -- (em que o trigger já existiria): aqui `auth.role()` é NULL — conexão SQL
  -- direta, sem JWT — então v_client é falso e nada é revertido. Ver a nota
  -- "v_role is null" em guard_ride_money_fields.
  --
  -- `false` e não `true` é a escolha CONSERVADORA: uma corrida com paid NULL
  -- nunca teve uma confirmação de cobrança gravada (charge-ride e o webhook
  -- escrevem `paid = true` explicitamente, junto do PaymentIntent), então
  -- assumir "não cobrada" no máximo deixa a corrida fora de um repasse — o erro
  -- oposto pagaria um repasse sem lastro.
  select count(*) into v_null_paid from public.rides where paid is null;

  if v_null_paid > 0 then
    raise notice
      '0065: % corrida(s) com paid NULL em public.rides — normalizando para false antes do NOT NULL.',
      v_null_paid;
    update public.rides set paid = false where paid is null;
  end if;

  -- `alter column ... set not null` varre a tabela; é a mesma varredura que os
  -- ADD CONSTRAINT acima já pagaram, sob o mesmo lock. Idempotente: se a coluna
  -- já for NOT NULL o ALTER é no-op no Postgres, mas o `if` evita até isso.
  if exists (
    select 1 from pg_attribute
     where attrelid = 'public.rides'::regclass
       and attname  = 'paid'
       and attnum   > 0
       and not attisdropped
       and not attnotnull
  ) then
    alter table public.rides alter column paid set not null;
  end if;
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- A. rides — dinheiro imutável para o cliente, split calculado no servidor
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- A.1 — a aritmética do split, em UM lugar só.
-- ─────────────────────────────────────────────────────────────────────────────
-- Gêmea de composeRideSplit() em src/lib/split.ts. Economia preservada
-- integralmente:
--
--   fare         = price - toll - venueFee   (com os componentes GRAMPEADOS, ver abaixo)
--   driverShare  = round(fare * share, 2)    -- share de profiles.driver_share_percent
--   platformCut  = fare - driverShare
--   driver_amount= driverShare + toll        -- pedágio: pass-through ao motorista
--   platform_fee = platformCut  + venueFee   -- taxa aeroporto/porto: regulatória
--
-- `share` NULL ou fora de (0,1] cai em 0.80.
--
-- O GRAMPO (clamp) é o conserto de um roubo direto, e tem DOIS níveis.
--
-- Nível 1 — a SOMA não passa do preço. `greatest(fare, 0)` sozinho conserta o
-- SINAL mas transforma um pedágio inflado em pass-through integral: com
-- price = 1.00 e toll_amount = 2000.00 (que o CHECK de componentes, que só olha
-- 0..2000, aceitava sem relacionar com o preço), fare = 0 e
-- driver_amount = 2000.00 — repasse de $2000 sobre uma cobrança de $1. Somado
-- ao fato de que uma corrida forjada não tem PaymentIntent (logo o transfer sai
-- sem `source_transaction`, direto do saldo da plataforma), isso é furto.
--
-- Nível 2 (P0-1) — CADA componente tem teto próprio. O nível 1 sozinho ainda
-- deixa passar `toll = price`: fare = 0 → driver_cut = 0 →
-- driver_amount = 0 + toll = price e platform_fee = 0. Repasse de 100% e
-- comissão ZERO — e "internamente consistente", porque a soma continua fechando
-- exatamente em `price` (era por isso que rides_driver_amount_sane aceitava:
-- price + 0 <= price). O espelho disso, airport_port_fee = price, zera o repasse
-- do MOTORISTA numa corrida real. Por isso cada componente é grampeado em
-- `least(60% do preço, $120)` ANTES da soma; a justificativa das duas constantes
-- está na restrição rides_fee_components_bounded_by_price (bloco D, no topo do
-- arquivo), que aplica a MESMA regra na entrada.
--
-- O QUE ESTE GRAMPO NÃO É: ele não fecha o saque por auto-negócio. `price`
-- continua vindo do cliente (escopo declarado acima) e charge-ride/index.ts:101
-- cobra `r.price` verbatim, autorizando o próprio passageiro (:73) — quem cobra
-- o PRÓPRIO cartão continua extraindo a maior parte de qualquer valor que
-- escolher. O buraco do pedágio elevava isso a 100% E zerava a comissão em TODA
-- corrida de um app modificado; o grampo devolve um PISO DE COMISSÃO. É
-- LIMITAÇÃO DE ESTRAGO, não cura — a cura é derivar price/toll/fee no servidor
-- (TODO do bloco D).
--
-- QUANTO O GRAMPO REALMENTE DEVOLVE (o número exato, porque a versão anterior
-- deste comentário dizia "80-85%" e isso estava ERRADO). Com venueFee = 0 e
-- pedágio t, o repasse é
--     driver_amount = share·(price − t) + t = share·price + t·(1 − share),
-- crescente em t, então o extrator escolhe o maior t que o teto permite,
-- t = least(0.60·price, 120). Para price <= $200 o teto que morde é o dos 60%, e
--     driver_amount = price·(0.40·share + 0.60)
--     platform_fee  = price·0.40·(1 − share)
-- ou seja, o piso de comissão é 40%·(1 − share) do preço:
--     faixa 0.850 → comissão 6% do preço → extração máxima 94,0%
--     faixa 0.800 → comissão 8% do preço → extração máxima 92,0%
-- Acima de $200 o teto absoluto de $120 passa a morder e a fração cai de volta
-- na direção de `share` conforme o preço cresce (em price = $1000, faixa 0.850:
-- 868/1000 = 86,8%). Portanto o pior caso do grampo é 94%, atingido em preços
-- até $200 — NÃO 85%. O próprio teste do repositório fixa esse número:
-- src/lib/__tests__/split.test.ts:177-179, composeRideSplit(100, 100, 0, 0.85)
-- → { driverAmount: 94, platformFee: 6 }.
--
-- Seis por cento BRUTOS de uma cobrança forjada de $100 é quase tudo consumido
-- pela taxa do Stripe sobre a mesma cobrança. Ou seja: o grampo garante que a
-- comissão não seja ZERO, e é só isso que ele garante. Ler este bloco como "o
-- auto-negócio foi limitado à faixa normal de 80-85%" é ler errado.
--
-- Com os dois níveis, toll e venueFee nunca somam mais que `price`, e portanto
-- driver_amount + platform_fee = price SEMPRE. Os CHECKs
-- rides_fee_components_within_price e rides_fee_components_bounded_by_price
-- (bloco D) fecham as mesmas duas portas na entrada.
--
-- Arredondamento: `round(numeric, 2)` do Postgres é half-away-from-zero sobre
-- decimal EXATO. O lado TS agora calcula em centavos inteiros com o mesmo
-- critério de desempate — ver a nota de paridade em src/lib/split.ts.
create or replace function public.compute_ride_split(
  p_price  numeric,
  p_toll   numeric,
  p_venue  numeric,
  p_share  numeric,
  out o_driver_amount numeric,
  out o_platform_fee  numeric
)
language plpgsql
immutable
set search_path = public, pg_catalog
as $$
declare
  v_price numeric := greatest(coalesce(p_price, 0), 0);
  v_toll  numeric := greatest(coalesce(p_toll,  0), 0);
  v_venue numeric := greatest(coalesce(p_venue, 0), 0);
  v_share numeric := p_share;
  v_ceiling numeric;
  v_fare  numeric;
  v_driver_cut numeric;
begin
  -- Mesma guarda de calculateSplit() contra valor nulo/corrompido no banco.
  if v_share is null or v_share <= 0 or v_share > 1 then
    v_share := 0.80;
  end if;

  -- Grampo nível 2 (P0-1): teto POR COMPONENTE, `least(60% do preço, $120)`.
  -- Idêntico, caractere a caractere, ao CHECK rides_fee_components_bounded_by_price
  -- e a composeRideSplit() em src/lib/split.ts. `floor(v_price * 60) / 100`
  -- (e não `v_price * 0.60`) mantém o teto num múltiplo exato de centavo, que é
  -- o que o lado TS consegue reproduzir trabalhando em centavos inteiros.
  v_ceiling := least(floor(v_price * 60) / 100, 120);
  v_toll  := least(v_toll,  v_ceiling);
  v_venue := least(v_venue, v_ceiling);

  -- Grampo nível 1: os componentes NUNCA podem, juntos, passar do preço cobrado.
  -- Ordem importa — o pedágio (que vai ao motorista) tem precedência sobre a
  -- taxa de local (que fica com a plataforma), então o excesso é cortado da
  -- taxa primeiro. Nenhuma corrida real chega aqui: numa linha sã nenhum dos
  -- dois níveis muda nada.
  v_toll  := least(v_toll, v_price);
  v_venue := least(v_venue, v_price - v_toll);

  v_fare       := round(v_price - v_toll - v_venue, 2);
  v_driver_cut := round(v_fare * v_share, 2);

  o_driver_amount := round(v_driver_cut + v_toll, 2);
  o_platform_fee  := round((v_fare - v_driver_cut) + v_venue, 2);
end;
$$;

comment on function public.compute_ride_split(numeric, numeric, numeric, numeric) is
  'Aritmética do split de uma corrida (pedágio pass-through, taxa de local para a plataforma), com cada componente grampeado em least(60% do preço, $120) e a soma grampeada ao preço. Gêmea de composeRideSplit() em src/lib/split.ts.';

-- P2-7: mesmas permissões de apply_driver_split/assign_driver_tier. Sem isto,
-- `compute_ride_split` nascia com o EXECUTE implícito de PUBLIC (padrão do
-- Postgres para funções) e ficava exposta como RPC do PostgREST para anon e
-- authenticated. Não escreve nada — é pura — mas é a definição da economia da
-- plataforma; não há motivo para publicá-la, e uma função pública é superfície
-- de fingerprint da regra de comissão.
--
-- Quem a chama continua chamando: guard_ride_money_fields e apply_driver_split
-- são SECURITY DEFINER, executam como o DONO da função e o dono sempre tem
-- EXECUTE sobre o que criou — o revoke abaixo não os afeta.
revoke all on function public.compute_ride_split(numeric, numeric, numeric, numeric) from public;
revoke all on function public.compute_ride_split(numeric, numeric, numeric, numeric) from anon;
revoke all on function public.compute_ride_split(numeric, numeric, numeric, numeric) from authenticated;
grant execute on function public.compute_ride_split(numeric, numeric, numeric, numeric) to service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- A.2 — o guard + o split.
-- ─────────────────────────────────────────────────────────────────────────────
-- Contrato do GUC (Postgres não tem constante de schema; fica como comentário):
--   app.ride_money_write = <uuid da corrida cuja escrita de dinheiro está autorizada>
create or replace function public.guard_ride_money_fields()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  -- auth.role() lê request.jwt.claims e é chamada em TODA linha; uma variável
  -- em vez de duas chamadas por linha.
  v_role    text := auth.role();
  v_client  boolean;
  v_allowed text;
  v_share   numeric;
  v_split   record;
begin
  -- Backend (edge functions com service key: charge-ride, tip-ride,
  -- run-weekly-payouts, request-payout, stripe-webhook) escreve à vontade.
  --
  -- `v_role is null` = não há JWT nenhum na sessão, ou seja, é uma conexão SQL
  -- direta (migração, psql, SQL editor do painel) — quem tem credencial de banco
  -- já poderia derrubar este trigger, então travá-lo aí só criaria um footgun
  -- para correção manual. Todo tráfego que vem pela API tem claim de papel
  -- ('anon' ou 'authenticated'), nunca null. Mesma semântica efetiva do guard de
  -- perfis de 0018/0043/0055.
  v_client := not (v_role is null or v_role = 'service_role');

  -- ══ INSERT ════════════════════════════════════════════════════════════════
  if tg_op = 'INSERT' then
    if v_client then
      -- O id NÃO é escolhido pelo cliente (ver "DOIS GUCs" no topo). Seguro
      -- sobrescrever: requestRide/scheduleRide não usam RETURNING — releem a
      -- corrida com um SELECT separado por passenger_id + status + created_at
      -- (useRide.ts:617-625 e :715-724), justamente porque o RETURNING pós-insert
      -- esbarrava na RLS. Nenhum caminho do app depende do id que ele mandou.
      --
      -- ⚠️ ARMADILHA FUTURA — NÃO USE `.upsert()` / `insert ... on conflict`
      -- EM `rides` PELO CLIENTE (P2-6).
      -- Num `insert ... on conflict`, os triggers BEFORE INSERT rodam ANTES da
      -- arbitragem do conflito, e é a linha JÁ MODIFICADA por eles que vai à
      -- arbitragem. Como esta atribuição sorteia um id novo, o conflito nunca
      -- acontece: o "upsert" viraria INSERT sempre, duplicando a corrida em
      -- silêncio (sem erro, sem log) em vez de atualizar a existente. O mesmo
      -- vale para qualquer índice único que venha a incluir `id`.
      -- Hoje nenhum call site faz isso — useRide.ts:625 e :723 usam `.insert()`
      -- puro (conferido com grep em src/ inteiro; o único `.upsert()` do app é
      -- em `profiles`, AddCardOnboardingScreen.tsx:455, que não passa por aqui).
      -- Se um dia precisar de upsert de corrida, o caminho é uma RPC
      -- SECURITY DEFINER — não relaxar esta linha.
      --
      -- Por que não "levantar erro se o cliente mandou um id explícito": não há
      -- como distinguir. `rides.id` tem `default gen_random_uuid()`, então
      -- quando o trigger BEFORE INSERT roda, NEW.id já vem preenchido — pelo
      -- cliente ou pelo default, indistinguivelmente. Não existe `NEW.id IS
      -- DEFAULT` em plpgsql. Daí a escolha de sobrescrever sempre e documentar.
      new.id := gen_random_uuid();

      -- Toda coluna de dinheiro nasce no default do SERVIDOR. É isto que fecha
      -- o exploit do insert forjado: sem `paid`, sem `driver_amount` e sem
      -- PaymentIntent, a linha jamais passa pela elegibilidade de repasse.
      --
      -- `price`, `toll_amount` e `airport_port_fee` ficam DE FORA de propósito
      -- (escopo declarado no topo) — continuam vindo do cliente no insert e
      -- ficam congelados a partir daí.
      new.driver_amount            := null;
      new.platform_fee             := null;
      new.paid                     := false;
      new.payout_id                := null;
      new.tip_payout_id            := null;
      new.tip_amount               := null;
      new.stripe_payment_intent_id := null;
      new.tip_payment_intent_id    := null;
    end if;

    -- Corrida que já nasce com motorista é o caminho do QR (options.lockedDriverId
    -- em requestRide/scheduleRide): o `driver_id` já é conhecido no insert e a
    -- corrida pré-confirmada vai de 'scheduled' direto para 'accepted' em
    -- activate(), SEM nunca passar por um UPDATE que mude driver_id. Se o split
    -- não fosse aplicado aqui, esse caminho ficaria no padrão para sempre — que
    -- é exatamente o bug que pagava 80% a motorista de 85% em toda corrida por QR.
    --
    -- Só calcula quando ainda não há valor: um insert de service_role que traga
    -- driver_amount explícito é respeitado (backfill/migração de dados).
    if new.driver_id is not null and new.driver_amount is null then
      select p.driver_share_percent into v_share
        from public.profiles p where p.id = new.driver_id;
      select * into v_split
        from public.compute_ride_split(new.price, new.toll_amount, new.airport_port_fee, v_share);
      new.driver_amount := v_split.o_driver_amount;
      new.platform_fee  := v_split.o_platform_fee;
    end if;

    return new;
  end if;

  -- ══ UPDATE ════════════════════════════════════════════════════════════════
  if v_client then
    -- Escrita autorizada pela própria apply_driver_split, e SÓ para esta linha.
    v_allowed := current_setting('app.ride_money_write', true);

    if v_allowed is null or v_allowed is distinct from new.id::text then
      -- É o cliente. Reverte cada coluna de dinheiro ao valor antigo, sem
      -- levantar exceção — mesma estratégia de guard_profile_privileged_fields
      -- (0018/0043/0055). Levantar erro quebraria os UPDATEs legítimos que por
      -- acaso mandem a coluna junto no payload; o reverso silencioso deixa o
      -- resto do UPDATE passar.
      --
      -- IMPORTANTE: as colunas que o app REALMENTE precisa escrever ficam de fora
      -- desta lista e continuam funcionando — status, driver_id, accepted_at,
      -- completed_at, cancelled_at, boarded_at, passenger_confirmed_driver_at,
      -- driver_lat/lng/heading, driver_eta_min/km, route_*. Conferido contra todos
      -- os call sites de UPDATE em src/ (useRide.ts, useDriverScheduledRides.ts,
      -- DriverNavigateScreen.tsx, GlobalDriverRideOverlay.tsx,
      -- nav/backgroundLocationTask.ts): nenhum deles toca as colunas abaixo.

      -- ── QUEM PAGA (P0-3) ────────────────────────────────────────────────
      -- `passenger_id` é COLUNA DE DINHEIRO: é ela que seleciona DE QUEM o
      -- cartão é cobrado. charge-ride/index.ts lê `r.passenger_id` da corrida,
      -- busca o `stripe_customer_id`/`stripe_payment_method_id` DAQUELE perfil e
      -- cria o PaymentIntent com `off_session: true` sobre ele. (Sem número de
      -- linha de propósito: aquele arquivo está sendo editado em paralelo; a
      -- âncora estável é a sequência select passenger_id → select stripe_* →
      -- paymentIntents.create.) Trocar esta coluna depois do insert redireciona
      -- a cobrança para um terceiro.
      --
      -- O ATAQUE que isto fecha (cobrança no cartão de um ESTRANHO): crio uma
      -- corrida minha com price alto (o insert é legítimo — a policy de INSERT
      -- exige `auth.uid() = passenger_id`), depois dou um UPDATE trocando
      -- `passenger_id` pelo uuid da vítima (uuids alheios são legíveis em
      -- `profiles_public`, 0049:45) e chamo charge-ride. A RLS não barra: o
      -- `using` roda na PRÉ-imagem, onde `auth.uid() = passenger_id` ainda é
      -- verdadeiro, e o `with check` roda na PÓS-imagem, onde o ramo
      -- `status = 'requesting' and driver_id is null` é verdadeiro sem olhar
      -- para quem eu sou. Sem esta linha (e sem `passenger_id` na lista de
      -- colunas do CREATE TRIGGER, mais abaixo), um UPDATE que toque SÓ esta
      -- coluna nem sequer acorda este trigger.
      --
      -- Não quebra nada: `passenger_id` só é ESCRITO em INSERT, nunca em UPDATE.
      -- Conferido por grep em src/ e supabase/functions/ inteiros — as duas
      -- únicas ocorrências como chave de payload de escrita são
      -- useRide.ts:604 (requestRide) e :701 (scheduleRide), ambas em
      -- `insertPayload` de `.insert()`. Nenhum `.update()` de `rides`, em app ou
      -- edge function, menciona a coluna; do lado SQL, os únicos `update
      -- public.rides` fora deste arquivo (0060:277, 0061:45) também não a tocam.
      -- E o INSERT continua normal: este bloco é o ramo de UPDATE, e no insert a
      -- policy `with check (auth.uid() = passenger_id)` (schema.sql:113-114) já
      -- garante que o passageiro só cria corrida em nome de si mesmo.
      new.passenger_id := old.passenger_id;

      -- Tarifa cobrada do passageiro.
      new.price := old.price;

      -- Split (calculado logo abaixo / por apply_driver_split).
      new.driver_amount := old.driver_amount;
      new.platform_fee  := old.platform_fee;

      -- Componentes da tarifa: pedágio é pass-through ao motorista e a taxa de
      -- aeroporto/porto fica com a plataforma — mexer neles move dinheiro tanto
      -- quanto mexer no preço.
      new.toll_amount      := old.toll_amount;
      new.airport_port_fee := old.airport_port_fee;

      -- "Foi cobrada?" — quem responde é o charge-ride, depois do Stripe confirmar.
      new.paid := old.paid;

      -- Reserva de repasse. Limpar payout_id devolveria a corrida ao saldo
      -- pendente e permitiria receber o mesmo dinheiro duas vezes.
      new.payout_id     := old.payout_id;
      new.tip_payout_id := old.tip_payout_id;

      -- Gorjeta: cobrada por tip-ride (PaymentIntent próprio, ver 0064) e
      -- repassada 100% ao motorista. Escrever tip_amount à mão = repasse sem
      -- cobrança.
      new.tip_amount := old.tip_amount;

      -- Ponteiros para o Stripe: lastreiam os transfers via source_transaction.
      new.stripe_payment_intent_id := old.stripe_payment_intent_id;
      new.tip_payment_intent_id    := old.tip_payment_intent_id;
    end if;
  end if;

  -- ══ QUEM PODE MEXER EM driver_id (P0-2) ═══════════════════════════════════
  -- `driver_id` fica FORA da lista de reversão acima de propósito (o app precisa
  -- escrevê-lo para aceitar/liberar), mas "fora da lista" não pode significar
  -- "livre": ele é quem RECEBE o dinheiro. A policy de UPDATE (schema.sql:116-122,
  -- repetida em 0041) é `for update using (...)` SEM `with check`; o Postgres
  -- então reusa o USING como WITH CHECK, e o ramo `auth.uid() = passenger_id`
  -- autoriza a LINHA inteira — nenhuma coluna fica restrita para o passageiro.
  --
  -- O ATAQUE que isto fecha (furto de TERCEIRO, não auto-negócio): o passageiro A
  -- termina uma corrida real com o motorista D (status 'completed', paid = true,
  -- driver_amount = 42.30, payout_id ainda nulo até o cron de segunda). O trigger
  -- de 0042 já barra a troca direta D -> B, mas não barra a mesma coisa em dois
  -- statements:
  --     update rides set driver_id = null where id = ...;   -- 0042 permite X->NULL
  --     update rides set driver_id = B    where id = ...;   -- 0042 permite NULL->Y
  -- O bloco de split logo abaixo então recalcula com a faixa de B e produz um
  -- número internamente consistente, o repasse vai para B, e D perde a corrida
  -- SEM ERRO NENHUM. A gorjeta segue junto: _shared/tipPayout.ts:44-50 filtra
  -- por driver_id.
  --
  -- A REGRA. Para o cliente, só duas transições existem, e as duas com o próprio
  -- usuário de um dos lados:
  --     NULL          -> auth.uid()   (reivindicar/aceitar)
  --     auth.uid()    -> NULL         (liberar/recusar)
  -- e só enquanto a corrida ainda está aberta ('requesting'/'scheduled'), que é
  -- o único estado em que o app faz qualquer uma das duas. Qualquer outra coisa
  -- é revertida em silêncio (mesma estratégia do bloco acima: não levantar
  -- exceção para não quebrar um UPDATE legítimo que mande a coluna junto).
  -- Como toda transição exige auth.uid() de um dos lados, um passageiro NUNCA
  -- consegue desanexar o motorista de ninguém — o primeiro dos dois statements
  -- do ataque acima já é revertido.
  --
  -- ATENÇÃO — a versão "óbvia" desta regra (`if old.paid or old.status in
  -- ('completed','cancelled') then reverter`) QUEBRARIA O ACEITE. Em acceptRide
  -- a cobrança acontece ANTES de travar a corrida (useRide.ts:1624 chama
  -- chargeRide, que grava paid = true; só em :1674 vem o UPDATE que grava
  -- driver_id), então no instante do aceite `old.paid` JÁ É TRUE numa corrida
  -- perfeitamente legítima. Por isso o critério aqui é o STATUS ANTIGO, nunca
  -- `old.paid`. (`old.status` é 'requesting' nesse UPDATE — o próprio call site
  -- filtra por `.eq('status','requesting')`.)
  --
  -- Conferido contra TODOS os call sites que escrevem driver_id (grep em src/):
  --   useRide.ts:1674 acceptRide           old NULL/self -> self, old.status 'requesting' ✓
  --   useRide.ts:922  claimScheduledRide   old NULL/self -> self, old.status 'scheduled'  ✓
  --   useRide.ts:1791 confirmScheduledRide old NULL/self -> self, old.status 'scheduled'  ✓
  --   useRide.ts:1863 rejectScheduledRide  self -> NULL,          old.status 'scheduled'  ✓
  --   useDriverScheduledRides.ts:229 release  self -> NULL,       old.status 'scheduled'  ✓
  -- (nos três primeiros, o caso "self -> self" nem chega aqui: `is distinct
  -- from` é falso.)
  --
  -- E O FLUXO DO QR? Confirmado que o PASSAGEIRO nunca escreve driver_id num
  -- UPDATE. No QR ele grava driver_id no INSERT (options.lockedDriverId,
  -- useRide.ts:620 e :718) — INSERT não passa por este bloco. Depois disso quem
  -- mexe é sempre o motorista: confirmQrScheduledRide (useRide.ts:1832) grava só
  -- `accepted_at`, rejectScheduledRide devolve driver_id a NULL, e a recusa da
  -- corrida imediata travada por QR (GlobalDriverRideOverlay.tsx:185-194) grava
  -- `status = 'cancelled'` sem tocar em driver_id. Nenhum caminho quebra.
  --
  -- O motor de dispatch v2 também não escreve `rides.driver_id`: accept_trip_offer
  -- (0054) só mexe em trip_requests/ride_offers/dispatch_events; quem grava a
  -- corrida continua sendo o UPDATE do cliente em useRide.ts:1674, já coberto
  -- acima. As edge functions usam service key (v_client = false) e passam direto.
  -- ⚠️ LÓGICA DE TRÊS VALORES — POR QUE `auth.uid() is null` VEM PRIMEIRO (P1-2).
  -- A versão anterior era `if not (<d1> or <d2>) then reverter`, com as duas
  -- comparações escritas como `= auth.uid()`. Quando `auth.uid()` é NULL — um
  -- chamador cujo JWT não carrega claim `sub`, o caso típico sendo a ANON KEY
  -- crua, para a qual `auth.role()` é 'anon' e portanto v_client é TRUE (ver a
  -- atribuição de v_client acima) — a expressão desmoronava assim:
  --     d1 = TRUE and NULL and TRUE = NULL
  --     d2 = NULL and FALSE         = FALSE
  --     NULL or FALSE = NULL → not NULL = NULL → o `if` NÃO executa
  -- ou seja, para esse chamador o guard inteiro virava enfeite e a reversão
  -- nunca acontecia. E era alcançável: nas corridas abertas os ramos 3 e 4 da
  -- policy de UPDATE (`status = 'requesting'/'scheduled' and driver_id is null`)
  -- são verdadeiros SEM olhar auth.uid(), e a policy não tinha `to authenticated`
  -- — hoje tem (ver A.4), o que é a segunda metade deste conserto.
  --
  -- FALHA FECHADA agora, por dois motivos independentes:
  --   • `auth.uid() is null or ...` reverte SEMPRE que não há usuário — nenhuma
  --     transição é legítima sem um `auth.uid()` de um dos lados, então "não sei
  --     quem é" só pode significar "não pode";
  --   • `is not distinct from` no lugar de `=` devolve TRUE/FALSE, nunca NULL,
  --     então as duas disjunções deixam de propagar NULL mesmo se o primeiro
  --     teste um dia sair daqui.
  -- (`old.status` não entra nessa conta: a coluna é NOT NULL em schema.sql:86.)
  if v_client and new.driver_id is distinct from old.driver_id then
    if auth.uid() is null
       or not (
         (old.driver_id is null
          and new.driver_id is not distinct from auth.uid()
          and old.status in ('requesting', 'scheduled'))
      or (old.driver_id is not distinct from auth.uid()
          and new.driver_id is null
          and old.status in ('requesting', 'scheduled'))
    ) then
      new.driver_id := old.driver_id;
    end if;
  end if;

  -- ══ SPLIT ATÔMICO COM O ACEITE ════════════════════════════════════════════
  -- O motorista entrou na corrida (ou foi trocado) neste mesmo statement:
  -- aplica a fatia REAL dele agora, na linha que já está sendo gravada. Sem RPC
  -- separada, sem janela, sem depender de o app ter rede no segundo seguinte.
  --
  -- `payout_id is null` porque dinheiro já reservado num repasse não se mexe:
  -- alterar driver_amount depois do payout descasaria o valor transferido no
  -- Stripe do valor no banco.
  --
  -- `driver_amount is not distinct from old` deixa o service_role gravar
  -- driver_id e driver_amount JUNTOS num backfill sem ter o valor sobrescrito.
  -- Para o cliente essa condição é sempre verdadeira: o bloco acima acabou de
  -- reverter driver_amount ao valor antigo.
  --
  -- Não há recursão: atribuir a NEW num trigger BEFORE não dispara UPDATE nenhum.
  if new.driver_id is not null
     and new.driver_id is distinct from old.driver_id
     and new.payout_id is null
     and new.driver_amount is not distinct from old.driver_amount then
    select p.driver_share_percent into v_share
      from public.profiles p where p.id = new.driver_id;
    select * into v_split
      from public.compute_ride_split(new.price, new.toll_amount, new.airport_port_fee, v_share);
    new.driver_amount := v_split.o_driver_amount;
    new.platform_fee  := v_split.o_platform_fee;
  end if;

  return new;
end;
$$;

comment on function public.guard_ride_money_fields() is
  'INSERT: zera as colunas de dinheiro do cliente e sorteia o id. UPDATE: reverte escritas do cliente nessas colunas e limita driver_id às transições NULL<->proprio usuario com a corrida ainda aberta. Nos dois: calcula driver_amount/platform_fee quando o motorista entra na corrida. service_role e apply_driver_split (via GUC app.ride_money_write) passam.';

-- `before insert or update of <colunas>`: a lista de colunas vale só para o
-- UPDATE (o INSERT sempre escreve a linha inteira, não existe lista ali). Sem a
-- lista, o trigger rodaria em TODA atualização de telemetria — useRide.ts:1736,
-- nav/backgroundLocationTask.ts:113, DriverNavigateScreen.tsx:674 — que são
-- dezenas por corrida e não tocam dinheiro nenhum.
--
-- `driver_id` PRECISA estar na lista: é ele que dispara o cálculo do split no
-- aceite. O UPDATE de aceite (useRide.ts:1651) manda driver_id + status +
-- accepted_at, então o trigger acorda; o de telemetria manda só driver_lat/lng/
-- eta, então não acorda.
--
-- `passenger_id` PRECISA estar na lista pelo motivo OPOSTO (P0-3): a lista é um
-- filtro de ACORDAR, então uma coluna ausente dela é uma coluna que o trigger
-- nunca vê. Um `update rides set passenger_id = <vítima>` isolado não menciona
-- nenhuma outra coluna de dinheiro; sem esta entrada, a reversão escrita no
-- corpo da função seria letra morta para exatamente o statement que ela existe
-- para barrar. Nenhum caminho legítimo escreve a coluna em UPDATE (ver a nota no
-- corpo da função), então acordar por ela não custa nada em volume.
drop trigger if exists trg_guard_ride_money_fields on public.rides;
create trigger trg_guard_ride_money_fields
  before insert or update of
    passenger_id,
    driver_id,
    price,
    driver_amount,
    platform_fee,
    toll_amount,
    airport_port_fee,
    paid,
    payout_id,
    tip_payout_id,
    tip_amount,
    stripe_payment_intent_id,
    tip_payment_intent_id
  on public.rides
  for each row execute function public.guard_ride_money_fields();

-- ─────────────────────────────────────────────────────────────────────────────
-- A.4 — a policy de UPDATE ganha um `with check` EXPLÍCITO
-- ─────────────────────────────────────────────────────────────────────────────
-- A policy "Motorista aceita corrida" (schema.sql:116, reescrita em 0041:28)
-- declara só `using (...)`. Quando `with check` é omitido numa policy de UPDATE,
-- o Postgres REUSA a expressão do `using` como `with check` — ou seja, o efeito
-- prático hoje já é o de baixo. O problema é que isso é implícito: qualquer
-- reescrita futura que acrescente um `with check` diferente (ou que troque o
-- `using` achando que só mexe na pré-imagem) muda o comportamento da pós-imagem
-- sem que ninguém perceba. Escrever as duas metades deixa a intenção no papel.
--
-- ORDEM DE AVALIAÇÃO (é o que faz este `with check` COMPOR com o trigger em vez
-- de duplicá-lo): `using` roda sobre a PRÉ-imagem, antes de tudo; os triggers
-- BEFORE ROW rodam depois e podem reescrever o NEW; o `with check` roda por
-- último, sobre a PÓS-imagem JÁ CORRIGIDA pelo trigger. Então o guard de
-- driver_id de A.3 é a defesa que enxerga a transição (old → new), e o
-- `with check` é a defesa que enxerga só o estado final.
--
-- CADA CAMINHO LEGÍTIMO CONTINUA PASSANDO na pós-imagem (verificado nos call
-- sites, não deduzido):
--   • motorista aceita (useRide.ts:1674) → driver_id = auth.uid()   → ramo 2;
--   • motorista confirma agendamento (useRide.ts:1791)              → ramo 2;
--   • motorista libera agendamento (useDriverScheduledRides.ts:229) e recusa
--     agendamento por QR (useRide.ts:1863) → driver_id null com o status ainda
--     'scheduled' (as duas queries têm `.eq('status','scheduled')`) → ramo 4;
--   • motorista avança status da própria corrida                    → ramo 2;
--   • passageiro edita/cancela a própria corrida                    → ramo 1;
--   • telemetria do motorista                                       → ramo 2.
--
-- O QUE ELE NÃO RESOLVE: para o passageiro o ramo 1 (`auth.uid() =
-- passenger_id`) é verdadeiro em QUALQUER pós-imagem da própria corrida, então
-- este `with check` não trava nada do lado do passageiro — quem trava é o
-- trigger. O ganho real aqui é do lado do motorista: ele não consegue mais
-- deixar a linha num estado que ele próprio não poderia mais ler/atualizar
-- (ex.: soltar driver_id fora de 'scheduled'/'requesting').
--
-- `TO AUTHENTICATED` (P1-2). A policy original (schema.sql:116, 0041:28) não
-- declarava papel, e uma policy sem `to` vale para PUBLIC — inclusive para
-- `anon`. Como os ramos 3 e 4 (`status = 'requesting'/'scheduled' and driver_id
-- is null`) são verdadeiros sem referência a auth.uid(), a anon key crua tinha
-- UPDATE autorizado em toda corrida aberta, e é justamente o chamador para quem
-- `auth.uid()` é NULL — o buraco de lógica de três valores consertado em A.3.
-- Defesa em profundidade: A.3 fecha o comportamento, isto fecha o acesso.
--
-- NÃO QUEBRA NENHUM FLUXO LEGÍTIMO (verificado, não deduzido):
--   • o app tem UM único cliente Supabase (src/lib/supabase.ts:39), criado com a
--     anon key mas com sessão persistida; depois do login toda requisição leva o
--     JWT do usuário e o papel é 'authenticated'. Todos os call sites de UPDATE
--     em `rides` (useRide.ts, useDriverScheduledRides.ts, DriverNavigateScreen,
--     GlobalDriverRideOverlay, nav/backgroundLocationTask) rodam em telas/hooks
--     que já exigem `profile.id`, ou seja, sessão ativa;
--   • nas edge functions, TODA escrita em `rides` usa o cliente `admin`
--     (service key), que não passa por RLS. O cliente de anon key aparece em 14
--     functions e em todas elas só para `anonClient.auth.getUser()` — resolver a
--     identidade do chamador, nunca ler ou escrever a tabela;
--   • `service_role` continua ignorando RLS por definição, então `to
--     authenticated` não o afeta.
drop policy if exists "Motorista aceita corrida" on public.rides;

create policy "Motorista aceita corrida" on public.rides
  for update
  to authenticated
  using (
    auth.uid() = passenger_id
    or auth.uid() = driver_id
    or (status = 'requesting' and driver_id is null)
    or (status = 'scheduled' and driver_id is null)
  )
  with check (
    auth.uid() = passenger_id
    or auth.uid() = driver_id
    or (status = 'requesting' and driver_id is null)
    or (status = 'scheduled' and driver_id is null)
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- B. profiles — o perfil nasce sem privilégio, e continua sem
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- B.1 — UPDATE: guard de 0018/0043/0055 preservado INTEGRALMENTE (type,
-- is_admin, verification_*, jurisdiction) + os campos de dinheiro.
-- ─────────────────────────────────────────────────────────────────────────────
-- `set search_path` acrescentado aqui (herdado sem ele de 0018/0043/0055): uma
-- função SECURITY DEFINER sem search_path fixo resolve nomes pelo search_path de
-- QUEM chama, o que é a receita clássica de sequestro por objeto homônimo. Como
-- 0065 já reescreve o corpo, o conserto entra junto. `auth.role()`/`auth.uid()`
-- continuam qualificadas com o schema, então nada quebra por elas não estarem no
-- caminho.
create or replace function public.guard_profile_privileged_fields()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_role    text := auth.role();
  v_allowed text;
begin
  if v_role is null or v_role = 'service_role' then
    return new;
  end if;

  -- Mesma válvula do guard de rides: assign_driver_tier (0037) é SECURITY
  -- DEFINER e grava driver_share_percent/driver_onboarded_seq. Hoje ela só é
  -- chamada com service key, mas se um dia for chamada de um contexto
  -- autenticado, auth.role() diria 'authenticated' e a atribuição de faixa
  -- seria revertida em silêncio. O GUC cobre esse caso.
  v_allowed := current_setting('app.profile_money_write', true);

  -- Papel é imutável para o próprio usuário: reverte qualquer troca.
  -- Só o service_role (migração/admin) pode reatribuir, se algum dia preciso.
  if new.type is distinct from old.type then
    new.type := old.type;
  end if;

  if new.is_admin is distinct from old.is_admin then
    new.is_admin := old.is_admin;
  end if;

  if new.verification_status is distinct from old.verification_status then
    -- O próprio motorista só pode mover unsubmitted/rejected -> pending
    -- (reenvio de documentos). Qualquer outra transição é revertida.
    if new.verification_status = 'pending'
       and old.verification_status in ('unsubmitted', 'rejected') then
      null; -- permitido
    else
      new.verification_status := old.verification_status;
    end if;
  end if;

  if new.verification_reviewed_by is distinct from old.verification_reviewed_by then
    new.verification_reviewed_by := old.verification_reviewed_by;
  end if;
  if new.verification_reviewed_at is distinct from old.verification_reviewed_at then
    new.verification_reviewed_at := old.verification_reviewed_at;
  end if;
  if new.verification_notes is distinct from old.verification_notes then
    new.verification_notes := old.verification_notes;
  end if;

  -- Jurisdição gate rollouts de feature flag (ex.: dispatch_engine_v2) — o
  -- próprio usuário não pode se auto-atribuir a um piloto revertendo o valor.
  if new.jurisdiction is distinct from old.jurisdiction then
    new.jurisdiction := old.jurisdiction;
  end if;

  -- ── NOVO em 0065: dinheiro ──────────────────────────────────────────────
  -- A faixa de comissão vale para SEMPRE (0037) e define quanto sai da
  -- plataforma em cada repasse. Um motorista que consiga gravar 1.000 aqui
  -- passa a receber 100% de toda corrida. Só assign_driver_tier (via GUC) ou
  -- o backend (admin-commission-tiers) escrevem.
  -- A válvula é o ID DESTE perfil, não um booleano: um GUC residual (a função
  -- o zera para '' depois de usar) não destrava nada.
  if v_allowed is null or v_allowed is distinct from new.id::text then
    if new.driver_share_percent is distinct from old.driver_share_percent then
      new.driver_share_percent := old.driver_share_percent;
    end if;
    if new.driver_onboarded_seq is distinct from old.driver_onboarded_seq then
      new.driver_onboarded_seq := old.driver_onboarded_seq;
    end if;
  end if;

  -- Conta Connect de destino do transfer: apontar para outra conta é desvio
  -- de dinheiro direto. Quem grava é connect-onboard-driver (service key).
  if new.stripe_account_id is distinct from old.stripe_account_id then
    new.stripe_account_id := old.stripe_account_id;
  end if;

  -- Flags que destravam "ficar online" e receber repasse. Espelham o estado
  -- REAL da conta no Stripe (stripe-webhook / connect-account-status); o
  -- motorista não pode se auto-aprovar.
  if new.stripe_charges_enabled is distinct from old.stripe_charges_enabled then
    new.stripe_charges_enabled := old.stripe_charges_enabled;
  end if;
  if new.stripe_payouts_enabled is distinct from old.stripe_payouts_enabled then
    new.stripe_payouts_enabled := old.stripe_payouts_enabled;
  end if;
  if new.stripe_onboarding_complete is distinct from old.stripe_onboarding_complete then
    new.stripe_onboarding_complete := old.stripe_onboarding_complete;
  end if;

  -- ── Cartão do passageiro: a identidade de QUEM PAGA ──────────────────────
  -- charge-ride/index.ts:108-109 e tip-ride/index.ts:100-101 montam o
  -- PaymentIntent com `customer: p.stripe_customer_id` e `payment_method:
  -- p.stripe_payment_method_id` LIDOS DO PERFIL DO PASSAGEIRO — sem nenhuma
  -- conferência de que aquele par pertence a quem está pedindo a corrida.
  -- Enquanto essas duas colunas forem graváveis pelo cliente, um passageiro
  -- pode copiar o cus_/pm_ de outra pessoa para o próprio perfil e passar a
  -- viajar no cartão alheio. (O Stripe só recusa se o payment_method não
  -- estiver anexado àquele customer; um par COERENTE roubado passa.)
  --
  -- Nenhum caminho legítimo escreve isso do cliente — os seis writers reais
  -- usam service key, conferido um a um (não deduzido pelo nome):
  --   setup-card/index.ts:165,178      via `admin` (:119)
  --   sync-card/index.ts:120-121       via `admin` (:52)
  --   set-default-card/index.ts:77     via `admin` (:52)
  --   remove-card/index.ts:92,105      via `admin` (:53)
  --   delete-account/index.ts:78-79    via `admin` (:52)
  --   stripe-webhook/index.ts:188-189  via `admin` (:130)
  -- No app, `patchProfile(cardUpdates)` (AddCardOnboardingScreen.tsx:361) só
  -- mexe no estado em memória do contexto; não é escrita no banco.
  --
  -- ⚠️ QUEBRA UM CAMINHO — de propósito, e só em DEV: `handleDevBypass`
  -- (AddCardOnboardingScreen.tsx:436-464, atrás de `__DEV__` em :525) faz
  -- upsert de 'pm_test_bypass_dev'/'cus_test_bypass_dev' com a chave do
  -- usuário. Depois desta migração esses dois campos serão revertidos EM
  -- SILÊNCIO (o upsert não dá erro, o cartão fictício simplesmente não gruda)
  -- e o bypass deixa de destravar o app. Não é regressão de produção — o botão
  -- nem existe em build de release —, mas quem usa o bypass no dia a dia
  -- precisa passar a semear o cartão de teste com a service key.
  if new.stripe_customer_id is distinct from old.stripe_customer_id then
    new.stripe_customer_id := old.stripe_customer_id;
  end if;
  if new.stripe_payment_method_id is distinct from old.stripe_payment_method_id then
    new.stripe_payment_method_id := old.stripe_payment_method_id;
  end if;

  return new;
end;
$$;

-- Trigger já existe (0018/0055); recriamos por idempotência caso a ordem de
-- aplicação mude. Sem lista de colunas: aqui a lista seria uma armadilha —
-- qualquer coluna privilegiada acrescentada no futuro sairia guardada por
-- omissão. O UPDATE de perfil é raro (não é telemetria), então o custo é nulo.
drop trigger if exists trg_guard_profile_privileged_fields on public.profiles;
create trigger trg_guard_profile_privileged_fields
  before update on public.profiles
  for each row execute function public.guard_profile_privileged_fields();

-- ─────────────────────────────────────────────────────────────────────────────
-- B.2 — INSERT: o buraco que tornava o guard de UPDATE decorativo.
-- ─────────────────────────────────────────────────────────────────────────────
-- O perfil é criado PELO CLIENTE (AuthContext.signUp → insert em profiles, sob
-- a policy `with check (auth.uid() = id)` de 0002). A 0062 derrubou de propósito
-- o trigger handle_new_user, então não existe criação server-side: o cliente é o
-- único criador. Sem este trigger, guardar o UPDATE não guarda nada — a conta
-- simplesmente JÁ NASCE com is_admin = true e driver_share_percent = 1.000, e o
-- 1.000 é permanente porque assign_driver_tier retorna cedo quando a fatia já
-- não é nula.
--
-- Cada valor forçado abaixo é o DEFAULT REAL da coluna, conferido na migração
-- que a criou — não um valor inventado:
--   driver_share_percent      numeric(4,3)            (sem default → NULL)  0037:26
--   driver_onboarded_seq      integer                 (sem default → NULL)  0037:27
--   is_admin                  boolean not null default false                0018:12
--   stripe_account_id         text                    (sem default → NULL)  0034:21
--   stripe_charges_enabled    boolean not null default false                0037:28
--   stripe_payouts_enabled    boolean not null default false                0034:23
--   stripe_onboarding_complete boolean not null default false               0034:22
--   verification_status       text not null default 'unsubmitted'           0018:7
--   verification_notes        text                    (sem default → NULL)  0018:8
--   verification_reviewed_at  timestamptz             (sem default → NULL)  0018:10
--   verification_reviewed_by  uuid                    (sem default → NULL)  0018:11
--   jurisdiction              text not null default 'global'                0055:24
--
-- `type` NÃO entra na lista: é o usuário que escolhe passageiro ou motorista no
-- cadastro, e o app manda esse campo no insert (AuthContext.tsx:175-185). Forçá-lo
-- quebraria todo cadastro de motorista. Depois do insert ele fica imutável pelo
-- guard de UPDATE (B.1), que é onde a imutabilidade tem que morar.
--
-- `full_name`, `phone`, `email`, `avatar_url`, `language`, `rating`,
-- `total_rides`, `push_token` também ficam de fora: são dados do usuário, não
-- privilégio. (`rating`/`total_rides` são cosméticos e não movem dinheiro.)
create or replace function public.guard_profile_insert_privileges()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_role text := auth.role();
begin
  if v_role is null or v_role = 'service_role' then
    return new;
  end if;

  -- Dinheiro.
  new.driver_share_percent := null;
  new.driver_onboarded_seq := null;

  -- Privilégio administrativo.
  new.is_admin := false;

  -- Stripe Connect: conta de destino e flags que destravam repasse.
  new.stripe_account_id          := null;
  new.stripe_charges_enabled     := false;
  new.stripe_payouts_enabled     := false;
  new.stripe_onboarding_complete := false;

  -- Cartão do passageiro — mesmo motivo do guard de UPDATE (B.1): charge-ride
  -- e tip-ride cobram no par cus_/pm_ gravado aqui, sem conferir de quem ele é.
  -- Sem esta linha o guard de UPDATE seria contornável de fábrica: bastaria
  -- nascer com o cartão de outra pessoa, e o UPDATE nunca precisaria acontecer.
  -- Nenhum cadastro legítimo manda esses campos — AuthContext.tsx:175-185
  -- insere só full_name/phone/email/type/rating/total_rides/language/avatar_url;
  -- quem grava cartão é setup-card/sync-card/stripe-webhook, todos com service
  -- key. (O upsert de `handleDevBypass` cai aqui quando o perfil ainda não
  -- existe: mesmo efeito silencioso descrito em B.1.)
  new.stripe_customer_id       := null;
  new.stripe_payment_method_id := null;

  -- Verificação documental: todo mundo nasce sem enviar nada.
  new.verification_status       := 'unsubmitted';
  new.verification_reviewed_by  := null;
  new.verification_reviewed_at  := null;
  new.verification_notes        := null;

  -- Jurisdição gate rollout de feature flag; o guard de UPDATE já a congela,
  -- então deixá-la livre no INSERT só moveria o auto-serviço para o cadastro.
  new.jurisdiction := 'global';

  return new;
end;
$$;

comment on function public.guard_profile_insert_privileges() is
  'O perfil criado pelo próprio usuário (0002) nasce sem comissão, sem flags Stripe, sem cartão (stripe_customer_id/stripe_payment_method_id), sem is_admin e sem verificação. `type` continua escolhido no cadastro.';

drop trigger if exists trg_guard_profile_insert_privileges on public.profiles;
create trigger trg_guard_profile_insert_privileges
  before insert on public.profiles
  for each row execute function public.guard_profile_insert_privileges();

-- assign_driver_tier (0037) recriada levantando o GUC em volta do UPDATE (sem
-- isso ela fica refém do guard estendido acima no dia em que for chamada de um
-- contexto autenticado — a armadilha descrita no topo) E, novo em 0065,
-- REAPLICANDO a fatia recém-atribuída às corridas que este motorista já rodou.
--
-- O BUG QUE ISSO FECHA. A fatia é atribuída tarde: quem chama
-- assign_driver_tier é o webhook `account.updated` do Stripe
-- (stripe-webhook/index.ts) quando o Connect do motorista fica pronto — e o
-- motorista pode rodar corridas ANTES disso. Enquanto driver_share_percent é
-- NULL, tanto compute_ride_split quanto composeRideSplit caem no padrão de
-- 0.800. Ao gravar 0.850 aqui, a função devolvia o número novo e ia embora: as
-- corridas já rodadas continuavam divididas a 80%, e como assign_driver_tier
-- "nunca recalcula" (retorno antecipado quando a fatia já não é nula), ninguém
-- voltava para consertá-las. Resultado: os 100 primeiros motoristas — a faixa
-- que existe justamente para ser um incentivo de lançamento — recebiam 80% em
-- todas as corridas anteriores ao onboarding Connect terminar.
--
-- ESCOPO DO RECÁLCULO: `payout_id is null`. Corrida já embolsada num repasse
-- não se mexe — o valor no banco tem que continuar batendo com o transfer que
-- foi para o Stripe (mesma regra de apply_driver_split, linha ~1325). Na
-- prática isso não perde nada: os repasses são semanais e o webhook
-- account.updated chega em minutos/horas.
--
-- POR QUE UM LOOP E NÃO UM UPDATE ... FROM. A válvula app.ride_money_write
-- carrega o UUID de UMA corrida (é isso que impede um GUC residual de destravar
-- a tabela inteira). Um UPDATE em lote só poderia passar se a válvula virasse
-- booleana — que é exatamente o desenho que 0065 recusa. O loop paga o preço em
-- statements para manter a válvula estreita; o N aqui é "corridas de UM
-- motorista ainda não repassadas", ou seja, dezenas no pior caso.
--
-- POR QUE NÃO CHAMAR apply_driver_split() AQUI: aquela função tem checagem de
-- autorização por auth.uid() (só as PARTES da corrida passam). Chamada de dentro
-- desta, num contexto autenticado, ela levantaria 42501 e derrubaria a
-- atribuição de faixa junto. O cálculo é repetido de propósito — a fonte da
-- verdade (compute_ride_split) continua sendo uma só.
create or replace function public.assign_driver_tier(p_driver uuid)
returns numeric
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_share numeric(4,3);
  v_seq   integer;
  v_ride  record;
  v_split record;
  v_check numeric(8,2);
begin
  select driver_share_percent
    into v_share
    from public.profiles
   where id = p_driver
   for update;

  -- Já atribuída — nunca recalcula.
  if v_share is not null then
    return v_share;
  end if;

  -- ── A POSIÇÃO NA FILA NÃO PODE VIR DE `nextval` (P2-13) ──────────────────
  -- 0037:71 usava `nextval('public.driver_onboard_seq')`. Sequências são
  -- NÃO-TRANSACIONAIS de propósito: o número consumido NÃO volta no rollback.
  -- Esta função tem trabalho falível DEPOIS deste ponto — o `raise exception` do
  -- laço de reaplicação, mais abaixo, que derruba a transação inteira — e o
  -- chamador é o webhook `account.updated` do Stripe, que é RE-ENTRANTE (a
  -- Stripe reentrega, e o mesmo motorista dispara o evento várias vezes durante
  -- o onboarding). Resultado: cada falha queimava um número em silêncio, sem
  -- atribuir faixa a ninguém — as 100 vagas de 85% podiam se esgotar contra
  -- motorista nenhum, e o motorista real cair na faixa de 80% por causa de
  -- tentativas fracassadas dele mesmo.
  --
  -- A ESCOLHA: derivar a posição dos DADOS (`max(driver_onboarded_seq) + 1`) em
  -- vez de um contador paralelo. A coluna já existe (0037:27) e já tem índice
  -- parcial (0037:34-36), então o max é uma leitura de índice; e, por ser dado
  -- comum, ela ROLA DE VOLTA junto com tudo o mais — uma tentativa que falha não
  -- deixa rastro e a próxima reusa exatamente a mesma posição. Isso também
  -- REPARA de graça os números já queimados por 0037: o max olha para quem
  -- realmente recebeu faixa, não para onde a sequência parou.
  --
  -- `pg_advisory_xact_lock` é o que substitui a atomicidade que a sequência dava.
  -- O `for update` acima trava só a LINHA deste motorista, então dois onboardings
  -- simultâneos de motoristas DIFERENTES leriam o mesmo max e receberiam a mesma
  -- posição (a coluna não tem UNIQUE — 0037:34 é índice comum). O advisory lock
  -- serializa a seção inteira; é de TRANSAÇÃO (`_xact_`), então é liberado no
  -- commit ou no rollback sem precisar de unlock explícito, inclusive no caminho
  -- do `raise exception`. A constante é o hash do nome da função, para não
  -- colidir com outro uso de advisory lock no banco.
  --
  -- A sequência `public.driver_onboard_seq` continua existindo (0037:31) e não é
  -- derrubada aqui: outra instalação/rollback pode ainda referenciá-la. Ela
  -- simplesmente deixa de ser consultada.
  perform pg_advisory_xact_lock(hashtext('public.assign_driver_tier'));

  select coalesce(max(driver_onboarded_seq), 0) + 1
    into v_seq
    from public.profiles;

  v_share := case when v_seq <= 100 then 0.850 else 0.800 end;

  perform set_config('app.profile_money_write', p_driver::text, true);
  update public.profiles
     set driver_onboarded_seq = v_seq,
         driver_share_percent = v_share
   where id = p_driver;
  perform set_config('app.profile_money_write', '', true);

  -- ── Reaplica a fatia às corridas que ele já rodou e ainda não recebeu ────
  -- `for update` nas linhas: o trigger de A.2 recalcula o split quando
  -- driver_id entra na corrida, então travar evita corrida de dados com um
  -- aceite acontecendo no mesmo instante.
  --
  -- ── O FILTRO (P2-14) ──────────────────────────────────────────────────────
  -- A versão anterior filtrava só por `driver_id = p_driver and payout_id is
  -- null`, o que varria muito mais do que "corridas a receber":
  --   • CANCELADAS — `status = 'cancelled'` nunca é repassada, mas satisfaz
  --     payout_id is null para sempre. Subir o driver_amount delas de 80% para
  --     85% mexe no dinheiro de uma corrida que não aconteceu e polui qualquer
  --     conferência posterior contra o Stripe;
  --   • ESTORNADAS — refund-ride/index.ts:107 grava `paid = false` mas NÃO zera
  --     `driver_amount`, e o estorno também não preenche payout_id. Então uma
  --     corrida cujo dinheiro já VOLTOU para o passageiro tinha o repasse dela
  --     REAJUSTADO PARA CIMA aqui — e request-payout/run-weekly-payouts leem
  --     `driver_amount` da linha;
  -- Quem NÃO pode ficar de fora é a corrida AINDA EM ANDAMENTO ('accepted',
  -- 'driver_en_route', 'in_progress'). O bloco de split do trigger (A.2) só
  -- dispara quando `new.driver_id is distinct from old.driver_id`, e numa corrida
  -- já aceita o driver_id nunca mais muda; `applyDriverSplit` também só é chamado
  -- no aceite/claim/confirmação (useRide.ts:892, :941, :1730, :1807, :1846),
  -- nunca na conclusão. Ou seja: não existe ninguém que recalcule o split dela
  -- depois. Deixá-la fora congelaria em 80% a corrida que um motorista de 85%
  -- está rodando NESTE momento — exatamente o bug que esta função existe para
  -- consertar.
  -- É `paid` que exclui canceladas e estornadas (os dois casos acima), não o
  -- status. (`paid` é NOT NULL desde o bloco D, então este `and r.paid` não tem
  -- o problema de três valores.)
  for v_ride in
    select r.id, r.price, r.toll_amount, r.airport_port_fee,
           r.driver_amount, r.platform_fee
      from public.rides r
     where r.driver_id = p_driver
       and r.payout_id is null
       and r.paid
       and r.status in ('accepted', 'driver_en_route', 'in_progress', 'completed')
     order by r.id
     for update
  loop
    select * into v_split
      from public.compute_ride_split(v_ride.price, v_ride.toll_amount,
                                     v_ride.airport_port_fee, v_share);

    continue when v_split.o_driver_amount is not distinct from v_ride.driver_amount
              and v_split.o_platform_fee  is not distinct from v_ride.platform_fee;

    perform set_config('app.ride_money_write', v_ride.id::text, true);
    update public.rides
       set driver_amount = v_split.o_driver_amount,
           platform_fee  = v_split.o_platform_fee
     where id = v_ride.id;
    perform set_config('app.ride_money_write', '', true);

    -- Mesma leitura de volta de apply_driver_split: se a válvula não estivesse
    -- passando pelo trigger, o UPDATE reportaria sucesso e o valor continuaria
    -- a 80% em silêncio. Aqui isso vira exceção e derruba a transação inteira
    -- (inclusive a atribuição de faixa), que é o estado seguro — melhor não
    -- atribuir do que atribuir e não pagar.
    select r.driver_amount into v_check from public.rides r where r.id = v_ride.id;
    if v_check is distinct from v_split.o_driver_amount then
      raise exception
        'assign_driver_tier: recálculo da corrida % foi revertido (esperado %, gravado %) — a válvula app.ride_money_write não está passando pelo trigger guard_ride_money_fields',
        v_ride.id, v_split.o_driver_amount, v_check
        using errcode = 'internal_error';
    end if;
  end loop;

  return v_share;
end;
$$;

comment on function public.assign_driver_tier(uuid) is
  'Atribui a faixa de comissão (0.850 para os 100 primeiros, 0.800 depois), uma única vez por motorista, e reaplica a fatia às corridas dele cobradas e ainda não repassadas, incluindo as que estão em andamento (paid, payout_id is null, status em accepted/driver_en_route/in_progress/completed — ninguém mais recalcula o split de uma corrida já aceita). A posição na fila vem de max(driver_onboarded_seq)+1 sob advisory lock, nao de nextval: assim uma falha posterior rola de volta sem queimar vaga.';

-- Permissões de 0037 preservadas (só o backend dispara a atribuição).
revoke all on function public.assign_driver_tier(uuid) from public;
revoke all on function public.assign_driver_tier(uuid) from anon;
revoke all on function public.assign_driver_tier(uuid) from authenticated;
grant execute on function public.assign_driver_tier(uuid) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- C. apply_driver_split — caminho de REPARO, não mais o caminho principal
-- ═════════════════════════════════════════════════════════════════════════════
-- Desde A.2 o split normal acontece dentro do trigger, atômico com o aceite.
-- Esta função sobrevive para:
--   • reparar linhas antigas (backfill de corridas aceitas antes desta migração);
--   • recalcular quando `driver_share_percent` é atribuída DEPOIS do aceite
--     (assign_driver_tier roda no webhook account.updated do Stripe);
--   • o app continuar chamando-a como cinto-e-suspensório (useRide.ts), onde
--     hoje ela é um no-op idempotente.
-- Como faz um UPDATE de verdade, continua precisando do GUC.
create or replace function public.apply_driver_split(p_ride_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_role        text := auth.role();
  v_uid         uuid := auth.uid();
  v_driver_id   uuid;
  v_passenger_id uuid;
  v_price       numeric(8,2);
  v_toll        numeric(8,2);
  v_venue_fee   numeric(8,2);
  v_payout_id   uuid;
  v_found       boolean := false;
  v_cur_driver_amount numeric(8,2);
  v_cur_platform_fee  numeric(8,2);
  v_share       numeric;
  v_split       record;
begin
  select r.driver_id,
         r.passenger_id,
         r.price,
         r.toll_amount,
         r.airport_port_fee,
         r.payout_id,
         r.driver_amount,
         r.platform_fee
    into v_driver_id, v_passenger_id, v_price, v_toll, v_venue_fee, v_payout_id,
         v_cur_driver_amount, v_cur_platform_fee
    from public.rides r
   where r.id = p_ride_id;

  -- `found` PRECISA ser capturado no statement seguinte ao SELECT INTO: qualquer
  -- comando depois disto o sobrescreve. (Um `select ..., true into ..., v_found`
  -- não serviria: sem linha, o plpgsql zera TODOS os alvos do INTO para NULL,
  -- inclusive o literal `true` — e a checagem de autorização abaixo viraria NULL,
  -- ou seja, não levantaria exceção nenhuma.)
  v_found := found;

  -- AUTORIZAÇÃO PRIMEIRO. Quem não é PARTE desta corrida não recalcula nada — e
  -- também não descobre se ela existe: a corrida inexistente devolve o MESMO
  -- 42501 que a corrida alheia. A versão anterior retornava null antes da
  -- checagem quando `not found`, o que transformava esta RPC num oráculo de
  -- existência de UUID para qualquer usuário autenticado.
  --
  -- Por que o passageiro também passa, e não só o motorista: o caminho
  -- `activate()` de um agendamento roda no app do PASSAGEIRO. Como TODO o
  -- cálculo sai do servidor (price/toll/fee da linha + share do perfil DO
  -- MOTORISTA), o passageiro não tem nenhum grau de liberdade aqui: chamar isto
  -- só pode produzir o valor correto. auth.uid() é null no service_role, daí a
  -- checagem separada de papel.
  if v_role is not null
     and v_role <> 'service_role'
     and (not v_found
          or (v_uid is distinct from v_driver_id
              and v_uid is distinct from v_passenger_id)) then
    raise exception 'apply_driver_split: caller is not a party to ride %', p_ride_id
      using errcode = '42501';
  end if;

  -- Corrida inexistente (chamada por service_role) ou ainda sem motorista:
  -- nada a dividir. NULL aqui não esconde mais perda de dinheiro nenhuma — o
  -- split de verdade é feito pelo trigger, no mesmo statement do aceite.
  if not v_found or v_driver_id is null then
    return null;
  end if;

  -- Dinheiro já reservado num repasse não se mexe: alterar driver_amount depois
  -- do payout descasaria o valor transferido no Stripe do valor no banco.
  if v_payout_id is not null then
    return v_cur_driver_amount;
  end if;

  select p.driver_share_percent into v_share
    from public.profiles p
   where p.id = v_driver_id;

  select * into v_split
    from public.compute_ride_split(v_price, v_toll, v_venue_fee, v_share);

  -- Idempotência: o cálculo é determinístico (mesmos price/toll/fee/share →
  -- mesmos valores), então chamar N vezes converge para o mesmo estado. O
  -- `is distinct from` só evita o UPDATE inútil.
  if v_split.o_driver_amount is distinct from v_cur_driver_amount
     or v_split.o_platform_fee is distinct from v_cur_platform_fee then
    -- Levanta a válvula APENAS para esta corrida e APENAS nesta transação.
    perform set_config('app.ride_money_write', p_ride_id::text, true);
    update public.rides
       set driver_amount = v_split.o_driver_amount,
           platform_fee  = v_split.o_platform_fee
     where id = p_ride_id;
    -- Derruba imediatamente: nenhum statement seguinte da mesma transação herda
    -- a permissão.
    perform set_config('app.ride_money_write', '', true);

    -- LEITURA DE VOLTA — não é paranoia decorativa, é a rede contra a armadilha
    -- do SECURITY DEFINER descrita no topo desta migração. Se a válvula do GUC
    -- não funcionasse, o trigger teria revertido este UPDATE e nada acusaria: o
    -- UPDATE reporta 1 linha afetada de qualquer jeito e o RPC devolveria
    -- sucesso. Relendo a linha, essa falha vira exceção — barulhenta, no
    -- reportError do app, em vez de silêncio por meses.
    select r.driver_amount into v_cur_driver_amount
      from public.rides r where r.id = p_ride_id;
    if v_cur_driver_amount is distinct from v_split.o_driver_amount then
      raise exception
        'apply_driver_split: escrita revertida (esperado %, gravado %) — a válvula app.ride_money_write não está passando pelo trigger guard_ride_money_fields',
        v_split.o_driver_amount, v_cur_driver_amount
        using errcode = 'internal_error';
    end if;
  end if;

  return v_split.o_driver_amount;
end;
$$;

comment on function public.apply_driver_split(uuid) is
  'REPARO/backfill do split. O caminho normal é o trigger guard_ride_money_fields, atômico com o aceite. Idempotente; recusa quem não é parte da corrida; no-op depois do repasse.';

revoke all on function public.apply_driver_split(uuid) from public;
revoke all on function public.apply_driver_split(uuid) from anon;
grant execute on function public.apply_driver_split(uuid) to authenticated;
grant execute on function public.apply_driver_split(uuid) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- D. Gate + restrições de sanidade — MOVIDO PARA O TOPO DESTE ARQUIVO
-- ═════════════════════════════════════════════════════════════════════════════
-- O bloco que ficava AQUI (gate executável + os CHECKs de price/componentes/
-- repasse/coordenadas) foi movido para antes de qualquer `create or replace
-- function`. Motivo: o gate ABORTA a migração quando acha linha legada suja, e
-- abortar depois de todo o DDL deixa o pior estado possível — triggers
-- instalados, restrições ausentes e a policy de INSERT de `payouts` ainda de pé.
-- No topo, um aborto não deixa nada aplicado, com ou sem transação envolvendo o
-- arquivo. Ver a nota "ESTE ARQUIVO PRECISA SER APLICADO NUMA ÚNICA TRANSAÇÃO"
-- no cabeçalho.

-- ═════════════════════════════════════════════════════════════════════════════
-- E. payouts — o cliente deixa de poder criar o próprio repasse
-- ═════════════════════════════════════════════════════════════════════════════
-- 0006_split_payouts.sql:24-26 dá INSERT ao motorista sobre a própria linha, e
-- `amount numeric(8,2) not null` não tem CHECK nenhum. O que isso permite:
--   • poluir o próprio histórico de ganhos (usePayouts lê `payouts` direto e
--     soma o que estiver lá — EarningsScreen mostra números inventados);
--   • AUTO-BLOQUEIO: inserir { status: 'processing' } faz hasActivePayout()
--     (request-payout/index.ts:126-134) recusar todo saque, e o índice único de
--     0046 (um payout ativo por motorista) impede o legítimo de nascer. O
--     motorista fica sem receber até alguém mexer no banco à mão.
-- Não move dinheiro sozinho, mas é coluna de dinheiro escrita pelo cliente.
--
-- ESCOLHA: revogar, não guardar. Nenhum caminho do app insere payout — a única
-- referência a `payouts` em src/ é o SELECT de usePayouts.ts:31 (conferido com
-- grep em src/ inteiro). Quem cria payout é sempre edge function com service
-- key (request-payout:267, run-weekly-payouts:132), que passa por cima da RLS.
-- Guardar por trigger seria construir maquinaria para um caso de uso que não
-- existe; revogar não quebra nada e some com a superfície inteira.
drop policy if exists "Motorista insere proprio payout" on public.payouts;

-- Cinto e suspensório: sem o GRANT de tabela, nem uma policy recriada por
-- engano num restore de schema devolve a permissão.
revoke insert on public.payouts from anon;
revoke insert on public.payouts from authenticated;
