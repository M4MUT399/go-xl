# Auditoria adversarial do GoXL — relatório único

Data: 2026-08-20 · Escopo: auditoria do que existe no repositório, mais correção dos defeitos encontrados.

**Leia primeiro esta linha.** Nada neste relatório foi medido em device, em banco de dados real ou contra a API da Stripe. Não há Postgres, Docker, psql, celular nem simulador na máquina onde a auditoria rodou, e nenhuma chamada à Stripe foi feita. Onde um número não pôde ser medido, está escrito **NÃO MEDIDO** — nunca um número estimado. Onde um app de referência (Uber, Lyft Driver, Blacklane, Stripe) é citado, o rótulo é **rubrica documentada, não observada**: ninguém rodou esses apps.

---

## 1. Status por módulo e contagem de iterações

Doze críticos adversariais, um por módulo, **1 iteração cada**. Resultado: **12 de 12 REPROVADO**. Nenhum módulo recebeu segundo veredito — depois da primeira rodada o trabalho foi reorganizado em seis *itens* de correção transversais, porque os mesmos P0 apareciam em três e quatro módulos ao mesmo tempo (o `0041:28-34`, por exemplo, reprovou os módulos 7, 8 e 11 sozinho).

| # | Módulo | Veredito | Iterações | P0 levantados |
|---|--------|----------|-----------|---------------|
| 1 | Cadastro e verificação do passageiro | REPROVADO | 1 | 4 |
| 2 | Onboarding do motorista parceiro | REPROVADO | 1 | 4 |
| 3 | Solicitação de corrida e autocomplete | REPROVADO | 1 | 2 |
| 4 | Cotação de preço e ETA | REPROVADO | 1 | 2 |
| 5 | Matching e despacho | REPROVADO | 1 | 3 |
| 6 | Corrida ao vivo | REPROVADO | 1 | 2 |
| 7 | Pagamento e split via Stripe Connect | REPROVADO | 1 | 4 |
| 8 | App do motorista, ganhos e repasse | REPROVADO | 1 | 4 |
| 9 | Agendamento e premium (MCO) | REPROVADO | 1 | 4 |
| 10 | Avaliação, suporte, cancelamento e taxas | REPROVADO | 1 | 2 |
| 11 | Segurança (SOS, compartilhar viagem, identidade) | REPROVADO | 1 | 4 |
| 12 | Erros, offline e perda de GPS | REPROVADO | 1 | 3 |

### Os seis itens de correção

Cada item teve seu próprio ciclo implementador ↔ crítico, com teto de 5 iterações.

| Item | Assunto | Iterações | Veredito final |
|---|---|---|---|
| 1 | Fronteira de escrita de dinheiro | 4 | **APROVADO** na r4 |
| 2 | Promessas de dinheiro que o código não cumpre | 5 | REPROVADO no teto |
| 3 | Exposição de dados e RLS | 5 | REPROVADO no teto |
| 4 | Agendar o tick do despacho | 3 | REPROVADO |
| 5 | UI que mente sobre o estado | 2 | REPROVADO |
| 6 | Substituir testes circulares por testes reais | 5 | REPROVADO no teto |

**Ressalva que muda como ler a coluna do veredito:** em todos os itens houve correção DEPOIS do último parecer, e essas correções **não foram re-auditadas** — o teto de 5 iterações estava esgotado. No item 6, os 5 defeitos da r5 foram todos corrigidos e cada um está preso por um mutante que mata o teste (ver §5); ainda assim, nenhum crítico julgou o resultado. O item 1 é o único cujo APROVADO é o estado final de verdade.

---

## 2. Comparação cega — uma linha por módulo

**Não realizada.** Para nenhum dos 12 módulos. Não há como rodar Uber, Lyft Driver ou Blacklane nesta máquina, e uma comparação lado a lado inventada seria pior do que nenhuma. Os 12 críticos foram instruídos a rotular qualquer referência externa como *rubrica documentada, não observada*, e cumpriram.

As duas únicas comparações efetivamente escritas saíram de itens, não de módulos, e ambas contra rubrica:

- **Item 4 (despacho) × Uber** — *"A = GoXL com 0071, B = Uber. B vence em latência de expiração, aceite pós-vencimento e ausência de órfã; empata no resto. A não vence nem empata."*
- **Item 6 (app do motorista) × Lyft Driver** — *"perde — banner de status com escopo de turno é item de base"*; e **× Uber** no despacho — *"empata em cadência e portão de estados, perde em liveness de transporte."*

Pelo critério do briefing (aprova só quando o GoXL vence ou empata), os dois eixos comparados hoje **reprovam**.

---

## 3. Reconciliação financeira de 100 corridas simuladas

**NÃO REALIZADA.** Zero corridas simuladas, zero chamadas à Stripe, zero centavos reconciliados.

O que essa reconciliação exige, e que hoje não existe: chave `sk_test_`, 100 corridas com pedágio, taxa de aeroporto e gorjeta variados, asserção em centavos inteiros com o valor esperado calculado por uma implementação **independente** de `calculateSplit` (usar a própria função tornaria o teste circular, que é exatamente o defeito que o item 6 existe para eliminar), replay do mesmo webhook 3×, duplo toque no botão de pagar, e um estorno depois do repasse já transferido.

Consequência direta: o critério *"zero divergência de pagamento em 100 corridas, reconciliado ao centavo"* está **não verificado**, e os itens 4, 7 e 8 não podem fechar — a regra do briefing é explícita em que módulo financeiro não fecha com mock.

Sobre a **regra de repasse 85/15 nos primeiros 100 motoristas e 80/20 depois**: a faixa é aplicada no servidor e os repasses em si estão corretos, mas a tela de ganhos do motorista tem um defeito aberto que a exibe errado — ver P1-5 na §4.

---

## 4. Defeitos abertos, por prioridade

Só entram aqui defeitos que um crítico apontou e que **continuam abertos**. Os fechados durante os seis itens não estão listados. As exceções são os quatro P0 abaixo: eles ficam registrados mesmo já corrigidos, porque nenhum crítico os encontrou e o motivo disso é o P1 nº 0, que segue aberto.

### P0 — quatro, nenhum encontrado por leitura, todos corrigidos nesta rodada

Os P0 levantados pelos 12 críticos foram endereçados nos itens 1 a 6 ou nas correções específicas (autorização do `charge-ride`, faixa de repasse perdida em silêncio, corridas `requesting` sem reaper, oráculo de trilateração em `nearby_online_drivers`, sequestro de `driver_code`) — **sem re-auditoria**, então essa ausência é o estado do trabalho, não um veredito.

