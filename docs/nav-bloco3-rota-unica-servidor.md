# Go XL — Bloco 3 (paridade Uber): ROTA ÚNICA no servidor

Faz o **servidor** ser a **única fonte da rota** de uma corrida. Uma Edge Function
(`compute-route`, proxy do mesmo OSRM que o cliente já usava) calcula a geometria,
o ETA e a distância, grava tudo na linha da corrida como **polyline codificada** +
um contador de versão (`route_version`) monotônico. **Motorista e passageiro leem
as mesmas colunas → veem exatamente a mesma rota e o mesmo ETA.** Em reroute o
servidor recomputa e **incrementa** `route_version`.

## O gap

- Hoje **cada lado calcula a própria rota** no cliente (motorista e passageiro
  chamam OSRM independentemente em `src/lib/routing.ts`). Resultado: linhas e ETAs
  podem **divergir** entre as duas telas (timings de fetch, arredondamentos,
  posições ligeiramente diferentes).
- Uber tem **uma** rota canônica: o servidor decide, os dois apps só desenham.
  Em desvio (off-route), o servidor recomputa e ambos os apps trocam de linha
  ao mesmo tempo.

## Arquitetura (nenhuma tabela nova, nenhum canal novo)

```
                    ┌──────────────────────────────┐
  MOTORISTA         │  Edge Function compute-route │
  (dono da corrida) │  = proxy do OSRM (mesma       │
       │  invoke    │    engine de hoje)            │
       ├───────────►│  1. valida: caller == driver  │
       │            │  2. start = driver_lat/lng    │
       │            │     target = origem (pickup)  │
       │            │            / destino (dropoff)│
       │            │  3. OSRM geometries=polyline  │
       │            │  4. RPC commit_ride_route ────┼──► rides.route_polyline
       │            └──────────────────────────────┘        route_version++ (atômico)
       │                                                     route_eta_min / _distance_km
       │                                                              │
       │  realtime `rides` (canal já existente) + polling 4s          │
       ▼                                                              ▼
  ambos os apps leem route_polyline / route_eta_min / route_distance_km
  → mesma linha, mesmo ETA
```

- **Quem dispara:** só o **motorista** (a Edge Function valida `driver_id`). Ele
  chama nos pontos-chave: mudança de fase (pickup→dropoff) e **off-route**
  (reaproveita a detecção que já existe, `updateOffRoute`).
- **Quem lê:** os dois. O passageiro **não** dispara nada — só consome as colunas.
- **Propagação:** o realtime de `rides` (já publicado) + o polling de telemetria
  de 4s do passageiro já trazem as novas colunas. **Reconexão** re-busca o estado
  automaticamente (o polling roda de novo ao focar/religar).

## Núcleo puro (`src/lib/nav/sharedRoute.ts`)

Codec e regras **sem React nem rede**, testáveis em unidade (14 testes):

- `encodePolyline` / `decodePolyline` — **Google Encoded Polyline, precisão 5
  (1e5)**. É o mesmo formato que o OSRM devolve nativamente via
  `geometries=polyline`, então o servidor grava a string **como veio** e o cliente
  decodifica com o codec casado. Inversos exatos (testado com a polyline canônica
  do Google).
- `parseSharedRoute(row)` → `SharedRoute | null`. Devolve `null` se não houver
  linha, versão ou polyline (ou se decodificar vazio) → a tela cai no legado.
  **O destino é derivado do último ponto da polyline** (`coordinates[last]`), não
  de colunas separadas — assim a rota é sempre coerente com a **fase** (na fase
  pickup a polyline termina no embarque; na dropoff, no destino).
- `isNewerRoute(incoming, current)` — versão nula ⇒ aceita; senão só se
  `incoming > current` (monotônico).
- `isOffRoute` / `rerouteThrottleElapsed` + `DEFAULT_SHARED_ROUTE`
  (`offRouteMeters: 40`, `minRerouteIntervalMs: 8000`) — parâmetros de reroute.
- `polylineLengthMeters` — comprimento geodésico da linha.

## Servidor

### Migration `supabase/migrations/0061_shared_route_bloco3.sql`

