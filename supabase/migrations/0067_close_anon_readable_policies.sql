-- 0067 — a chave anônima não pode mais ler o pool de corridas, a frota, o
--        diretório de usuários, a listagem de avatares nem a trilha de GPS.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- COMO APLICAR — LEIA ANTES DE RODAR QUALQUER COISA
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ESTE ARQUIVO SÓ PODE SER APLICADO DENTRO DE UMA TRANSAÇÃO. Não é preferência
-- de estilo: fora de transação, o `set local lock_timeout` da linha abaixo vira
-- um WARNING silencioso e não tem efeito nenhum, e uma falha no meio do arquivo
-- deixa o banco num estado parcial. Use UM dos dois:
--
--   psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 \
--     -f supabase/migrations/0067_close_anon_readable_policies.sql
--
--   npx supabase db push          # envolve cada arquivo numa transação
--
-- É PROIBIDO colar este arquivo no editor SQL do painel do Supabase: lá cada
-- comando comita sozinho, não há `lock_timeout`, e um erro no meio deixa
-- metade do arquivo aplicado. A seção Z no fim do arquivo é uma rede de
-- segurança (levanta exceção se o estado final estiver errado), não uma
-- autorização para rodar por lá.
--
-- NÃO acrescente `begin;` / `commit;` literais neste arquivo. O CLI do Supabase
-- já envolve a migração numa transação própria; um `commit` aqui dentro fecharia
-- a transação EXTERNA no meio do caminho e corromperia
-- `supabase_migrations.schema_migrations`.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- O FATO QUE TORNA ISTO URGENTE
-- ═════════════════════════════════════════════════════════════════════════════
--
-- A anon key do Supabase é PUBLICÁVEL e vai embutida no binário do app:
--
--     src/lib/supabase.ts:21
--       const FALLBACK_SUPABASE_ANON_KEY = 'sb_publishable_Tu3TmYgQa6gOII2X-AbDLg_A0eLlIbd';
--
-- Qualquer pessoa que baixe o GoXL tem essa chave. Ela autentica como o papel
-- `anon` do Postgres. Duas mecânicas fazem disso um vazamento:
--
--   (1) POLICY SEM `to`. No Postgres, uma policy criada sem cláusula `to`
--       pertence a `PUBLIC` — o que inclui `anon`. Numa policy sem `to`, a
--       expressão do `using` é a ÚNICA coisa entre um estranho com `curl` e a
--       tabela. O padrão do defeito é sempre o mesmo: policy sem `to` + um ramo
--       do `using` que não referencia `auth.uid()`. Esse ramo é TRUE
--       independentemente de quem chama, logo é TRUE para `anon`.
--
--   (2) GRANT PADRÃO DO SCHEMA `public`. O bootstrap do Supabase inclui um
--       `alter default privileges in schema public grant all on tables to
--       postgres, anon, authenticated, service_role`. Consequência: TODO objeto
--       novo criado em `public` — tabela, VIEW ou PARTIÇÃO — nasce com SELECT
--       para `anon`, mesmo que a migração que o criou só tenha escrito
--       `grant select ... to authenticated`. Isto é o que a auditoria da
--       iteração 1 não viu, e é a causa raiz de C, F e de metade de E.
--       (Afirmação sobre a configuração padrão da plataforma, lida na
--       documentação do Supabase — não medida neste ambiente. Comando de
--       verificação no rodapé, seção P0.b.)
--
--       CONTROLE SISTÊMICO AINDA EM ABERTO — registrado, não aplicado.
--       A causa raiz de (2) é um único comando:
--         alter default privileges in schema public revoke all on tables from anon;
--       Ele NÃO está neste arquivo de propósito. Aplicado às cegas, muda o
--       privilégio de todo objeto FUTURO do schema `public` — inclusive
--       partições criadas por automação e views que algum fluxo pré-login
--       possa vir a precisar — e a falha apareceria como "permission denied"
--       em produção, longe daqui. Antes de aplicá-lo é preciso INVENTARIAR o
--       que existe hoje: `select * from pg_default_acl` (quais defaults estão
--       de fato configurados, por schema e por dono) e `select table_name,
--       privilege_type from information_schema.role_table_grants where
--       grantee = 'anon' and table_schema = 'public'` (o que `anon` já
--       alcança). Com esses dois resultados na mão, o revoke vira uma
--       migração própria, com a lista de exceções explícita. Este arquivo
--       fecha os seis objetos nomeados; ele não fecha a classe.
--
-- Terceiro fato de mecânica, igualmente decisivo: policies PERMISSIVAS são
-- combinadas com OR. Uma policy estreita e correta NÃO restringe uma policy
-- ampla e errada sobre a mesma tabela/comando — ela só acrescenta linhas. Isso
-- importa em `driver_locations`, que tem duas policies de SELECT (ver B.1/B.2).
--
-- A 0048 já tinha consertado esta classe de bug em `profiles` (0048:23),
-- `vehicles` (0048:31) e `payouts`. Ela não tocou em nada do que está abaixo.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- O QUE ESTE ARQUIVO FECHA
-- ═════════════════════════════════════════════════════════════════════════════
--
-- A — `public.rides`, SELECT      — pool de corridas abertas (endereço, coordenada, preço)
-- B — `public.driver_locations`   — GPS ao vivo da frota inteira
-- C — `public.rides`, UPDATE      — escrita anônima (pior que os outros: não é leitura)
-- D — `public.profiles_public`    — diretório de nome/foto/nota/tipo/driver_code de TODO usuário
-- E — `storage.objects`           — LISTAGEM do bucket de avatares (= id de todo usuário com foto)
-- F — partições de `driver_period_transitions` — histórico de GPS por motorista, sem RLS
-- Z — bloco de asserções que falha alto se qualquer um dos itens acima ficar pela metade
--
-- ═════════════════════════════════════════════════════════════════════════════
-- POR QUE `to authenticated` NÃO QUEBRA NADA (verificado lendo os call sites)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- O app tem UM cliente Supabase (src/lib/supabase.ts:39), criado com a anon key
-- mas com sessão persistida: depois do login toda requisição carrega o JWT do
-- usuário e o papel efetivo é `authenticated`. As Edge Functions criam cliente
-- de anon key em 14 lugares, e em todos eles só para `.auth.getUser()` —
-- resolver a identidade do chamador, nunca ler tabela. Toda leitura/escrita de
-- dados nas functions usa o cliente `admin` com service key, que não passa por
-- RLS. `service_role` continua ignorando RLS por definição, então `to
-- authenticated` não o afeta. Os scripts de `supabase/scripts/` também usam
-- SUPABASE_SERVICE_ROLE_KEY (conferido nos três que leem `profiles_public`:
-- charge_unpaid_ride.ts:80, find_rides.ts:79, check_driver_names.ts:65).
--
-- O ÚNICO leitor pré-login que existia no app inteiro era o Cadastro Expresso,
-- e ele é tratado na seção D.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- POR QUE O POOL ABERTO PASSA A EXIGIR SER MOTORISTA (e não só estar logado)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `to authenticated` sozinho mata o anônimo, mas deixa de pé uma exposição
-- menor e real: uma conta de PASSAGEIRO — que qualquer um cria sozinho em dois
-- minutos — continuaria enumerando o pool aberto inteiro, com endereço,
-- coordenada e preço de cada chamada.
--
-- Quem realmente precisa do pool aberto, conferido lendo TODOS os call sites que
-- consultam `rides` filtrando por status SEM filtrar por `driver_id`/
-- `passenger_id` (os únicos que dependem dos dois ramos abertos):
--
--   • src/hooks/useDriverScheduledRides.ts:63-68   (expireOldScheduledRides)
--   • src/hooks/useDriverScheduledRides.ts:112-122 (lista "disponíveis")
--   • src/hooks/useRide.ts:1325-1331, 1349-1355, 1374-1380
--     (assinaturas realtime `status=eq.requesting` / `status=eq.scheduled`)
--
-- Todos vivem em hooks/telas montados APENAS dentro do stack de motorista, que
-- por sua vez é escolhido por `profile?.type === 'driver'`
-- (src/navigation/AppNavigator.tsx). Ou seja: todo consumidor legítimo do pool
-- aberto é, por construção do app, um perfil com `type = 'driver'`.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- A EVIDÊNCIA DE QUE UM GATE CRUZADO COMO ESSE FUNCIONA (inclusive no Realtime)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Uma versão anterior deste arquivo justificava o gate dizendo que o
-- `exists (select 1 from public.profiles ...)` é "o mesmo padrão já em produção
-- em ~15 policies deste repositório". Esse argumento era CIRCULAR e foi
-- removido: em todos aqueles sites (0023:37-48, 0025:44-55, 0047:59-70,
-- 0053:48-59, 0054:206-214 …) a subconsulta aparece como ramo de FALLBACK
-- (`or exists (... p.is_admin = true)`), ao lado de um ramo primário
-- `auth.uid() = <coluna do dono>`. Se aquela subconsulta silenciosamente
-- retornasse false, as ~15 continuariam se comportando corretamente para todo
-- usuário não-admin — que é praticamente todo o tráfego. A saúde delas em
-- produção, portanto, NÃO é evidência de que a subconsulta avalia.
--
-- A evidência que de fato sustenta o gate é outra: `public.messages`.
--   • supabase/schema.sql:155-161, reafirmado em 0005_messages.sql:13-19 —
--     a ÚNICA policy de SELECT da tabela é um `exists` CRUZADO em `rides`, sem
--     ramo de fallback nenhum. Se esse tipo de subconsulta não avaliasse, o
--     chat da corrida não mostraria uma única mensagem.
--   • schema.sql:186 e a última linha de 0005 colocam `messages` na publicação
--     `supabase_realtime`, e src/hooks/useUnreadMessages.ts:114-120 assina
--     `postgres_changes` de INSERT nessa tabela. O balão de mensagem não lida
--     aparece sem refresh manual — ou seja, o walrus do Realtime também
--     consegue avaliar um `exists` cruzado usado como gate único.
--
-- ISTO É INFERÊNCIA A PARTIR DE CÓDIGO EMBARCADO, NÃO OBSERVAÇÃO. O que se lê
-- no repositório é que o chat existe, está publicado no Realtime e tem esse
-- gate como única policy. Que ele funcione em produção é conclusão de que o
-- recurso está no app; não foi medido aqui. Nenhum banco foi tocado.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- MESMO ASSIM, O GATE NÃO USA SUBCONSULTA INLINE — USA `public.is_driver()`
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Um `exists (select 1 from public.profiles ...)` inline dentro de uma policy de
-- `rides` cria uma dependência de RLS-dentro-de-RLS: a subconsulta lê `profiles`,
-- que tem RLS própria. Ela seria satisfeita (a policy "Usuário vê o próprio
-- perfil", schema.sql:21-22, sobrevive à 0050 — que dropa só "Perfis públicos
-- para leitura", 0050:26 — e casa exatamente a linha `p.id = auth.uid()`), e não
-- há recursão possível (nenhuma policy de `profiles` referencia `rides`). Mas
-- restavam dois problemas reais:
--
--   • `rides` está na publicação de realtime (schema.sql:184). Cada
--     INSERT/UPDATE em `rides` passaria a custar uma sondagem extra em
--     `profiles` POR MOTORISTA ASSINANTE, dentro do walrus, que é um gargalo
--     por slot;
--   • a mitigação anterior era uma "alavanca de rollback" que dependia de um
--     humano perceber a queda do despacho e agir.
--
-- `public.is_driver()` (seção A.1) é `security definer`, então lê `profiles`
-- com o privilégio do dono e a RLS de `profiles` deixa de participar da
-- avaliação da policy de `rides`. A qual da policy vira uma única chamada de
-- função `stable`. A dependência some em vez de ficar mitigada.
--
-- CAMINHO DE LONGO PRAZO (NÃO implementado aqui, fica registrado): um custom
-- access-token hook do Supabase carimbando o papel dentro do próprio JWT, com o
-- gate virando
--     ((auth.jwt() -> 'app_metadata') ->> 'user_type') = 'driver'
-- que custa ZERO no walrus porque não toca em tabela nenhuma. Exige mexer no
-- fluxo de auth e re-emitir tokens — mudança de outra natureza, fora do escopo
-- de fechar o acesso anônimo.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SOBRE `(select auth.uid())` E PLANO DE EXECUÇÃO
-- ─────────────────────────────────────────────────────────────────────────────
--
-- As quals abaixo usam `(select auth.uid())`, e não `auth.uid()` cru. A
-- orientação de performance de RLS do próprio Supabase é essa: envolver a
-- chamada num subselect é o que faz o planejador materializá-la como InitPlan
-- (uma vez por consulta) em vez de reavaliá-la por linha.
--
-- HIPÓTESE, NÃO MEDIÇÃO: uma versão anterior deste arquivo AFIRMAVA que o
-- planejador resolve a subconsulta como InitPlan. Nada foi medido — não há
-- Postgres neste ambiente. O `EXPLAIN` que um humano precisa rodar para
-- transformar isso em fato está no rodapé, seção P7.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- POR QUE O RAMO AMPLO DE `driver_locations` CONTINUA EXISTINDO
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Tentação óbvia: apagar `is_online = true` e ficar só com a policy estreita da
-- 0009 (motorista da MINHA corrida ativa). Isso quebraria o produto. Três
-- leitores autenticados dependem do ramo amplo, todos ANTES de existir corrida:
--
--   • src/hooks/useNearbyDrivers.ts:23-26  — os carros no mapa do passageiro;
--   • src/hooks/useRide.ts:196-199         — notifyOnlineDrivers;
--   • src/hooks/useRide.ts:386-389         — pushSilentRevokeToOnlineDrivers.
--
-- Como os leitores legítimos são dos DOIS papéis, não há gate de papel a
-- aplicar aqui que não quebre alguém. `to authenticated` é o piso E o teto
-- desta migração para essa tabela. Fica registrado como pendência de produto: o
-- ramo amplo ainda entrega coordenada exata da frota a qualquer conta logada; o
-- caminho certo é uma RPC que devolva só os carros num raio do passageiro, e
-- isso exige mudar useNearbyDrivers junto.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- JANELA DE BLOQUEIO
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `drop policy` / `create policy` são mudanças SÓ DE CATÁLOGO: não reescrevem
-- tabela, não reindexam, terminam em microssegundos. O risco não é a duração, é
-- a ESPERA: pegam ACCESS EXCLUSIVE na tabela e, se ficarem na fila atrás de uma
-- transação aberta, passam a bloquear toda query que chegar depois — inclusive
-- leitura. Em `rides` e `driver_locations` isso é o despacho parado.
--
-- Daí o `lock_timeout` abaixo: a migração FALHA RÁPIDO em vez de enfileirar, e é
-- 100% segura para repetir. Se der lock_timeout, ache o bloqueador e rode de novo:
--   select pid, state, wait_event_type, left(query, 120)
--     from pg_stat_activity where state = 'idle in transaction';
--
-- ═════════════════════════════════════════════════════════════════════════════
-- NADA DISTO FOI EXECUTADO
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Não há Postgres, Docker nem psql no ambiente em que esta migração foi
-- escrita. Tudo acima é leitura de código e de documentação; NENHUMA afirmação
-- aqui é medição. Os comandos de prova para um humano rodar contra um clone de
-- staging estão no rodapé do arquivo.

set local lock_timeout = '3s';

-- Pré-condição de tudo o que vem abaixo: sem RLS ligado, policy nenhuma vale.
-- Idempotente e instantâneo (já estão ligados desde schema.sql:100 e :68).
alter table public.rides            enable row level security;
alter table public.driver_locations enable row level security;

-- ═════════════════════════════════════════════════════════════════════════════
-- A. public.rides — SELECT
-- ═════════════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────────────
-- A.1 — Helper de papel, usado pela policy do pool aberto (A.3).
--
-- `security definer` + `search_path` fixo: lê `profiles` com o privilégio do
-- dono, então a RLS de `profiles` não é avaliada dentro da RLS de `rides`. Ver
-- a discussão no cabeçalho.
--
-- `stable` (não `volatile`): o resultado não muda dentro de uma mesma
-- instrução, que é o que autoriza o planejador a chamá-la uma vez só.
--
-- `revoke from public, anon` segue a disciplina que este repositório já aplica
-- em toda função `security definer` (0051:72, 0057:120-121, 0057:320-321).
-- `authenticated` PRECISA de execute: a policy é avaliada com os privilégios do
-- chamador.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.is_driver()
returns boolean
language sql
stable
security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1
      from public.profiles p
     where p.id = (select auth.uid())
       and p.type = 'driver'
  );