Os quatro abaixo são diferentes, e cada um exigiu um degrau a mais de evidência. Os dois primeiros apareceram ao **executar** as migrations; os dois últimos só apareceram ao **atacar** o banco depois de construído, porque a forma das regras estava toda certa.

**P0-11. A migration 0067 aborta a si mesma.** — `0067_close_anon_readable_policies.sql:961-970`

A asserção Z.1 reprova **qualquer** policy de `rides`/`driver_locations` que ainda esteja em `{public}`. O comentário da própria migration (`:1048`) declara o INSERT `"Passageiro cria corrida"` como *"fora do escopo"*. As duas coisas não podem ser verdade ao mesmo tempo: a policy nasce no schema base **sem cláusula `TO`** (logo `{public}`, `schema.sql:187`) e **nenhuma das 71 migrations jamais a altera** — conferido por busca no diretório inteiro.

Experimento com controle, banco descartável: rodada 1, estado do repositório → `ERRO P0001: 0067 incompleta: policies ainda acessíveis por anon: rides.Passageiro cria corrida (cmd=INSERT)`. Rodada 2, única alteração sendo `to authenticated` naquela policy de INSERT → **aplica**. Causa isolada.

Consequência: 0067 é a migration que fecha as leituras anônimas, e ela **não aplica em nenhum banco construído a partir deste repositório**. Se produção tem a policy como `{public}`, os buracos que a 0067 existe para fechar seguem abertos. O estado de produção não é observável daqui — mas a resposta do repositório é inequívoca.

**Corrigido — na própria 0067, e a escolha do lugar é o ponto.** A regra de "não editar migration antiga" vale para migration **já aplicada**. Esta nunca foi: `git ls-files` não a rastreia, e `git status` a mostra como `??`, junto com 0064–0071. Nunca entrou no git, logo nunca passou por deploy. E uma migration nova **não resolveria**: qualquer número acima de 0067 é aplicado *depois* dela, e o `db push` abortaria na 0067 antes de chegar lá. Editar o arquivo é o único conserto que funciona.

Nova seção **C.2** do arquivo: `drop policy` + `create policy … for insert to authenticated with check ((select auth.uid()) = passenger_id)`. A nota da seção PROVA que dizia "fora do escopo" foi corrigida — quem estava certa era a asserção Z.1. Verificado com o banco recriado do zero: **0 policies em `{public}`** em `rides` e `driver_locations`, e a 0067 aplica.

**P0-12. A migration 0012 nunca cumpriu o que ela existe para fazer.** — `0012_refresh_rides_view.sql:6`

`create or replace view` **não pode inserir coluna no meio** da lista — só acrescentar no fim. A view `rides_with_locations` é criada com `select r.*` e termina em `(..., paid, origin, destination)`; a 0006 acrescenta `driver_amount`, `platform_fee` e `payout_id` a `rides`; quando a 0012 re-expande o `r.*`, `driver_amount` cai exatamente onde `origin` estava. O Postgres recusa: `cannot change name of view column "origin" to "driver_amount"`.

Experimento com controle: rodada 1, como está no repositório → aborta, e a view fica com **20 colunas, sem `driver_amount`**. Rodada 2, trocando por `drop view … cascade` + `create view` → aplica, e a view passa a **27 colunas, com `driver_amount`**.

E há prova independente de que isso também aconteceu em produção — vinda do próprio app, em `ActiveRideScreen.tsx:245-249`: *"lemos a TABELA `rides` diretamente, NÃO a view rides_with_locations … como ela foi criada antes da migration 0011, NÃO inclui driver_lat/lng/eta_*"*. Alguém encontrou o sintoma em campo e contornou no cliente, sem que a causa (a 0012 ter falhado) fosse identificada.

**Corrigido — aqui sim numa migration nova, `0072_rebuild_rides_with_locations.sql`.** A 0012 é rastreada pelo git, é antiga e já rodou: editá-la não a faz rodar de novo, porque o Supabase rastreia migration por nome. Os dois P0 vizinhos exigiram consertos de formato oposto, e o critério é um só — se já rodou, arquivo novo; se nunca rodou, o próprio arquivo.

Três decisões dentro da 0072, e nenhuma é cosmética:

- **`drop view` sem `cascade`.** No banco local `pg_depend` não acusa dependente nenhum, e nenhum arquivo do repositório consulta a view (não existe um só `from('rides_with_locations')` em `src/` ou `supabase/functions/`). Mas o banco local é um dublê e não sabe de objeto criado pelo painel. Sem `cascade`, se houver um dependente desconhecido em produção a migration **falha e mostra o nome dele**, dentro de uma transação que reverte inteira. Com `cascade`, ela o destruiria em silêncio. Falhar alto é recuperável; apagar calado não é.
- **`security_invoker = on` reaplicado.** Recriar uma view apaga as propriedades dela. Sem essa linha, a view voltaria a rodar com privilégio do owner e passaria por cima da RLS de `rides` — reintroduzindo exatamente o defeito que a 0036 existe para consertar.
- **`revoke all … from anon`.** O privilege default do schema `public` fazia todo objeto novo nascer legível por `anon` — a causa raiz que a própria 0067 documenta (seção PROVA, P0.b). A recriação era a chance de não repetir isso.

O arquivo termina com uma asserção que aborta se sobrar qualquer coluna de `rides` fora da view ou se `security_invoker` não estiver ligado. Estado verificado depois de recriar o banco do zero: **43 colunas, com `driver_amount` e `driver_lat`**, `security_invoker=on`, e `anon` sem grant nenhum.

**P0-13. Qualquer conta logada reescrevia e apagava o perfil de qualquer outra.** — `profiles_public`, corrigido na `0073_lock_view_write_privileges.sql`

Este é o mais grave dos três, e é o único que **não** teria aparecido nem lendo o SQL nem executando as migrations. Todas elas aplicam limpo; todas as policies de `profiles` estão certas; `pg_policies` não tem uma linha fora do lugar. O defeito só existe do lado de fora das policies, e por isso só apareceu quando o banco foi **atacado** com um usuário de verdade — `set local role authenticated` mais o claim que o PostgREST injetaria.

Bob é uma conta comum de passageiro, do Cadastro Expresso, que é grátis e não verificado. O controle primeiro: `select * from profiles where id = <alice>` devolve **0 linhas** — a RLS funciona. Depois:

| ataque de Bob contra Alice | resultado |
|---|---|
| `update profiles_public set full_name = 'INVADIDO' where id = <alice>` | **1 linha** |
| `update profiles_public set rating = 1.0 where id = <alice>` | **1 linha** |
| `delete from profiles_public where id = <alice>` | **1 linha** |
| `update profiles_public set type = 'driver'` | 0 efeito — o trigger reverte |
| `delete` de vítima que JÁ TEM corrida | 23503, a FK recusa |

É alcançável do aplicativo sem exploit nenhum: o PostgREST publica view como endpoint, então `DELETE /rest/v1/profiles_public?id=eq.<vítima>` com a anon key pública e qualquer sessão logada basta. Nota de motorista para 1.0 em massa, nome de qualquer usuário reescrito, e conta apagada.

O mecanismo são três fatos que só juntos produzem o buraco: (1) o default privilege do Supabase faz view nova nascer com **ALL** para `anon` e `authenticated`; (2) `security_invoker = off` em `profiles_public` (0049:43, 0069:97) — deliberado e ainda correto, mas faz **todo** acesso rodar com privilégio do dono, e isso vale para escrita, não só para leitura; (3) a view é auto-atualizável (`pg_relation_is_updatable` = 28), então INSERT/UPDATE/DELETE atravessam para `profiles`.

**A 0069 chegou a um passo.** Ela escreveu, textualmente (`0069:98-101`): *"Ordem importa: a view acabou de nascer, então o default privilege do schema `public` já concedeu SELECT a `anon`. Revogar é obrigatório — sem esta linha, a 0069 REABRIRIA o buraco que a 0067 fechou."* O raciocínio está certo e foi aplicado pela metade **duas vezes**: só ao papel `anon`, e só ao privilégio `SELECT`. O default concede ALL, e `authenticated` recebe o mesmo que `anon`. `revoke all from anon` seguido de `grant select to authenticated` não tira nada de `authenticated` — `grant` não revoga.

O que segurou o estrago não foi desenho: `type` está protegido por um trigger escrito para outro fim, e o DELETE só falha em vítima que já tem corrida. A proteção efetiva era *"já usou o produto"*, o inverso do que se quer proteger.

**Corrigido na 0073**: `revoke all` **antes** do `grant select`, nas duas views, mais uma asserção que aborta se **qualquer** view de `public` expuser INSERT/UPDATE/DELETE a `anon`/`authenticated` — porque consertar as duas nomeadas resolve hoje e não amanhã: a próxima view nasce com ALL outra vez pelo mesmo default. Ligar `security_invoker` teria fechado o buraco e quebrado o produto: as nove telas que mostram nome e foto de outro usuário ficariam vazias, que é justamente a razão de a view existir.

Uma ressalva de honestidade: o grant amplo, no banco local, vem do dublê reproduzindo o default documentado do Supabase (`00_supabase_bootstrap.sql:394`). Que **produção** ainda o tenha é o que a 0069 afirma em comentário, mas não é o mesmo que ter sido medido lá — ver §6, item 0, que traz a consulta de uma linha para conferir.

**P0-14. O guarda de autorização era desligado por NÃO fazer login.** — `accept_trip_offer`, `increment_driver_period_mileage`, corrigido na `0075_rpc_anon_and_null_uid_guards.sql`

Mesma raiz do P0-13, uma classe de objeto ao lado. Lá era `alter default privileges … grant all on TABLES`; aqui é a linha irmã, `grant all on FUNCTIONS to anon, authenticated`, que dá EXECUTE em toda função nova de `public` a quem não tem sessão. Nenhuma migration jamais revogou.

Isso sozinho não bastaria — as funções conferem quem chama. O problema é **como** duas delas conferiam:

```sql
if auth.uid() is not null and auth.uid() <> p_driver_id then raise ...
```

`auth.uid()` é NULL sem JWT. Para `anon` a primeira condição é falsa, o `and` corta, e a exceção nunca sai. O `is not null` foi escrito para deixar o `service_role` passar — e `service_role` também tem uid nulo. A intenção estava certa; o teste do papel é que estava errado. **O repositório já tem o jeito certo em seis funções** — `apply_driver_split` testa `auth.role() <> 'service_role'` explicitamente. A 0075 alinha as duas retardatárias com a casa.

Dois motoristas com oferta `PENDING` no mesmo pedido, o atacante tentando aceitar no lugar da vítima:

| | resultado |
|---|---|
| como `authenticated` (logado) | 42501 *"só o próprio motorista pode aceitar"* |
| como `anon` — **o mesmo ataque, sem login** | **`ACCEPTED`** |

E o efeito não para no retorno. Estado depois da chamada anônima: a oferta da vítima vira `ACCEPTED`, a do atacante `REVOKED`, `trip_requests.accepted_by` = vítima, e `dispatch_events` grava `ACCEPTED` com `driver_id` = vítima. **A trilha de auditoria registra que a vítima aceitou.** Um motorista fica com corrida atribuída sem ter aceitado, e o banco diz que aceitou; as ofertas de todos os outros morrem no mesmo golpe.

Pela mesma porta, `increment_driver_period_mileage` chamada anonimamente gravou `p1_miles = 999` na ficha de jornada da vítima — o dado que alimenta o controle de horas de direção, que é registro de conformidade TNC.

E mais duas portas que a mesma raiz abria, ambas confirmadas por execução: `ensure_driver_period_transitions_partition(date)` executa **DDL** — três chamadas anônimas criaram três partições com cinco índices cada, e a data é livre; e `resolve_config_bool` é `SECURITY DEFINER` e passa por cima do `is_public = true` da policy de `system_config` — o SELECT direto de `anon` na chave `period_audit_v1_enabled` devolve nada e a RPC devolve o valor, com `background_check_provider = 'mock'` entre as chaves assim expostas.

**Corrigido na 0075** com duas trancas independentes, cada uma provada sozinha: o guarda passa a testar `auth.role()` (barra `anon` **mesmo com** o privilégio devolvido de propósito no teste), e `anon` perde EXECUTE em todas as 22 funções não-gatilho de `public`. Legítimos preservados e asseverados: motorista aceitando por si, `service_role` elegendo vencedor, motorista gravando a própria milhagem. Revogar de `anon` sozinho não basta — o Postgres dá EXECUTE ao pseudopapel `PUBLIC` em toda função nova, e a mensagem das duas asserções diz isso a quem esbarrar nelas.