Adiciona à tabela `rides` (reaproveita realtime já publicado):

| Coluna | Tipo | Papel |
|--------|------|-------|
| `route_polyline` | `text` | geometria (encoded polyline, precisão 5) |
| `route_version` | `integer not null default 0` | contador monotônico (reroute ⇒ +1) |
| `route_eta_min` | `integer` | ETA único (min) |
| `route_distance_km` | `double precision` | distância (km) |
| `route_updated_at` | `timestamptz` | quando recomputou |

RPC atômico `commit_ride_route(p_ride_id, p_polyline, p_eta_min, p_distance_km)`
→ grava tudo **e** `route_version = route_version + 1` numa só instrução (evita
corrida de leitura-escrita) e devolve a nova versão. `security definer`,
`revoke ... from public, anon, authenticated` (só a Edge Function via
`service_role` chama).

### Edge Function `supabase/functions/compute-route/index.ts`

`POST { rideId }` + JWT do motorista. Valida caller == `ride.driver_id` e status
em `['accepted','driver_en_route','in_progress']`. `start` = posição atual do
motorista (`driver_lat/lng`, fallback embarque); `target` = embarque (pickup) ou
destino (`in_progress`). Chama
`${OSRM_BASE}/route/v1/driving/{start};{target}?overview=full&geometries=polyline`
e grava via `commit_ride_route`. Devolve `{ version, etaMin, distanceKm }`.
`OSRM_BASE_URL` é env (default: OSRM público — mesma engine de hoje).

### Ponte cliente `src/lib/nav/sharedRouteClient.ts`

`requestServerRoute(rideId)` chama `supabase.functions.invoke('compute-route', …)`.
**Best-effort**: qualquer falha (rede/permissão/sem rota) é engolida e logada,
devolve `null` → a tela do motorista cai no legado (calcula a própria rota) sem
quebrar a corrida. Não entra nos testes unitários (fala com a rede).

## Wiring

### Motorista (`src/screens/driver/DriverNavigateScreen.tsx`)

- Flag `shared_route_v1` + `sharedRouteRef` (para uso dentro de callbacks estáveis).
- Efeito que dispara `requestServerRoute(ride.id)` na mudança de fase/status
  (accepted / driver_en_route / in_progress) quando a flag está ligada.
- No ramo de **off-route** já existente (`if (r.reroute)`): também chama
  `requestServerRoute(ride.id)` → servidor recomputa e incrementa `route_version`.

### Passageiro (`src/screens/passenger/ActiveRideScreen.tsx`)

- Adiciona `route_polyline,route_version,route_eta_min,route_distance_km` ao
  `select` do polling de telemetria (4s) → colunas sempre frescas.
- `serverRoute = parseSharedRoute(ride)` (só sob a flag). Quando presente:
  - `activePolyline` = a polyline do servidor (mesma linha do motorista);
  - `smoothRoute` do `<SmoothMarker>` (Bloco 2) segue **essa** linha;
  - `etaMin`/`etaKm` vêm de `route_eta_min`/`route_distance_km` (ETA único).
- **Fallback:** flag OFF ou `serverRoute == null` (antes da 1ª gravação) → mantém
  as rotas calculadas no cliente e o ETA da telemetria do motorista (legado).

## Feature flag

`src/lib/systemConfig.ts` → `CONFIG_DEFAULTS`:

```
shared_route_v1: false   // DESLIGADA por padrão
```

- **OFF (padrão):** cada lado calcula a própria rota (comportamento de produção
  atual). Motorista não chama a Edge Function; passageiro ignora as colunas.
- **ON:** servidor vira a fonte única. Habilitar por jurisdição após QA. Rollback
  instantâneo sem redeploy (config dinâmica) — as colunas ficam gravadas mas são
  ignoradas com a flag OFF.

## Parâmetros configuráveis

| Parâmetro | Onde | Default | O quê |
|-----------|------|---------|-------|
| `shared_route_v1` | `systemConfig.ts` | `false` | liga/desliga o Bloco 3 |
| `OSRM_BASE_URL` | env da Edge Function | OSRM público | engine de roteamento (autohospedar depois) |
| `offRouteMeters` | `DEFAULT_SHARED_ROUTE` | `40` | desvio (m) que caracteriza off-route |
| `minRerouteIntervalMs` | `DEFAULT_SHARED_ROUTE` | `8000` | intervalo mínimo entre reroutes |