$$;

revoke all on function public.is_driver() from public;
revoke all on function public.is_driver() from anon;
grant execute on function public.is_driver() to authenticated;
grant execute on function public.is_driver() to service_role;

comment on function public.is_driver() is
  'true se o chamador é um perfil type=driver. security definer de propósito: usado dentro da policy de SELECT do pool aberto de `rides` (0067 A.3), onde uma subconsulta inline em `profiles` criaria RLS-dentro-de-RLS reavaliada pelo walrus do Realtime a cada evento, por motorista assinante.';

-- ─────────────────────────────────────────────────────────────────────────────
-- A.2 e A.3 — CRIA ANTES DE DROPAR. Isto é deliberado, não descuido.
--
-- A ordem ingênua (dropar as legadas e depois criar as novas) é invisível
-- DENTRO de uma transação, mas este arquivo não pode assumir que sempre será
-- aplicado assim. Se os `drop` rodassem primeiro e qualquer coisa falhasse
-- antes dos `create`, `public.rides` ficaria com RLS LIGADA e ZERO policies de
-- SELECT — negação total. Nenhum passageiro veria a própria corrida, nenhum
-- motorista veria o pool, todo `.update(...).select()` em `rides` voltaria
-- vazio, a entrega de ofertas pararia. Apagão de despacho, indetectável só
-- lendo o arquivo.
--
-- Criando primeiro, o estado intermediário é sempre um SUPERCONJUNTO do estado
-- final (policies permissivas se somam por OR), nunca uma negação. O único
-- custo é o vazamento sobreviver por microssegundos entre o create e o drop —
-- inequivocamente melhor que um apagão. Os nomes novos não colidem com os
-- legados, o que é o que torna esta ordem possível aqui.
-- ─────────────────────────────────────────────────────────────────────────────