**Um quarto achado, menor, saiu do mesmo ataque** e virou a `0074_accept_requires_driver.sql`: hoje um passageiro não consegue aceitar corrida alheia, mas **pelo motivo errado**. A policy de UPDATE de `rides` libera `status = 'requesting' and driver_id is null` sem exigir nada de quem atualiza; o que barra é a policy de **SELECT** do pool, que exige `is_driver()` — um UPDATE precisa localizar a linha antes de alterá-la. Verificado nos dois sentidos: o update de Bob afeta 0 linhas; acrescentando **uma** policy permissiva de SELECT em `rides`, o mesmo update passa a afetar 1 e o sequestro acontece. Qualquer tela futura de suporte, histórico ou relatório que amplie a leitura reabriria o aceite à distância, num arquivo que não fala de aceite. A 0074 traz `is_driver()` para dentro da regra de UPDATE; com ela, o mesmo cenário volta a barrar.

### Ainda no ataque ao banco — três achados que não são buraco de segurança

Os quatro P0 acima são portas abertas. Os três abaixo saíram do mesmo ataque e são o contrário: **regras que não fazem nada, ou que fazem menos do que o nome delas promete.** Ficam aqui porque a origem é a mesma — só o ataque os encontra.

**A. As duas policies do despacho v2 se chamam em círculo.** — corrigido na `0076_break_dispatch_policy_recursion.sql`

A 0054 criou `trip_requests_select` consultando `ride_offers`, e `ride_offers_select_own` consultando `trip_requests`. As duas tabelas têm RLS: a subconsulta de uma dispara a policy da outra, que dispara a da primeira. O Postgres detecta o ciclo e **aborta a consulta inteira** — não é "zero linhas", é erro `42P17`. Medido:

| | |
|---|---|
| passageiro dono lê o próprio `trip_request` | `42P17` |
| motorista com oferta lê o `trip_request` | `42P17` |
| motorista lê a **própria** oferta | `42P17` |
| passageiro lê ofertas do próprio pedido | `42P17` |
| `service_role` (dispatch-engine) | 1 linha — a única que passa |

O `service_role` escapa porque a policy dele é `using (true)`, sem subconsulta. Por isso a Edge Function funciona e o app não: os dois lados do motor v2 não estão no mesmo mundo.

**E havia um segundo defeito escondido atrás do primeiro.** A 0054:210 escreveu `where o.trip_request_id = id` — o `id` sem qualificar resolve para o escopo mais interno, `ride_offers.id`. O `pg_policies` mostra o resultado normalizado e é explícito: `o.trip_request_id = o.id`, a oferta comparada consigo mesma, falso sempre. O ramo do motorista é código morto. A policy vizinha, dez linhas abaixo no mesmo arquivo, qualifica certo — o padrão era conhecido, uma das duas escapou. Consertar só a recursão deixaria o motorista sem enxergar a oferta, agora sem nem um erro para acusar.

**Não está aberto hoje**, e vale ser exato sobre por quê: a flag `dispatch_engine_v2` é `false` por padrão (`src/lib/systemConfig.ts:172`) e não há linha dela em `system_config`. O motor v2 nunca foi ligado. **Quando for**, não vai falhar alto: as quatro leituras do app descartam o erro na desestruturação (`const { data: tr } = …`, sem `error`), então `data` vem null e cada caminho segue pelo ramo "não existe pedido" — a eleição atômica do vencedor nunca é chamada (`useRide.ts:1734`), o cancelamento não encerra o pedido e o tick segue distribuindo corrida cancelada (`:836`), e o card da oferta nunca aparece (`:1528`). Três sintomas, nenhuma mensagem, e a causa é uma policy. É o item 2 do §7 — ligar o despacho — esperando para não funcionar.

Corrigido tirando as travessias de dentro das policies e pondo-as em funções `security definer`, que rodam com o privilégio do dono e não reentram na RLS. É o mesmo recurso que a `is_driver()` já usa desde a 0067.

**B. Avaliação não exigia ter estado na corrida.** — corrigido na `0077_ratings_integrity_and_fleet_registry.sql`

A policy conferia `auth.uid() = from_user` e nada mais: garante que ninguém assina em nome de outro, não que houve corrida. Rodado: Bob inseriu nota **1** para um motorista numa corrida em que o motorista nunca esteve, e inseriu nota **5 para si mesmo**. O índice único `(ride_id, from_user)` limita a uma por corrida — mas quem cria corrida é o próprio passageiro, então N corridas, N avaliações contra qualquer motorista.

É o P0-13 outra vez por um caminho **legítimo**: a 0073 fechou a escrita direta em `profiles_public.rating`, e esta porta chega ao mesmo lugar sem violar privilégio nenhum. Sem superestimar o dano de hoje: `profiles.rating` **não é escrito por nada** — nasce `5.0` no cadastro (`AuthContext.tsx:181`) e não há trigger, migration ou Edge Function que o atualize, conferido no repositório inteiro. A estrela que o passageiro vê é uma constante. Quem lê `ratings` de fato é `useUserStats.ts:30`, que agrega o que o próprio usuário recebeu — o motorista vê as notas forjadas na tela dele. E no dia em que a agregação for escrita, ela nasce envenenada na origem.

**C. `vehicles` era `using (true)` para qualquer conta autenticada.** — corrigido na mesma 0077

Um passageiro comum lia `driver_id, model, plate, color, year` de **toda** a frota. Placa é identificador no mundo real, e o `driver_id` costura direto com `profiles_public` (nome, foto, nota): uma conta grátis do Cadastro Expresso baixava o cadastro da frota com placa e cruzava com nome e rosto. Mesma família do P1 nº 3, um degrau acima. Estreitado para o motorista dono, o passageiro que tem (ou teve) corrida com ele, e o admin — os dois únicos leitores do repositório já operam dentro desse escopo.

### Encontrado em produção, por um chamado de cliente

Não saiu de crítico nem de varredura: a passageira ligou dizendo que a corrida **não debitou** e que **não apareceu a opção de gorjeta**. Os dois sintomas tinham causas diferentes, e o primeiro abriu uma cadeia.

**D. Forma de pagamento válida, cobrável, e invisível.** — corrigido em `0078`, `setup-card`, `sync-card`, `stripe-webhook`, `remove-card`, `list-cards` e nas duas `PaymentScreen`

`setup-card` cria a sessão de Checkout em `mode: 'setup'` **sem `payment_method_types`**, então os métodos automáticos da conta se aplicam e o **Link** é oferecido junto do cartão. Quem escolhe Link acaba com um `payment_method` de `type: 'link'` — e todo o resto do sistema lia `pm.card`, que nesse caso é `undefined`:

| onde | o que fazia |
|---|---|
| `stripe-webhook` / `sync-card` | gravava `card_last4: null, card_brand: null` **e salvava o `payment_method_id` assim mesmo** |
| `list-cards` | filtrava `type: 'card'` → devolvia `cards: []`, indistinguível de "não tem forma de pagamento" |
| `PaymentScreen` | renderizava `CARTÃO •••• •••• •••• ` com o fim vazio |
| `charge_unpaid_ride.ts` | dizia *"não consegui ler o cartão"* — para uma chamada que deu **certo** |

A passageira tinha método anexado ao cliente certo, definido como padrão, e a tela dizia que ela não tinha nada. A corrida rodou e concluiu sem cobrar.

**A hipótese inicial estava errada, e a correção veio de um teste.** A primeira leitura foi "Link não é cobrável off-session", e o conserto proposto era restringir o cadastro a `['card']`. Antes de aplicar, a corrida foi cobrada de verdade: `off_session: true` naquele mesmo método `link` **passou** — PaymentIntent `pi_3U6wAOCgSu88OSlV1YssXOqx`, $30,17. Link é cobrável neste projeto; o que faltava nunca foi a cobrança, era a exibição. A restrição foi revertida e o conserto passou a ser tornar o sistema type-aware: `payment_method_type` e `payment_method_label` no perfil (0078), gravados pelos três caminhos que salvam método, `list-cards` sem filtro, e uma regra única de rótulo em `src/lib/paymentMethod.ts` — 26 testes, incluindo o invariante de que a descrição **nunca** devolve texto vazio nem finge cartão sem ter os quatro dígitos.

**E. A gorjeta só existia num instante.** `RateRideScreen` era alcançável por um único caminho — `ActiveRideScreen:343`, no momento em que o status vira `completed` e **só com a tela em foco**. Passageiro com o celular bloqueado no fim da corrida nunca a via, e não havia volta: `TripDetailsScreen` exibia a gorjeta quando existia e não oferecia nenhuma. Perdeu o instante, perdeu a gorjeta — e ela vai 100% ao motorista. Corrigido com gorjeta retroativa a partir do histórico (`src/lib/tip.ts`, 51 testes, 6 de 6 mutantes mortos). A `tip-ride` publicada não precisou de alteração: já autoriza por `passenger_id`, é idempotente e não impõe janela.

**F. O levantamento que o chamado provocou.** Dos 33 perfis com método salvo, **apenas 5 são cobráveis hoje**: 24 apontam para um `payment_method` que **não existe nesta conta Stripe** (`resource_missing` — quase certamente ids de modo de teste sob a chave `rk_live_`) e 4 são Link. E a peneira óbvia não serve: 17 perfis têm `card_brand` preenchido para um método que não é cartão ou nem existe, então **não dá para monitorar isso por SQL** — a coluna está desatualizada e mente.

### P1 — cinco abertos

0. **Não existe caminho, a partir do repositório, para um banco funcionando.** Também descoberto na execução, e é a causa estrutural dos dois P0 acima.

   Os dois caminhos possíveis estão quebrados, cada um do seu jeito. **Pelas migrations:** nenhuma das 71 cria `public.profiles` nem `public.rides` — a 0001 já começa com `alter table public.profiles`. O `npx supabase db push` que o cabeçalho do `schema.sql` recomenda para *"bootstrap de um banco novo"* falha na primeira linha. **Pelo snapshot:** `schema.sql` aborta de propósito, e mesmo com o override que ele próprio documenta para banco descartável ele **não executava** — a view `profiles_public` seleciona `driver_code` (`:251`) e o `create table public.profiles` não declarava a coluna, porque ela só nasce na 0049. O arquivo é um híbrido: tem a coluna `paid` (0003) e a view da 0049, mas não tem `driver_amount` (0006). *Corrigido na origem:* a coluna foi acrescentada ao `create table` (`:89`), com o motivo ao lado dela; antes disso o construtor local a enxertava por remendo, o que fazia o snapshot rodar sem tornar o arquivo correto.

   Consequência prática: não dá para levantar staging, não dá para verificar migration antes de aplicar, e a recuperação de desastre depende do banco de produção existir. Foi exatamente essa lacuna que deixou os P0-11 e P0-12 sem serem vistos por doze críticos.

   **A causa raiz apareceu quando o caminho foi reconstruído, e ela é pior que um arquivo desatualizado: o histórico de migrations não é o histórico do banco.** A prova é a `0007_driver_id_index_qr.sql:6`, que cria um índice em `profiles(driver_code)` — **42 migrations antes** de a `0049:31` criar a coluna. A 0007 rodou em produção; logo a coluna já existia lá naquele momento. Ela não foi criada por migration nenhuma deste repositório: foi criada **à mão**, e o `add column if not exists` da 0049 é a regularização tardia disso. Todo `if not exists` do diretório pode estar escondendo um caso igual, e nenhum deles é detectável lendo o repositório — só reconstruindo o banco do zero, que é o que passou a existir.

   **Estado agora: o caminho existe e é verificado.** `node supabase/localdb/run-migrations.mjs --reset` sai de um banco vazio e chega ao estado atual com **0 falhas**. A corrente é: dublê do Supabase → `schema.sql` com o override → **ajustes de baseline** → 0001 a 0077 → **ataque de comportamento** → **verificação do estado final**.

   Os dois últimos passos existem separados porque provam coisas diferentes, e a diferença entre elas é onde moram os três P0. A `99_verificacao.sql` confere a **forma**: a policy existe, o papel é `authenticated`, a reloption está lá. A `98_rls_comportamento.sql` confere o **efeito**: um usuário de verdade tenta alcançar o dado de outro e precisa falhar. O P0-13 tinha a forma inteira correta.

   Os ajustes de baseline são a ponte entre o snapshot híbrido e a ordem histórica: o `schema.sql` já traz objetos que migrations posteriores criam (a policy da 0002, a tabela `messages` da 0005), então as migrations colidiam com o próprio futuro delas. Cada ajuste é **impresso no relatório com o motivo** a cada execução — inclusive o único que muda o veredito de uma migration: remover a view faz a **0012 aparecer como OK**. Ela continua defeituosa (P0-12); quem conserta produção é a 0072. Um ajuste desses aplicado em silêncio seria a mentira por omissão que esta auditoria existe para não cometer.

   **A verificação final foi testada contra si mesma.** Uma asserção que nunca reprovou não provou nada, então as três foram mutadas uma a uma num banco descartável: view sem `security_invoker` → reprova; policy de `rides` de volta a `{public}` → reprova; view sem colunas de `rides` → reprova; controle sem mutação → passa. Ela deixou de ser decoração e virou regressão automática de P0-11, P0-12 e do defeito que a 0036 consertou.

   **O que ainda falta, e não é pouco:** este caminho constrói um **Postgres**, não um **Supabase**. GoTrue, Storage, `pg_cron` e `pg_net` continuam sendo dublês (o cabeçalho de `00_supabase_bootstrap.sql` lista item por item o que eles não provam). Um staging de verdade é um projeto Supabase de verdade — e é lá que a aplicação da 0072 precisa ser ensaiada antes de produção.