## Arquivos

| Arquivo | Mudança |
|---------|---------|
| `src/lib/nav/sharedRoute.ts` | **novo** — codec + regras puras. |
| `src/lib/nav/__tests__/sharedRoute.test.ts` | **novo** — 14 testes. |
| `src/lib/nav/sharedRouteClient.ts` | **novo** — ponte impura `requestServerRoute`. |
| `supabase/migrations/0061_shared_route_bloco3.sql` | **novo** — colunas + RPC atômico. |
| `supabase/functions/compute-route/index.ts` | **novo** — Edge Function (proxy OSRM). |
| `src/types/index.ts` | campos `route_*` no tipo `Ride`. |
| `src/lib/systemConfig.ts` | flag `shared_route_v1: false`. |
| `src/screens/driver/DriverNavigateScreen.tsx` | dispara rota do servidor (fase + off-route). |
| `src/screens/passenger/ActiveRideScreen.tsx` | consome rota/ETA do servidor sob flag. |

## Como validar localmente

```
npx jest --config package.json src/lib/nav/__tests__
npx tsc --noEmit -p .
```

Resultado atual: **125 passed** (suíte `nav` completa, 14 em `sharedRoute`) ·
`tsc` EXIT 0.

## Deploy (fazer no lote consolidado — NÃO disparado ainda)

```
npx supabase db push                          # aplica a migration 0061
npx supabase functions deploy compute-route   # publica a Edge Function
```

A `compute-route` usa JWT (não precisa de entrada em `config.toml`). Depois do
deploy, ligar `shared_route_v1` só na jurisdição de teste.

## Roteiro de teste manual (dois iPhones físicos)

Pré-condição: migration 0061 aplicada + `compute-route` publicada +
`shared_route_v1 = true` na jurisdição de teste. Um aparelho no app do motorista
(corrida aceita), outro no app do passageiro (mesma corrida).

1. **Rota idêntica:** ao aceitar, as duas telas desenham **a mesma** linha
   motorista→embarque e mostram o **mesmo** ETA/distância.
2. **Posição ao vivo:** o carro do motorista anda suave nas duas telas
   (SmoothMarker do Bloco 2 seguindo a polyline do servidor), com atraso de ~2–4s
   no passageiro (realtime + polling).
3. **Reroute:** desviar da rota (sair da linha > 40 m). O servidor recomputa; as
   duas telas **trocam de linha juntas** e `route_version` incrementa.
4. **Mudança de fase:** ao iniciar a corrida (pickup→dropoff), a rota passa a
   apontar para o **destino** nas duas telas, com novo ETA único.
5. **ETA único:** o número de minutos é **o mesmo** nos dois aparelhos (vem de
   `route_eta_min`), não mais dois cálculos independentes.
6. **Reconexão:** matar/reabrir o app do passageiro → ele re-busca o estado e
   volta a mostrar a rota/ETA correntes (polling re-executa ao focar).
7. **Rollback:** `shared_route_v1 = false` → cada lado volta a calcular a própria
   rota (legado), sem redeploy.

## Riscos e rollback

- **Degradação segura:** `requestServerRoute` é best-effort (falha ⇒ `null` ⇒
  legado). Se a Edge Function/OSRM cair, a corrida **não quebra** — o motorista
  calcula a rota localmente como hoje.
- **Sem canal novo:** reaproveita o realtime de `rides` já publicado e o polling
  de 4s do passageiro. Nenhuma tabela nova, nenhuma subscription nova.
- **Atomicidade:** o incremento de `route_version` é uma única instrução SQL
  (`commit_ride_route`), sem corrida de leitura-escrita.
- **Fase-coerente:** o destino da rota é o último ponto da polyline, então nunca
  mostra o destino final durante a fase de embarque.
- **Rollback instantâneo:** desligar a flag ignora as colunas gravadas sem
  redeploy.