-- A.2 — Participante: passageiro e motorista continuam vendo as corridas DELES,
-- em qualquer status. Cobre histórico, corrida ativa, agendamento confirmado,
-- corrida travada por QR (`driver_id` pré-vinculado). Nenhum ramo é alcançável
-- sem JWT: ambos comparam contra `auth.uid()`, e o `to authenticated` já barra
-- o papel `anon` antes disso.
drop policy if exists "Participante vê a própria corrida" on public.rides;
create policy "Participante vê a própria corrida" on public.rides
  for select
  to authenticated
  using (
    (select auth.uid()) = passenger_id
    or (select auth.uid()) = driver_id
  );

-- A.3 — Pool aberto: mesmos dois ramos de antes (o despacho depende deles), mas
-- agora conjugados com "quem chama é um perfil de motorista". `and` com o gate
-- — não `or` — é o que impede o ramo de ser TRUE por si só, que era exatamente
-- o defeito.
drop policy if exists "Motorista vê o pool aberto" on public.rides;
create policy "Motorista vê o pool aberto" on public.rides
  for select
  to authenticated
  using (
    (
      status = 'requesting'
      or (status = 'scheduled' and driver_id is null)
    )
    and public.is_driver()
  );

-- A.4 — Só AGORA as legadas saem de cena.
--
-- "Motorista vê corridas disponíveis e suas" (schema.sql:105, 0041:18) é o
-- vazamento: ramos `status = 'requesting'` e `status = 'scheduled' and
-- driver_id is null` verdadeiros sem `auth.uid()`, sem `to`, logo alcançáveis
-- por `anon`. Um `select *` cru com a anon key devolvia, de toda corrida aberta
-- da frota: `passenger_id`, origem, destino e `price`.
--
-- "Passageiro vê suas corridas" (schema.sql:102-103) NÃO era alcançável por
-- anon — para `anon`, `auth.uid()` é NULL, `NULL = passenger_id` avalia NULL, e
-- RLS só deixa passar TRUE. Sai porque A.2 já a cobre, com o papel DECLARADO em
-- vez de depender de lógica de três valores.
drop policy if exists "Motorista vê corridas disponíveis e suas" on public.rides;
drop policy if exists "Passageiro vê suas corridas"             on public.rides;

-- ═════════════════════════════════════════════════════════════════════════════
-- B. public.driver_locations — todas as policies passam a declarar o papel
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Aqui os nomes são REUTILIZADOS (a expressão é preservada de propósito), então
-- criar-antes-de-dropar é impossível: `create policy` falharia com nome
-- duplicado. A rede de segurança para esta seção é o bloco de asserções da
-- seção Z, que levanta exceção se a tabela terminar sem policy de SELECT ou com
-- alguma policy ainda em `{public}`.

-- B.1 — O vazamento: `using (is_online = true)` sem `to`, e a expressão inteira
-- não depende de `auth.uid()`. Anon lia `lat`/`lng`/`heading` de TODO motorista
-- online — localização em tempo real da frota inteira, para qualquer um.
-- Única mudança: `to authenticated`. A expressão fica idêntica de propósito —
-- ver no cabeçalho por que o ramo amplo não pode sumir.
drop policy if exists "Passageiro vê motoristas online" on public.driver_locations;
create policy "Passageiro vê motoristas online" on public.driver_locations
  for select
  to authenticated
  using (is_online = true);

-- B.2 — A policy estreita da 0009:3-11 (motorista da minha corrida ativa,
-- independente de is_online). Não era alcançável por anon: o `exists` casa
-- `r.passenger_id = auth.uid()`, que é NULL sem JWT. Recriada só para declarar
-- o papel. Note que a 0009 acrescentou esta SEGUNDA policy de SELECT e ela não
-- ajudava em nada contra o vazamento: permissivas se somam por OR.
drop policy if exists "Passageiro vê localização do motorista ativo" on public.driver_locations;
create policy "Passageiro vê localização do motorista ativo" on public.driver_locations
  for select
  to authenticated
  using (
    exists (
      select 1 from public.rides r
      where r.driver_id = driver_locations.driver_id
        and r.passenger_id = (select auth.uid())
        and r.status in ('accepted', 'driver_en_route', 'in_progress')
    )
  );

-- B.3 — Escrita da própria posição (schema.sql:70-71). Também não era
-- alcançável por anon, mas era um `for all using (...)` SEM `with check`: nesse
-- caso o Postgres reaproveita a expressão do `using` como check de
-- INSERT/UPDATE. O `with check` abaixo escreve isso explicitamente —
-- comportamento idêntico, intenção visível. O gate de servidor de 0059 (trigger
-- `driver_can_go_online`) é ortogonal a esta policy e continua valendo.
drop policy if exists "Motorista atualiza própria localização" on public.driver_locations;
create policy "Motorista atualiza própria localização" on public.driver_locations
  for all
  to authenticated
  using ((select auth.uid()) = driver_id)
  with check ((select auth.uid()) = driver_id);

comment on table public.driver_locations is
  'Posição ao vivo dos motoristas. Toda policy é `to authenticated` desde a 0067 — a anon key é pública (src/lib/supabase.ts:21) e lia a frota inteira. O ramo amplo `is_online = true` permanece porque o mapa do passageiro depende dele antes de existir corrida (useNearbyDrivers.ts:23-26); estreitá-lo para um raio exige mudar o client junto.';

-- ═════════════════════════════════════════════════════════════════════════════
-- C. public.rides — UPDATE. Esta migração não delega mais o buraco de ESCRITA.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Uma versão anterior deste arquivo dizia que o buraco de UPDATE "já foi
-- fechado na 0065:1175-1192". A citação é exata — a 0065 recria mesmo
-- "Motorista aceita corrida" como `for update to authenticated` com `with
-- check` explícito. O problema é que a 0065 é um arquivo NÃO RASTREADO pelo git
-- (`git status` a mostra como `??`), trabalho em andamento do dono. Um
-- comentário apontando para um arquivo que pode não existir no banco de destino
-- é pior que nenhum comentário: faz o leitor acreditar que está resolvido.
--
-- Se a 0065 não tiver sido aplicada, schema.sql:116-122 continua em vigor:
--
--     create policy "Motorista aceita corrida" on public.rides
--       for update using (
--         auth.uid() = passenger_id
--         or auth.uid() = driver_id
--         or (status = 'requesting' and driver_id is null)
--         or (status = 'scheduled' and driver_id is null)
--       );
--
-- Sem `to`, e o ramo `(status = 'requesting' and driver_id is null)` é TRUE com
-- `auth.uid()` NULL. Sem `with check`, o Postgres reaproveita a expressão do
-- `using` como check de escrita. Ou seja: um estranho com a chave do binário
-- podia gravar `driver_id` arbitrário ou virar o `status` de qualquer corrida
-- aberta. Isso é PIOR que o vazamento de leitura.
--
-- A recriação abaixo é idempotente e reproduz palavra por palavra a versão da
-- 0065:1177-1191, então aplicar as duas em qualquer ordem converge no mesmo
-- estado. Preferida a um guard que levanta exceção: um guard bloquearia a
-- aplicação de 0067 inteira — inclusive as correções de LEITURA, que fecham
-- vazamentos que já estão no ar — enquanto a 0065 não fosse promovida.
--
-- A 0065_money_write_guard.sql NÃO é editada por este trabalho: é arquivo
-- aprovado, fechado e do dono.
drop policy if exists "Motorista aceita corrida" on public.rides;
create policy "Motorista aceita corrida" on public.rides
  for update
  to authenticated
  using (
    (select auth.uid()) = passenger_id
    or (select auth.uid()) = driver_id
    or (status = 'requesting' and driver_id is null)
    or (status = 'scheduled' and driver_id is null)
  )
  with check (
    (select auth.uid()) = passenger_id
    or (select auth.uid()) = driver_id
    or (status = 'requesting' and driver_id is null)
    or (status = 'scheduled' and driver_id is null)
  );