1. **Ganhos do motorista mostram a faixa errada** — `src/screens/driver/EarningsScreen.tsx:85,157`.
   *"Qualquer linha com `driver_amount` NULL renderiza os ganhos de um motorista 85/15 a 80%, e a taxa da plataforma a 20%."* O repasse em si sai certo; quem mente é a tela. Arquivo em edição pelo dono — reportado, não tocado.
2. **Sequestro de QR (conserto definitivo pendente)** — `0069:921-925`, `resolve-driver-code/index.ts:466`.
   *"o QR **impresso** da vítima devolve o `id` do atacante"*, e o app trava a corrida — e entrega a origem do passageiro — nele. Um paliativo foi aplicado (exigir `verification_status = 'approved'` na transição). O conserto que o crítico pediu, gerar o código no servidor, muda o formato de QR que já está impresso e em campo: **decisão do dono**.
3. **`profiles_public` é listável por conta grátis** — `0069:88-103`.
   *"Qualquer conta expressa … baixa o diretório inteiro — que é a pré-condição do P1 acima e é literalmente 'enumerar usuários'."* Nove telas dependem da view; fechá-la é uma refatoração de escopo próprio.
4. **ETA velha apresentada como fresca** — `ActiveRideScreen.tsx:255-275`.
   *"Se a query volta 200 com telemetria de 6 minutos atrás … a tela mostra 'chega às 14:32' com a confiança total, sem '~'. É o caso de campo mais comum de dado velho."* Exige uma migration nova (`driver_telemetry_at`) — **precisa da sua aprovação**.

### P2 — três abertos

5. **Gorjeta trancada no primeiro valor tentado** — `tip-ride/index.ts:112-122`.
   *"primeira tentativa recusada off-session, passageiro tenta outro valor, e leva um texto de engenharia da Stripe em inglês"*; e órfão de gorjeta (Stripe OK, banco falhou) sem reparador. Arquivo protegido.
6. **Coerção silenciosa de faixa nula** — `src/lib/split.ts:78-82`. Arquivo protegido; o crítico não escreveu desfecho de produção para este.
7. **Tela de QR em branco** — `QRCodeScreen.tsx:133-146`: *"deixa a área do QR em branco, sem texto nem botão"*. Bloqueado por `translations.ts` estar sob edição do dono.

### P3 — três abertos

8. **Estorno sem UPDATE deixa corrida ativa e já estornada** — `useRide.ts:778-803`: *"motorista a caminho, `paid = false`. Se o passageiro fechar o app, ninguém repara."* Depende de uma política que só você pode definir.
9. **Janela de intercalação no varredor do despacho** — `0054:182` × `dispatch-engine/index.ts:268,310`: *"A janela é do tamanho do commit (fsync), não zero."* Aceito como risco residual.
10. Resíduos de UI: switch de contatos confiáveis que *"pula e volta"* sem explicação; mensagem de chat que falha e é *"descartada em silêncio"*.

### Fechado nesta rodada

11. **Rotação do token de sessão sem cobertura** — era P3: a troca do token *depois* do `resolvePlace` mora em `RequestRideScreen.tsx`, e se quebrasse nada falharia — só a fatura da Google subiria, porque ela volta a cobrar por requisição. **Coberto** por `src/screens/passenger/__tests__/placeSessionRotation.test.tsx` (6 testes), que monta a tela de verdade e exercita as teclas, o toque na sugestão e a falha de resolução.

   Vale registrar o que o próprio teste encontrou: a suíte foi escrita com 5 testes, e o mutante que faz `escolherSugestao` usar sempre `destSessionRef` **sobreviveu** a todos os cinco. O teste de independência só olhava as BUSCAS, então não enxergava a escolha fechando a sessão errada — erro que custa duas vezes (as buscas do embarque ficam sem `details` e viram avulso, e a sessão do destino é queimada no meio da digitação). O 6º teste foi escrito para esse mutante e o mata.

   Quatro mutantes, cada um com controle não-mutado antes e restauração byte a byte (`diff` limpo) depois: rotação removida → morre 1 teste; rotação antes do retorno de falha → morre 1; ref única para os dois campos → morre 1 (o 6º); token novo a cada tecla → morrem 3.

### Rejeitado de propósito

- **`cancel` sem guarda de status** (`dispatch-engine/index.ts:498`, P3): a guarda proposta quebraria o cancelamento legítimo de corrida já aceita. Recusado com justificativa.

---

## 5. Métricas

### Medido

| Métrica | Valor | Como |
|---|---|---|
| Type-check | `npx tsc --noEmit` sai **0** | rodado |
| Suíte de testes | **67 suítes, 996 testes, tudo verde** | rodado |
| Testes acrescentados no item 6 | **+31** sobre a linha de base de 906 | contado |
| Testes da sessão do autocomplete | **+16** na biblioteca, **+6** na tela | contado |
| Testes da instrumentação de campo | **+37** (17 na costura, 6 na fiação do Places, 9 no `useRoute`, 5 no `useLocation`) | contado |
| Mutantes mortos com controle não-mutado | **41** | rodados um a um |
| Mutantes que SOBREVIVERAM e forçaram teste novo | **2** (ref de sessão em `escolherSugestao`; limpeza do cronômetro de GPS em `useLocation`) | rodados |
| Type-check da Edge Function `places-search` | `deno check` sai **0** | rodado |
| **SQL executado num Postgres de verdade** | banco vazio → estado atual, **77 de 77 migrations, 0 falhas**, com verificação final | rodado em PG 17.10 local |
| **RLS e RPCs atacadas, não conferidas** | **18 ataques barrados, 9 acessos legítimos preservados**; 17 de 18 mutantes mortos com controle não-mutado (o sobrevivente é invariante de forma, coberto pela `99`) | rodado (`98_rls_comportamento.sql`) |

**Isto mudou desde a primeira versão do relatório.** Onde antes se lia *"0% do SQL das migrations 0064–0071 jamais executou"*, agora existe um Postgres 17.10 local (`supabase/localdb/`, sem Docker e sem sudo) e o SQL foi executado. As oito que nunca tinham rodado — 0064 a 0071 — **aplicam todas**, depois do conserto de P0-11; a 0072, escrita para P0-12, também.

E a corrente inteira passou a fechar: `--reset` sai de um banco vazio e chega ao estado atual com **0 falhas**, terminando numa verificação que assevera o estado final e que foi testada por mutação (P1 nº 0). As colisões que restavam — 0002 e 0005 com `policy … already exists`, e a 0012 com `cannot change name of view column` — eram todas herança do snapshot híbrido, e estão tratadas em ajustes de baseline declarados e impressos a cada execução.

Continua valendo o rótulo de dublê: `supabase/localdb/00_supabase_bootstrap.sql` recria `auth`, `storage`, `cron`, `net` e `vault` porque um Postgres puro não tem nada disso. O cabeçalho daquele arquivo lista o que o dublê **não** prova, e o mais importante é: nada aqui diz qual `pg_cron` está instalado em produção, nem se o job dispara, nem se o segredo existe no Vault. O dublê valida `'10 seconds'` contra a gramática documentada do pg_cron 1.5+ **de propósito**, para não fabricar a resposta que a §6 marca como pendente.

O type-check **não** cobre `supabase/functions` nem `supabase/scripts` — estão excluídos no `tsconfig.json`. Um `npx tsc --noEmit` limpo não diz nada sobre as edge functions; o verificador real delas é `deno check`, e hoje 15 funções da Stripe falham nele com TS2322 em `apiVersion` (pré-existente).

### NÃO MEDIDO — e o que cada um exige

Nenhum critério de desempenho do briefing foi medido. Nada aqui é estimativa.

O que mudou nesta rodada: **existe instrumentação onde antes não havia nenhuma**. `src/lib/fieldMetrics.ts` é a costura única de medição — sink plugável, contexto passando por `scrubPII`, relógio monotônico. Instrumentar **não é medir**: o módulo não estima, não interpola e não preenche lacuna. Sem aparelho rodando o app, `recentSamples()` volta vazio, e vazio é a resposta correta. Todos os critérios abaixo seguem **NÃO MEDIDO**; o que se ganhou foi que, quando alguém pegar um telefone, o número sai sozinho em vez de exigir um dia de encanamento.

**Exige device real — já instrumentado, faltando a sessão com aparelho:**

- **Partida a frio (< 2,5 s).** A amostra `js_bootstrap_to_interactive` vai do primeiro módulo JS avaliado (`index.ts`) até a splash sair (`AppNavigator`). É um **piso, nunca a resposta**: falta tudo antes do JS existir — spawn do processo, init nativo, carga do bundle no Hermes. Esse pedaço é invisível do JS e só sai de medição nativa: `adb shell am start -W` no Android, os_signpost no iOS. A régua de 2,5 s se aplica ao TOTAL. Por isso a métrica **não** se chama `cold_start`.
- **Latência do autocomplete (< 300 ms).** `autocomplete_round_trip` cronometra a ida e volta completa, com a queda no Nominatim inclusa — quem digitou esperou as duas idas, então a amostra sai como uma espera só. O cronômetro abre **depois** do corte de 3 caracteres, para não encher a série de zeros que fariam a régua parecer folgada. `place_details_round_trip` é separada, porque o *details* é outra cobrança e outra espera. Sobre o debounce: era **450 ms** e sozinho estourava a régua, tornando o critério inalcançável por construção; baixado para **150 ms**, com a digitação migrada do Places *Text Search* (cobrado por requisição) para *Autocomplete + Details* com `sessionToken` (cobrado por sessão). Isso removeu o bloqueio do lado do cliente; o resto do orçamento é rede, e continua sem número.
- **Tempo de reroute (< 3 s).** **Não existe métrica `reroute_compute`**, e isso é deliberado: não existe caminho de código separado. Sair da rota mexe na ORIGEM (`DriverNavigateScreen` chama `setRouteOrigin`) e cai no mesmo efeito de `useRoute`. A leitura é filtrar `route_compute` por `trigger === 'origin_change'` durante navegação ativa. Um nome de métrica que nunca dispara é instrumentação morta que mente por omissão.
- **Latência de rastreamento (< 2 s, sem salto de marcador).** `location_fix_interval` mede a **cadência com que o SO entrega posição ao app** — não é a latência ponta a ponta que a régua cobra. Falta tudo depois do fix: publicação, realtime do Supabase e render no aparelho do passageiro. Pior: o piso é configuração, não física — com `timeInterval: 5000`, um carro parado entrega um fix a cada 5 s por definição. Esta amostra sozinha **não** decide o critério.

**Exige device real — sem instrumentação, e o motivo:**

- **Bateria por hora (regressão > 15% reprova).** Existe a costura (`setBatteryProvider`), não existe leitura: o app **não tem `expo-battery`**, e acrescentar um módulo nativo obriga a um build novo de um app que já está na faixa de teste interna da Play Store. Sem provider plugado, `sampleBattery()` não registra nada — ausência de amostra, não um zero inventado. **É uma decisão sua** (ver §6).
- **fps do mapa.** Nada foi instrumentado de propósito. Um contador de `requestAnimationFrame` mede o **thread JS**, não o thread de UI que desenha o mapa — daria um número bonito e errado, que é pior do que nenhum. Exige ferramenta nativa (Perfetto/Systrace no Android, Instruments no iOS).

**Exige device real — sem instrumentação possível daqui:** latência do SOS; ciclo completo com app em segundo plano e ligação telefônica; corrida sobrevivendo ao *kill* dos dois lados; comportamento com perda de GPS e de dados por até 3 min.

Em produção **não há destino** para as amostras: elas ficam em memória (últimas 200) até alguém plugar um sink. Em dev, `consoleMetricsSink` está ligado em `App.tsx` e as linhas saem no `expo start`.

**Exige Postgres:** **0% do SQL das migrations 0064–0071 jamais executou.** Nenhuma constraint, trigger, política de RLS ou agendamento de cron foi verificado contra um banco. Também pendente: se a extensão `pg_cron` instalada aceita a cadência `'10 seconds'`, e se o segredo `service_role_key` existe no Vault — sem os dois, o tick do despacho não roda, e nada no repositório consegue detectar isso.

**Exige Stripe em modo de teste:** a reconciliação de 100 corridas (§3), o TTL de 24 h da chave de idempotência, a ordem real de entrega e re-entrega de webhooks, e o comportamento de `transfers.create` com `source_transaction` de uma cobrança já estornada.