-- ── C.2. INSERT — o que fazia esta migração abortar a si mesma ───────────────
--
-- Descoberto EXECUTANDO este arquivo num Postgres de verdade, não lendo:
--
--     ERRO P0001: 0067 incompleta: policies ainda acessíveis por anon:
--                 rides.Passageiro cria corrida (cmd=INSERT)
--
-- A asserção Z.1 rejeita QUALQUER policy `{public}` em `rides`. A policy de
-- INSERT nasce em schema.sql:187 sem cláusula `to`, e nenhuma migration a
-- alterou. A seção PROVA deste mesmo arquivo a declarava "fora do escopo" —
-- então o arquivo contradizia a si próprio e não aplicava em banco nenhum
-- construído a partir deste repositório. Não era o ambiente: rodada de
-- controle, com esta recriação como única diferença, aplica limpo.
--
-- Entre estreitar Z.1 e trazer a policy para o escopo, a segunda é a correta.
-- O argumento de que `auth.uid() = passenger_id` já é NULL para anon está certo
-- e continua valendo — mas ele depende de a expressão nunca mudar. Declarar o
-- papel não depende de expressão nenhuma, que é a tese do arquivo inteiro.
drop policy if exists "Passageiro cria corrida" on public.rides;
create policy "Passageiro cria corrida" on public.rides
  for insert
  to authenticated
  with check ((select auth.uid()) = passenger_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- D. public.profiles_public — o diretório de usuários sai do alcance do anon
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ─── O vazamento ────────────────────────────────────────────────────────────
--
-- 0049:33-45 (reafirmado em schema.sql:176-181) cria a view e então executa
-- `alter view public.profiles_public set (security_invoker = off)`. O próprio
-- comentário da 0049 (linhas 22-26) diz que isso é DE PROPÓSITO: a view lê
-- `profiles` com o privilégio do DONO e portanto IGNORA a RLS de `profiles` —
-- que é justamente por que ela continuou funcionando depois de a 0050 dropar a
-- policy ampla de leitura.
--
-- O único grant escrito é `grant select ... to authenticated`. Mas isso não é a
-- ACL inteira: pelo grant padrão do schema `public` (fato (2) do cabeçalho),
-- `anon` também recebeu SELECT no momento em que a view foi criada. Resultado:
--
--     GET /rest/v1/profiles_public?select=*   +   a chave do binário
--       → id, full_name, avatar_url, rating, type, driver_code
--         de TODO passageiro e TODO motorista.
--
-- `driver_code` é a credencial do QR que o AppNavigator aceita para travar uma
-- corrida num motorista específico. Isto é uma divulgação MAIOR que a do pool
-- de corridas, e uma varredura de `create policy` nunca a encontraria: não há
-- policy nenhuma envolvida — views não têm RLS, têm ACL.
--
-- ─── A prova, só de código, de que `anon` realmente tinha esse SELECT ───────
--
-- src/screens/passenger/ExpressRegisterScreen.tsx consultava `profiles_public`
-- por `driver_code`, e `supabase.auth.signUp()` só era chamado ~20 linhas
-- depois, na MESMA função. A tela é registrada em AppNavigator dentro do ramo
-- `!isAuthenticated`, e é alcançada por deep link de QR por quem não tem conta.
-- Não havia sessão: a requisição saía como papel `anon`. O recurso Cadastro
-- Expresso está embarcado e é vendido como funcional — logo `anon` tinha o
-- SELECT. (Inferência a partir de código embarcado, não observação.)
--
-- ─── O substituto ───────────────────────────────────────────────────────────
--
-- supabase/functions/resolve-driver-code/index.ts (verify_jwt = false, ver
-- supabase/config.toml): recebe UM código, roda com service_role, e devolve só
-- `{ id, full_name }` de um perfil `type = 'driver'`. Não existe caminho de
-- listagem, e a resposta nunca inclui `driver_code`, avatar, nota, e-mail ou
-- telefone. Rate limit por IP em duas janelas (D.1 abaixo) para o endpoint não
-- virar oráculo de enumeração de `driver_code`.
--
-- Os DOIS call sites foram migrados:
--   • ExpressRegisterScreen.tsx  — o consumidor pré-login de verdade;
--   • AppNavigator.dispatchPendingDeepLink — este já rodava autenticado nos
--     três caminhos que o chamam (conferido: todos passam por `session`
--     não-nulo ou `isAuthedRef.current`), então NÃO teria quebrado com a
--     revogação. Migrado mesmo assim para que os dois destinos do QR resolvam o
--     código pelo mesmo caminho, sem depender de a sessão ter assentado.
--
-- Os outros nove leitores de `profiles_public` (DriverNavigateScreen:325,
-- ActiveRideScreen:185, DriverHomeScreen:155, ScheduledRidesScreen:63,
-- useDriverScheduledRides:149, IncomingRideCall:128, useUnreadMessages:73,
-- useUpcomingScheduledRide:66) vivem em telas/hooks montados só dentro de um
-- stack autenticado. Os três scripts de `supabase/scripts/` usam
-- service_role. Nenhum deles é afetado.

revoke all on public.profiles_public from anon;
grant select on public.profiles_public to authenticated;

comment on view public.profiles_public is
  'Colunas não sensíveis de profiles. `security_invoker = off` (0049) — ignora a RLS de profiles de propósito, então quem tem SELECT aqui lê a linha de QUALQUER usuário. Por isso `anon` foi REVOGADO na 0067: com a anon key pública do binário, um GET nesta view devolvia o diretório inteiro do app, driver_code incluso. Leitura pré-login vai pela Edge Function resolve-driver-code.';

-- ─────────────────────────────────────────────────────────────────────────────
-- D.1 — Rate limit para lookups PÚBLICOS (usado por resolve-driver-code).
--
-- Mesmo formato de bucket da 0051 (`admin_rate_limits`), pelo mesmo motivo
-- explicado lá: Edge Functions rodam em instâncias efêmeras e paralelas, então
-- contador em memória não vale nada — o bucket precisa estar no Postgres.
-- Tabela separada da 0051 de propósito: aquela é chaveada por `admin_id uuid`
-- e é só para o painel admin; esta é chaveada por um texto opaco (hash do IP).
--
-- O IP chega HASHEADO da Edge Function: o objetivo é contar requisições, não
-- montar um registro de endereços IP de quem escaneia QR.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.public_lookup_rate_limits (
  bucket_key     text        not null,
  function_name  text        not null,
  window_start   timestamptz not null,
  request_count  integer     not null default 1,
  primary key (bucket_key, function_name, window_start)
);

create index if not exists public_lookup_rate_limits_window_idx
  on public.public_lookup_rate_limits (window_start);

-- Suporte à CONTAGEM DE BUCKETS DISTINTOS da janela corrente (ver o teto de
-- cardinalidade dentro da função). A PK não serve para isso: ela começa por
-- `bucket_key`, então não há como varrer "todas as linhas desta função nesta
-- janela" por ela.
create index if not exists public_lookup_rate_limits_fn_window_idx
  on public.public_lookup_rate_limits (function_name, window_start);

comment on table public.public_lookup_rate_limits is
  'Buckets de rate limit por (chave opaca, função, janela) para Edge Functions PÚBLICAS (verify_jwt=false). A chave é um hash do IP do chamador, nunca o IP. Só service_role toca. Ver migration 0067 D.1.';

alter table public.public_lookup_rate_limits enable row level security;

-- Nenhum client lê ou escreve isto diretamente — evita que alguém "resete" o
-- próprio limite via REST. RLS ligada + policy só de service_role, E o revoke
-- explícito, porque o grant padrão do schema `public` (fato (2) do cabeçalho)
-- daria SELECT a anon/authenticated nesta tabela recém-criada.
revoke all on public.public_lookup_rate_limits from anon;
revoke all on public.public_lookup_rate_limits from authenticated;

drop policy if exists public_lookup_rate_limits_service_all on public.public_lookup_rate_limits;
create policy public_lookup_rate_limits_service_all
  on public.public_lookup_rate_limits for all
  to service_role
  using (true)
  with check (true);

-- Incrementa atomicamente o bucket da janela atual e devolve true se AINDA
-- dentro do limite. `security definer` pelo mesmo motivo da 0051: a função é
-- chamada pelo client service_role da Edge Function e não deve depender de
-- grants adicionais na tabela.
create or replace function public.check_public_lookup_rate_limit(
  p_bucket_key     text,
  p_function_name  text,
  p_max_requests   integer,
  p_window_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  -- Teto de buckets DISTINTOS por (função, janela). Ver o bloco de comentário
  -- abaixo: é isto que impede que crescimento de linhas vire desligamento
  -- global do controle. Dimensionado muito acima de qualquer tráfego legítimo
  -- deste app (frota e passageiros de Orlando, janela de 60 s), e ainda assim
  -- um limite duro.
  c_max_buckets  constant integer := 5000;
  -- Quantas linhas expiradas cada chamada apaga. Determinístico (roda SEMPRE),
  -- escopado pelo índice de `window_start`, e LIMITADO para que a limpeza não
  -- possa ela mesma estourar o statement_timeout do PostgREST. Cada chamada
  -- insere no máximo 1 linha e apaga até 200: a limpeza nunca fica para trás.
  c_delete_batch constant integer := 200;

  v_window_start timestamptz;
  v_count        integer;
  v_buckets      integer;
begin
  if p_window_seconds is null or p_window_seconds <= 0 then
    raise exception 'p_window_seconds deve ser positivo';
  end if;

  v_window_start := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  -- ───────────────────────────────────────────────────────────────────────────
  -- 1. LIMPEZA DETERMINÍSTICA E LIMITADA — antes de inserir, sempre.
  --
  -- A versão anterior limpava sob `random() < 0.01`. "Provavelmente limpa" não
  -- é um controle: com uma chave de bucket forjável (o defeito P0 corrigido em
  -- resolve-driver-code/guard.ts), um atacante inseria linhas distintas mais
  -- rápido do que 1% das chamadas conseguia apagar. O desfecho não era só
  -- inchaço: com a tabela grande, o `insert ... on conflict` passava a estourar
  -- o statement_timeout do PostgREST, a RPC virava erro — e a Edge Function,
  -- que falhava ABERTA, deixava de limitar TODO MUNDO. Crescimento de linhas
  -- convertido em desligamento global do controle.
  --
  -- `ctid in (select ... limit)` em vez de um `delete ... limit` (que o
  -- Postgres não tem): a subconsulta é resolvida pelo índice de `window_start`
  -- e o custo por chamada fica preso ao teto de `c_delete_batch`.
  --
  -- A margem é 2 janelas (não 10): passada a janela corrente, a linha não é
  -- mais consultada por ninguém. Guardar 10 janelas era só cardinalidade extra.
  -- ───────────────────────────────────────────────────────────────────────────
  delete from public.public_lookup_rate_limits
   where ctid in (
     select ctid
       from public.public_lookup_rate_limits
      where window_start < v_window_start - (p_window_seconds * 2) * interval '1 second'
      order by window_start
      limit c_delete_batch
   );

  -- ───────────────────────────────────────────────────────────────────────────
  -- 2. INCREMENTO. Tenta primeiro o UPDATE do bucket já existente: esse caminho
  --    não cria cardinalidade nova e é o caminho de todo chamador recorrente.
  -- ───────────────────────────────────────────────────────────────────────────
  update public.public_lookup_rate_limits
     set request_count = request_count + 1
   where bucket_key    = p_bucket_key
     and function_name = p_function_name
     and window_start  = v_window_start
  returning request_count into v_count;

  if not found then
    -- ─────────────────────────────────────────────────────────────────────────
    -- 3. TETO DE CARDINALIDADE — só no caminho que CRIA bucket novo.
    --
    -- Estourado o teto, a resposta é NEGAR (`false`), não criar a linha. Ou
    -- seja: sob spray de chaves forjadas o controle fica mais ESTRITO, nunca
    -- mais frouxo, e a tabela para de crescer em vez de degradar a RPC.
    --
    -- Efeito colateral honesto: um ataque assim nega o Cadastro Expresso a
    -- chamadores novos enquanto a janela dura (60 s na janela curta). É uma
    -- negação de serviço temporária e RUIDOSA — preferível ao desfecho
    -- anterior, que era silencioso e desligava o limite para todo mundo.
    --
    -- A contagem e o insert NÃO são atômicos entre si: chamadas concorrentes
    -- podem ultrapassar o teto por algumas linhas. Isso é aceitável de
    -- propósito — o objetivo é limitar ORDEM DE GRANDEZA de cardinalidade, não
    -- garantir um invariante exato, e serializar aqui custaria um lock por
    -- requisição num caminho público.
    -- ─────────────────────────────────────────────────────────────────────────
    select count(*) into v_buckets
      from public.public_lookup_rate_limits
     where function_name = p_function_name
       and window_start  = v_window_start;

    if v_buckets >= c_max_buckets then
      raise warning '[rate-limit] teto de buckets atingido: function=% window=% buckets=%',
        p_function_name, v_window_start, v_buckets;
      return false;
    end if;

    insert into public.public_lookup_rate_limits (bucket_key, function_name, window_start, request_count)
    values (p_bucket_key, p_function_name, v_window_start, 1)
    on conflict (bucket_key, function_name, window_start)
    do update set request_count = public_lookup_rate_limits.request_count + 1
    returning request_count into v_count;
  end if;

  return v_count <= p_max_requests;
end;
$$;

revoke all on function public.check_public_lookup_rate_limit(text, text, integer, integer) from public;
revoke all on function public.check_public_lookup_rate_limit(text, text, integer, integer) from anon;
revoke all on function public.check_public_lookup_rate_limit(text, text, integer, integer) from authenticated;
grant execute on function public.check_public_lookup_rate_limit(text, text, integer, integer) to service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- E. storage.objects — anon deixa de LISTAR o bucket de avatares
-- ═════════════════════════════════════════════════════════════════════════════
--
-- 0016:20-23 cria a policy sem cláusula `to`:
--
--     create policy "Public read avatars"
--       on storage.objects for select using (bucket_id = 'avatars');
--
-- A iteração 1 classificou isso como intencional e benigno. Está errado por
-- dois motivos.
--
-- Primeiro, o bucket já é `public = true` (0016:15). SERVIR uma imagem pela
-- rota pública de storage não consulta RLS — é o `public` do bucket que
-- autoriza. Ou seja, a policy não é o que faz as fotos aparecerem no app.
-- (Comportamento documentado do storage-api do Supabase; não medido aqui.)
--
-- O que a policy ainda comprava era o caminho de LISTAGEM:
-- `POST /storage/v1/object/list/avatars` roda um SELECT em `storage.objects`, e
-- `anon` passava. O retorno é a chave de cada objeto — e a chave é
-- `<user_id>/<arquivo>.jpg` (src/lib/storage.ts:131). Isso é o id de todo
-- usuário que já subiu foto, sem precisar colher nada de lugar nenhum.
--
-- Segundo, o argumento de que o risco dependia do vazamento de `rides` não se
-- sustenta: listar não exige colheita prévia, e a seção D mostra que o id de
-- todo usuário estava disponível de qualquer forma.
--
-- SEGURO: conferido que nenhum código chama `storage.from('avatars').list()`
-- antes do login. A única chamada de `.list()` no repositório inteiro é
-- supabase/functions/delete-account/index.ts:57, com o cliente admin
-- (service_role). `getPublicUrl` (src/lib/storage.ts:137) é montagem de string,
-- não faz requisição. O upload (src/lib/storage.ts:28-34) já lança se não
-- houver `session.access_token`.
drop policy if exists "Public read avatars" on storage.objects;
create policy "Public read avatars"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'avatars');

-- ═════════════════════════════════════════════════════════════════════════════
-- F. Partições de driver_period_transitions — RLS nunca foi ligada nelas
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ─── O vazamento ────────────────────────────────────────────────────────────
--
-- A RLS está ligada só no PAI: 0056:191 e 0057:210. As partições nascem em
-- 0057:109 (mensal, dentro de `ensure_driver_period_transitions_partition`) e
-- 0057:169 (`driver_period_transitions_default`), e NENHUM dos dois sítios
-- executa `alter table ... enable row level security`.
--
-- `relrowsecurity` é por relação, em `pg_class`. A documentação do
-- `CREATE TABLE ... PARTITION OF` enumera o que é clonado do pai — índices,
-- constraints e triggers de linha — e RLS não está na lista. Alcançar as linhas
-- ATRAVÉS do pai aplica as policies do pai; endereçar uma partição DIRETAMENTE
-- consulta a RLS daquela relação. Somando o fato (2) do cabeçalho (grant padrão
-- do schema `public`), cada partição nasceu com SELECT para `anon` e sem RLS.
--
-- Carga por linha (0057:144-160): `driver_id`, `trip_id`, `from_period`/
-- `to_period`, `at_ms`, `lat`, `lng`, `cumulative_miles_at_transition` — um
-- histórico de migalhas de GPS por motorista, atrelado a ids de corrida.
-- Estritamente pior que o instantâneo ao vivo da seção B, porque é histórico e
-- juntável.
--
-- NÃO É POSSÍVEL DECIDIR AQUI se `anon` consegue de fato ler uma partição hoje:
-- depende de o PostgREST expor partições no schema cache da versão instalada, o
-- que só se resolve contra um banco real. Comando no rodapé, seção P8. O que se
-- decide aqui é que, exposto ou não, ele não vai conseguir.
--
-- ─── A correção, escolhida para ser segura sob DUAS leituras ────────────────
--
-- Há uma dúvida honesta de mecânica que não dá para resolver sem um banco: uma
-- consulta que entra PELO PAI chega a avaliar a RLS da partição? Pela leitura
-- que eu considero correta, não (a expansão de herança acontece no planejador,
-- depois da reescrita que injeta RLS, e as RTEs filhas não carregam checagem
-- própria). Mas eu não medi isso, e agir com base nessa leitura seria apostar.
--
-- Então a correção é construída para dar no mesmo NAS DUAS leituras:
--
--   (a) liga RLS na partição E CLONA as três policies do pai nela. Se a leitura
--       pessimista estiver certa e a RLS da partição for consultada em consultas
--       pelo pai, as policies estão lá e a semântica é idêntica à do pai — nada
--       quebra. Se a leitura otimista estiver certa, as policies governam o
--       acesso DIRETO à partição, que é exatamente o buraco. Ligar RLS sem
--       clonar policy seria a alternativa "óbvia" e é a perigosa: sob a leitura
--       pessimista, uma partição com RLS e zero policies nega tudo — inclusive o
--       INSERT do motorista pelo pai (src/hooks/useDriverPeriodTracker.ts:334,
--       que roda no CLIENT como `authenticated`) e a leitura do painel admin
--       (supabase/functions/admin-telematics-claims). Apagão da trilha de
--       auditoria de compliance;
--
--   (b) revoga SÓ de `anon` — nunca de `authenticated`. Se a checagem de ACL de
--       partição não acontecer em acesso pelo pai (leitura otimista), isto é
--       defesa em profundidade de graça. Se acontecer (leitura pessimista),
--       o único papel afetado é `anon`, que não tem uso legítimo nesta tabela.
--       Nos dois casos, o caminho de escrita do motorista e o de leitura do
--       admin ficam intactos. `service_role` não é tocado.
--
-- ─── E as partições FUTURAS ─────────────────────────────────────────────────
--
-- Corrigir só as partições existentes deixaria o buraco voltar no mês que vem,
-- quando o cron de manutenção (0057, seção 6) criar a próxima. Por isso
-- `ensure_driver_period_transitions_partition` é recriada abaixo chamando o
-- mesmo helper. A 0057 NÃO é editada — migração já aplicada não se reescreve;
-- esta a substitui via `create or replace`.

-- F.1 — Helper idempotente: liga RLS, clona as policies do pai e revoga anon.
create or replace function public.secure_driver_period_transitions_partition(p_partition text)
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  if to_regclass('public.' || quote_ident(p_partition)) is null then
    return;
  end if;

  execute format('alter table public.%I enable row level security', p_partition);

  -- Espelha driver_period_transitions_insert_own (0057:194-198).
  execute format('drop policy if exists %I on public.%I',
                 p_partition || '_insert_own', p_partition);
  execute format($p$
    create policy %I on public.%I for insert
      to authenticated
      with check ((select auth.uid()) = driver_id)
  $p$, p_partition || '_insert_own', p_partition);

  -- Espelha driver_period_transitions_select_own_or_admin (0057:200-207).
  execute format('drop policy if exists %I on public.%I',
                 p_partition || '_select_own_or_admin', p_partition);
  execute format($p$
    create policy %I on public.%I for select
      to authenticated
      using (
        (select auth.uid()) = driver_id
        or exists (select 1 from public.profiles p
                    where p.id = (select auth.uid()) and p.is_admin = true)
      )
  $p$, p_partition || '_select_own_or_admin', p_partition);

  -- Espelha driver_period_transitions_service_all (0057:228-233).
  execute format('drop policy if exists %I on public.%I',
                 p_partition || '_service_all', p_partition);
  execute format($p$
    create policy %I on public.%I for all
      to service_role
      using (true)
      with check (true)
  $p$, p_partition || '_service_all', p_partition);

  -- Só anon. Ver a justificativa (b) acima para por que `authenticated` fica.
  execute format('revoke all on public.%I from anon', p_partition);
end;
$$;

revoke all on function public.secure_driver_period_transitions_partition(text) from public;
revoke all on function public.secure_driver_period_transitions_partition(text) from anon;
revoke all on function public.secure_driver_period_transitions_partition(text) from authenticated;
grant execute on function public.secure_driver_period_transitions_partition(text) to service_role;

-- F.2 — Recria a função de manutenção da 0057:87-118 com UMA linha a mais (a
-- chamada ao helper). Todo o resto é idêntico ao original, de propósito: esta
-- migração não muda o comportamento de particionamento, só fecha o buraco.
create or replace function public.ensure_driver_period_transitions_partition(p_month_start date)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_start   date := date_trunc('month', p_month_start)::date;
  v_end     date := (date_trunc('month', p_month_start) + interval '1 month')::date;
  v_name    text := format('driver_period_transitions_y%s_m%s', to_char(v_start, 'YYYY'), to_char(v_start, 'MM'));
  v_existed boolean;
begin
  select exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = v_name
  ) into v_existed;

  if v_existed then
    return false;
  end if;

  execute format(
    'create table if not exists public.%I partition of public.driver_period_transitions for values from (%L) to (%L)',
    v_name, v_start, v_end
  );

  -- ÚNICA adição da 0067: sem isto, toda partição nova nasce sem RLS e — pelo
  -- grant padrão do schema `public` — com SELECT para `anon`.
  perform public.secure_driver_period_transitions_partition(v_name);

  insert into public.driver_period_transitions_maintenance_log (action, partition_name, boundary_from, boundary_to)
  values ('partition_created', v_name, v_start, v_end);

  return true;