**Exige o console do Supabase / Google Cloud:** se *Private channels* do Realtime está ligado (se estiver, o P0 do broadcast de chat cai para P2); se as chaves `EXPO_PUBLIC_GOOGLE_MAPS_*` estão restritas.

**Contraste WCAG:** todos os números citados nos pareceres foram calculados a partir dos hex, **não medidos em tela**.

---

## 6. Decisões que dependem de você

Nenhuma destas é técnica; todas travam trabalho.

0. **Aplicar os consertos de P0-11, P0-12, P0-13 e P0-14 em produção.** Escritos e verificados contra o Postgres local (§4): seção C.2 dentro da 0067, e as migrations novas `0072_rebuild_rides_with_locations.sql`, `0073_lock_view_write_privileges.sql`, `0074_accept_requires_driver.sql`, `0075_rpc_anon_and_null_uid_guards.sql`, `0076_break_dispatch_policy_recursion.sql` e `0077_ratings_integrity_and_fleet_registry.sql`. O que falta é decisão sua, e é de operação, não de código: **é DDL em produção**. A 0072 derruba e recria a view — se existir em produção um dependente que este repositório não conhece, ela falha e reverte, de propósito, em vez de destruí-lo com `cascade`. Tudo isso já roda de ponta a ponta no build local, do banco vazio ao estado final (P1 nº 0) — mas aquilo é um Postgres com dublês, não um Supabase. O ensaio que falta é num projeto Supabase de verdade.

   **A 0073 e a 0075 têm urgência diferente das outras**, e vale separar: P0-11 e P0-12 são defeitos de *não funcionar*; P0-13 e P0-14 são defeitos de *estar aberto agora*. Enquanto não forem aplicados, qualquer conta logada apaga contas novas e rebaixa a nota de qualquer motorista, e qualquer chamador **sem login** aceita corrida em nome de um motorista — os dois pelo endpoint público do PostgREST.

   Antes de aplicar, uma consulta de uma linha no SQL Editor responde se produção está mesmo exposta — e ela **não** altera nada:

   ```sql
   select table_name, grantee, privilege_type
     from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name in ('profiles_public', 'rides_with_locations')
      and grantee in ('anon', 'authenticated')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE');
   ```

   Zero linhas: produção nunca teve o default privilege amplo e o P0-13 é só do banco local — me diga, que eu rebaixo o achado no relatório. Qualquer linha: está aberto, e a 0073 é o fechamento.

1. **Liberar `src/i18n/translations.ts`** — está em edição sua. Trava o P2 nº 7 e seis pendências de reuso de chave — a mais recente é o erro do autocomplete, que reusa `payment.genericError` numa tela de corrida por não poder criar chave nova.
2. **Aprovar a migration de timestamp de telemetria** (`driver_telemetry_at`) — trava o P1 nº 4.
3. **QR já impresso**: gerar o código no servidor conserta o P1 nº 2 de vez, mas invalida os adesivos em campo. Paliativo aplicado enquanto isso.
4. **Política para corrida ativa e já estornada** (P3 nº 8): cancela sozinha? mantém e cobra de novo? avisa quem?
5. **Habilitar "Places API (New)" no projeto goxl-2026 e republicar `places-search`.** O autocomplete novo depende dela; a "Places API" legada que já está ligada não serve para `places:autocomplete`. Sem isso o app não quebra — cai no Nominatim —, mas as sugestões pioram e ninguém é avisado.
6. **`run-weekly-payouts` e `admin-telematics-export` estão publicados com `--no-verify-jwt`?** Não dá para descobrir daqui, e a resposta muda a severidade da autorização dessas funções.
7. **A edge do Supabase sobrescreve ou repassa `X-Real-IP` / `cf-connecting-ip`?** Idem, para o rate limit.
8. **Arquivos seus, intocados por decisão:** `run-weekly-payouts`, `request-payout`, `tip-ride`, `_shared/tipPayout.ts`, `0064`, `usePayouts.ts`, `useRideHistory.ts`, `EarningsScreen.tsx`, `translations.ts`, `cobrar.sh`, `split.ts`.

### Fora do escopo dos agentes — pendência humana

Conformidade TNC e regulatória da Flórida, seguro, contrato do motorista e política de privacidade. Onde o produto encosta nisso e ninguém decidiu: a expectativa de 911/PSAP no botão de emergência; a regra da taxa do MCO (é uma por viagem? `airportFees.ts:91-97` pode cobrar em dobro); e a zona designada de embarque em MCO e resorts.

---

## 7. O caminho mais curto para poder cobrar de verdade

Em ordem, porque cada um destrava o seguinte:

1. ~~Subir um Postgres local e rodar as migrations 0064–0071.~~ ~~Reconstruir um bootstrap reproduzível.~~ ~~Atacar a RLS com um usuário de verdade.~~ **Feitos.** Banco vazio → estado atual, 77 de 77, 0 falhas, com verificação final e ataque de comportamento, ambos testados por mutação. Os nove defeitos que o caminho revelou — P0-11 a P0-14, a recursão entre policies do despacho, a avaliação sem corrida, o registro da frota aberto, o aceite guardado pela regra errada e o drift do `driver_code` — estão corrigidos ou documentados no repositório. O que sobrou é **aplicar em produção** (§6, item 0), e antes disso um staging Supabase de verdade: o que existe hoje constrói um Postgres, não um Supabase.
2. Provisionar `service_role_key` no Vault e confirmar que o `pg_cron` instalado aceita `'10 seconds'`. Sem isso o despacho não acontece, e nenhum teste do repositório enxerga a falha. **E aplicar a 0076 antes de ligar a flag `dispatch_engine_v2`**: sem ela o motor v2 não funciona de jeito nenhum, e falha em silêncio nos três caminhos (§4, achado A).
3. Rodar a reconciliação de 100 corridas contra a Stripe em modo de teste, com o valor esperado calculado fora do `calculateSplit`.
4. Rodar o app num aparelho e colher a linha de base das métricas de campo, antes de qualquer otimização — sem linha de base, "regressão de 15%" não tem contra o que ser medida. O lado do código já está feito (§5): resta plugar um sink que persista as amostras, dirigir uma corrida de verdade e complementar com o que o JS não alcança — `adb shell am start -W` para a perna nativa da partida, ferramenta nativa para fps do mapa, e uma decisão sua sobre `expo-battery`, sem o qual bateria continua com zero amostras.
5. Só então re-auditar os módulos 4, 7 e 8, que são os que o briefing proíbe fechar com mock.