end;
$$;

revoke all on function public.ensure_driver_period_transitions_partition(date) from public;
grant execute on function public.ensure_driver_period_transitions_partition(date) to service_role;

-- F.3 — Passada única sobre as partições que JÁ existem (as mensais e a
-- `_default`). Usa o mesmo `pg_inherits` que a 0057 usa no purge (0057:288-296),
-- mas sem filtrar pelo padrão de nome mensal — a `_default` também precisa.
do $$
declare
  r record;
begin
  for r in
    select c.relname
      from pg_inherits i
      join pg_class c on c.oid = i.inhrelid
      join pg_class p on p.oid = i.inhparent
      join pg_namespace n on n.oid = p.relnamespace
     where n.nspname = 'public'
       and p.relname = 'driver_period_transitions'
  loop
    perform public.secure_driver_period_transitions_partition(r.relname);
  end loop;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- Z. ASSERÇÕES — falha alto se o arquivo tiver sido aplicado pela metade
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Por que isto existe: as seções B e F reutilizam nomes de policy, então lá é
-- impossível criar-antes-de-dropar como em A. Se alguém desobedecer o cabeçalho
-- e rodar este arquivo fora de transação (editor SQL do painel), um erro no meio
-- deixaria uma tabela com RLS ligada e nenhuma policy de SELECT — negação total,
-- silenciosa. Este bloco transforma isso em erro imediato e legível.
--
-- Também serve como verificação de fim de execução no caminho normal: se
-- qualquer coisa acima não tiver surtido o efeito pretendido, a transação
-- inteira aborta e nada é aplicado.
do $$
declare
  v_bad     text;
  v_count   integer;
  v_missing text;
begin
  -- Z.1 — nenhuma policy de rides/driver_locations pode continuar em {public}.
  select string_agg(format('%s.%s (cmd=%s)', tablename, policyname, cmd), ', ')
    into v_bad
    from pg_policies
   where schemaname = 'public'
     and tablename in ('rides', 'driver_locations')
     and 'public' = any(roles);

  if v_bad is not null then
    raise exception '0067 incompleta: policies ainda acessíveis por anon: %', v_bad;
  end if;

  -- Z.2 — e nenhuma das duas pode ter ficado SEM policy de SELECT (negação
  -- total = apagão de despacho). Este é o cenário que a ordem create-antes-de-
  -- drop da seção A evita e que este bloco captura para a seção B.
  for v_missing in
    select t from unnest(array['rides', 'driver_locations']) as t
  loop
    select count(*) into v_count
      from pg_policies
     where schemaname = 'public' and tablename = v_missing and cmd = 'SELECT';
    if v_count = 0 then
      raise exception '0067 incompleta: public.% ficou com RLS ligada e ZERO policies de SELECT (negação total)', v_missing;
    end if;
  end loop;

  -- Z.3 — a policy de UPDATE de rides (seção C) tem de existir e declarar papel.
  select count(*) into v_count
    from pg_policies
   where schemaname = 'public' and tablename = 'rides' and cmd = 'UPDATE';
  if v_count = 0 then
    raise exception '0067 incompleta: public.rides ficou sem policy de UPDATE';
  end if;

  -- Z.4 — anon não pode mais ler a view do diretório de usuários.
  -- `to_regrole` devolve NULL em vez de erro se o papel não existir (banco
  -- Postgres puro, fora do Supabase), então o check se auto-ignora lá.
  if to_regrole('anon') is not null
     and has_table_privilege('anon', 'public.profiles_public', 'SELECT') then
    raise exception '0067 incompleta: anon ainda tem SELECT em public.profiles_public';
  end if;

  -- Z.5 — a policy de listagem do bucket de avatares tem de declarar papel.
  select string_agg(policyname, ', ') into v_bad
    from pg_policies
   where schemaname = 'storage'
     and tablename = 'objects'
     and policyname = 'Public read avatars'
     and 'public' = any(roles);

  if v_bad is not null then
    raise exception '0067 incompleta: storage.objects."Public read avatars" ainda é acessível por anon';
  end if;

  -- Z.6 — toda partição de driver_period_transitions tem de estar com RLS.
  select string_agg(c.relname, ', ') into v_bad
    from pg_inherits i
    join pg_class c on c.oid = i.inhrelid
    join pg_class p on p.oid = i.inhparent
    join pg_namespace n on n.oid = p.relnamespace
   where n.nspname = 'public'
     and p.relname = 'driver_period_transitions'
     and c.relrowsecurity = false;

  if v_bad is not null then
    raise exception '0067 incompleta: partições sem RLS: %', v_bad;
  end if;

  raise notice '0067: asserções OK (A-F aplicadas).';
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- PROVA — o que um humano precisa rodar num CLONE DE STAGING
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Nada abaixo foi executado. Não há banco neste ambiente. Rode contra staging,
-- nunca contra produção, e com dados de teste.
--
-- ── P0.a. Inventário de policies ─────────────────────────────────────────────
--
--   select tablename, policyname, cmd, roles, qual
--     from pg_policies
--    where schemaname = 'public'
--      and tablename in ('rides', 'driver_locations')
--    order by tablename, policyname;
--
--   ESPERADO: `roles` = {authenticated} em TODAS as linhas. Qualquer `{public}`
--   remanescente é um buraco. Em `rides`: 2 de SELECT (A.2, A.3), 1 de UPDATE
--   (C.1) e 1 de INSERT (C.2). Em `driver_locations`: 3 — mas só até a 0069,
--   que dropa "Passageiro vê motoristas online" de propósito e assevera a
--   ausência dela (0069:1184-1191). Rodando isto num banco já com a 0069, o
--   esperado em `driver_locations` é 2, e não 3.
--
--   Uma versão anterior desta nota dizia que o INSERT estava "fora do escopo".
--   Estava errada, e a asserção Z.1 é que estava certa — ver C.2.
--
-- ── P0.b. A CAUSA RAIZ — o grant padrão do schema public ────────────────────
--
--   Isto é o que a iteração 1 não viu e o que vai recriar o problema no próximo
--   objeto criado em `public` se não for tratado:
--
--     select defaclobjtype, defaclacl from pg_default_acl;
--     \dp public.profiles_public
--     \dp public.driver_period_transitions_*
--
--   ESPERADO em `pg_default_acl`: uma entrada de tabelas concedendo a `anon`.
--   Se estiver lá, TODA tabela/view/partição nova em `public` continuará
--   nascendo legível por anon, e esta migração é um remendo por objeto. O
--   conserto sistêmico é
--     alter default privileges in schema public revoke all on tables from anon;
--   que NÃO está nesta migração de propósito: ele muda o comportamento de todo
--   objeto futuro do projeto e precisa de uma varredura própria de quem depende
--   de acesso anônimo. Fica registrado como pendência, com o comando pronto.
--
-- ── P1. NEGATIVO: `anon` não lê mais nada. Este é o teste que importa. ──
--
--   -- garanta que existe dado, senão o teste passa por vacuidade:
--   select count(*) from public.rides where status = 'requesting';            -- > 0
--   select count(*) from public.driver_locations where is_online = true;      -- > 0
--   select count(*) from public.profiles;                                     -- > 0
--
--   begin;
--     set local role anon;
--     -- sem claims de JWT: auth.uid() é NULL, exatamente como um curl cru
--     select count(*) as rides_vistas_por_anon    from public.rides;
--     select count(*) as posicoes_vistas_por_anon from public.driver_locations;
--   rollback;
--
--   ESPERADO: 0 e 0.
--
-- ── P2. NEGATIVO: o diretório de usuários (seção D) ─────────────────────────
--
--   ESTE É O TESTE NOVO MAIS IMPORTANTE.
--
--   begin;
--     set local role anon;
--     select count(*) from public.profiles_public;
--   rollback;
--
--   ESPERADO: ERRO `permission denied for view profiles_public`. Um erro aqui é
--   SUCESSO — a revogação é de ACL, não de RLS, então o Postgres recusa a
--   consulta inteira em vez de devolver zero linhas. Antes da 0067 isto
--   devolvia a contagem de TODOS os usuários do app.
--
--   Equivalente por fora do banco, com a chave que está no binário:
--     curl -s "$SUPABASE_URL/rest/v1/profiles_public?select=*" \
--          -H "apikey: sb_publishable_Tu3TmYgQa6gOII2X-AbDLg_A0eLlIbd"
--   ESPERADO depois da 0067: 401/403 com `permission denied`. ANTES: um array
--   JSON com id/full_name/avatar_url/rating/type/driver_code de todo mundo.
--   Para ver o "antes", rode no clone ANTES de aplicar o arquivo — é a única
--   comparação honesta.
--
--   E os outros dois da mesma família:
--     curl -s "$SUPABASE_URL/rest/v1/rides?select=*" -H "apikey: <a mesma>"
--     curl -s "$SUPABASE_URL/rest/v1/driver_locations?select=*" -H "apikey: <a mesma>"
--   ESPERADO: `[]` nas duas (aqui é RLS, então é array vazio, não erro).
--
-- ── P3. POSITIVO: o Cadastro Expresso continua funcionando SEM conta ────────
--
--   O fluxo que a seção D poderia ter quebrado. Pegue um código real:
--     select driver_code from public.profiles where type='driver' and driver_code is not null limit 1;
--
--   curl -s -X POST "$SUPABASE_URL/functions/v1/resolve-driver-code" \
--        -H "Content-Type: application/json" \
--        -d '{"driver_code":"<CODIGO_REAL>"}'
--   ESPERADO: {"driver":{"id":"<uuid>","full_name":"<nome>"}} — SEM nenhum
--   header de Authorization. Se vier 401, falta
--   `[functions.resolve-driver-code] verify_jwt = false` no config.toml (e a
--   função precisa ter sido deployada: `npx supabase functions deploy
--   resolve-driver-code`).
--
--   NEGATIVOS do mesmo endpoint:
--     -d '{"driver_code":"ZZZZZZ"}'      → {"driver":null}  (código inexistente)
--     -d '{"driver_code":"<de um PASSAGEIRO>"}' → {"driver":null}
--     -d '{"driver_code":"'"'"' or 1=1--"}'     → {"driver":null}  (barrado no formato)
--
--   RATE LIMIT (repita 10x seguidas do mesmo IP):
--     for i in $(seq 1 10); do
--       curl -s -o /dev/null -w "%{http_code}\n" -X POST \
--         "$SUPABASE_URL/functions/v1/resolve-driver-code" \
--         -H "Content-Type: application/json" -d '{"driver_code":"ZZZZZZ"}';
--     done
--   ESPERADO: 200 nas 8 primeiras, 429 daí em diante dentro da mesma janela de
--   60s. Se NENHUMA der 429, cheque se `check_public_lookup_rate_limit` existe
--   e se o service_role tem execute — a função falha ABERTA de propósito.
--
-- ── P4. POSITIVO — o motorista continua enxergando o pool aberto ────────────
--
--   -- select id from public.profiles where type = 'driver' limit 1;
--   begin;
--     set local role authenticated;
--     set local request.jwt.claims = '{"sub":"<UUID_DE_UM_MOTORISTA>","role":"authenticated"}';
--     select public.is_driver();                                   -- tem de ser true
--     select count(*) from public.rides where status = 'requesting';
--     select count(*) from public.rides where status = 'scheduled' and driver_id is null;
--   rollback;
--
--   ESPERADO: `is_driver()` true, e as mesmas contagens do P1 pré-fix. Se
--   `is_driver()` der false, o gate A.3 quebrou o despacho — investigue
--   `profiles.type` daquele usuário ANTES de mexer na policy.
--
-- ── P5. POSITIVO — passageiro vê as corridas DELE; NEGATIVO — só as dele ────
--
--   begin;
--     set local role authenticated;
--     set local request.jwt.claims = '{"sub":"<UUID_DE_UM_PASSAGEIRO>","role":"authenticated"}';
--     select id, passenger_id from public.rides limit 5;  -- todo passenger_id = o do claim
--     select public.is_driver();                          -- tem de ser false
--     select count(*) from public.rides
--      where status = 'requesting' and passenger_id <> '<UUID_DE_UM_PASSAGEIRO>';  -- 0
--     select count(*) from public.driver_locations where is_online = true;         -- > 0 (mapa)
--   rollback;
--
--   A última linha é o mapa do passageiro (useNearbyDrivers): se der 0, o mapa
--   fica vazio no app.
--
-- ── P6. Realtime — o único ponto que psql NÃO prova ─────────────────────────
--
--   As assinaturas do motorista (useRide.ts:1325-1331, 1349-1355, 1374-1380)
--   passam pelo walrus, que reavalia a policy de SELECT por mensagem. P4 prova
--   a policy no plano do SQL, não no do Realtime. Prova de verdade só no app:
--   com a 0067 aplicada em staging, um passageiro abre uma chamada e o card de
--   oferta TEM de aparecer no app de um motorista online sem refresh manual.
--
--   O gate agora é `public.is_driver()`, `security definer`: a RLS de `profiles`
--   NÃO participa da avaliação, o que remove a preocupação de RLS-dentro-de-RLS
--   no walrus. Se ainda assim falhar, o suspeito é o grant de execute na função
--   para `authenticated` (A.1) — cheque com:
--     select has_function_privilege('authenticated', 'public.is_driver()', 'execute');
--
-- ── P7. O EXPLAIN que falta (a afirmação de InitPlan é hipótese) ────────────
--
--   begin;
--     set local role authenticated;
--     set local request.jwt.claims = '{"sub":"<UUID_DE_UM_MOTORISTA>","role":"authenticated"}';
--     explain (analyze, buffers, verbose)
--       select id from public.rides where status = 'requesting';
--   rollback;
--
--   ESPERADO: `InitPlan` no plano e a chamada de `is_driver()` contabilizada
--   com `loops=1`, não uma por linha. Se aparecer `SubPlan` com loops = nº de
--   linhas, a hipótese do cabeçalho está errada e vale reescrever o gate.
--
-- ── P8. Partições (seção F) — inclui a pergunta que só o banco responde ─────
--
--   -- 8a) o PostgREST expõe partições nesta versão? (a pergunta em aberto)
--   curl -s "$SUPABASE_URL/rest/v1/driver_period_transitions_default?select=*&limit=1" \
--        -H "apikey: sb_publishable_Tu3TmYgQa6gOII2X-AbDLg_A0eLlIbd"
--   ESPERADO depois da 0067: `[]` ou 404/permission denied — nunca uma linha.
--   Rode ANTES de aplicar também: se ANTES vier linha com lat/lng, o vazamento
--   era real e explorável, não teórico. Esse par de execuções é a única forma
--   honesta de fechar essa questão.
--
--   -- 8b) toda partição com RLS ligada:
--   select c.relname, c.relrowsecurity
--     from pg_inherits i
--     join pg_class c on c.oid = i.inhrelid
--     join pg_class p on p.oid = i.inhparent
--    where p.relname = 'driver_period_transitions';
--   ESPERADO: relrowsecurity = true em TODAS. (O bloco Z.6 já aborta se não.)
--
--   -- 8c) NÃO PODE TER QUEBRADO a gravação da trilha pelo motorista, que roda
--   --     no client como `authenticated` (useDriverPeriodTracker.ts:334):
--   begin;
--     set local role authenticated;
--     set local request.jwt.claims = '{"sub":"<UUID_DE_UM_MOTORISTA>","role":"authenticated"}';
--     insert into public.driver_period_transitions
--       (driver_id, from_period, to_period, reason, at_ms, lat, lng)
--     values ('<UUID_DE_UM_MOTORISTA>', 'P0_OFFLINE', 'P1_AVAILABLE', 'teste_0067',
--             (extract(epoch from now())*1000)::bigint, 28.5, -81.4);
--     select count(*) from public.driver_period_transitions where reason = 'teste_0067';  -- 1
--   rollback;
--
--   ESPERADO: o insert PASSA e o select devolve 1. Se falhar com "new row
--   violates row-level security policy", o clone de policies do F.1 não pegou —
--   é o risco de over-reach desta seção e é o teste que o expõe.
--
--   -- 8d) partição nova (futura) já nasce protegida:
--   select public.ensure_driver_period_transitions_partition(
--            (date_trunc('month', now()) + interval '6 months')::date);
--   -- depois repita 8b e confirme que a nova aparece com relrowsecurity = true.
--
-- ── P9. Listagem do bucket de avatares (seção E) ────────────────────────────
--
--   -- NEGATIVO: anon não lista mais
--   curl -s -X POST "$SUPABASE_URL/storage/v1/object/list/avatars" \
--        -H "apikey: sb_publishable_Tu3TmYgQa6gOII2X-AbDLg_A0eLlIbd" \
--        -H "Content-Type: application/json" -d '{"prefix":"","limit":100}'
--   ESPERADO depois: `[]`. ANTES: uma entrada por avatar, com `name` =
--   `<user_id>/<arquivo>.jpg` — ou seja, o id de todo usuário com foto.
--
--   -- POSITIVO: a foto continua sendo SERVIDA (bucket public, não passa por RLS)
--   curl -s -o /dev/null -w "%{http_code}\n" \
--        "$SUPABASE_URL/storage/v1/object/public/avatars/<user_id>/<arquivo>.jpg"
--   ESPERADO: 200. Se der 400/404, a premissa de que a rota pública não
--   consulta RLS está errada nesta versão do storage-api e a seção E precisa
--   ser revertida — é a única hipótese não verificada dessa seção.
