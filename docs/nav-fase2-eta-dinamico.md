# Navegação — Fase 2: ETA dinâmico (Bug B3)

Antes, o ETA só mudava quando a rota era recomputada, e a rota só era
recomputada quando o motorista andava **> 150 m**. Parado no trânsito, o número
**congelava** — o passageiro via "7 min" por vários minutos. Estilo Uber/Waze, o
ETA agora **decresce com o tempo real** entre recálculos e só "respira" de volta
quando uma nova rota (com trânsito atualizado) chega.

## Como funciona

```
useRoute(origin, dest, refreshKey)     ← refreshKey avança a cada 45 s
   └─ Google Directions / OSRM          (ETA com trânsito no recálculo)
        └─ routeEtaMin (minutos)
             └─ useDynamicEta(routeEtaMin, { stopped })
                  └─ etaTracker (puro): baseline + projeção por segundo
                       • andando → baseline − tempo decorrido
                       • parado  → congela (não vai a zero sem andar)
                       • nova rota → nova baseline (ETA "respira")
```

### Cadência
- **45 s**: `routeRefreshKey` incrementa e força um recálculo da rota (novo ETA
  com trânsito), mesmo sem o carro andar > 150 m.
- **Imediato no reroute**: o desvio de rota já dispara `setRouteOrigin` +
  `requestServerRoute` (Bloco 3), o que muda a origem e recalcula na hora.
- **1 s**: `useDynamicEta` reprojeta o número exibido (decremento suave).

### Congelamento parado (`stopped`)
`stopped = (location.speed ?? 0) < 1` (m/s). Enquanto parado, o ETA não
decrementa "de graça" — evita o número ir a zero com o carro imóvel no trânsito.

## Paridade motorista × passageiro

O motorista **grava o ETA dinâmico** (projetado) em `rides.driver_eta_min`
(antes gravava o ETA cru da rota). O passageiro lê essa coluna → vê o **mesmo
número** que decresce/congela na tela do motorista. A cadência de escrita
continua baixa porque só grava quando o **minuto** muda (`etaChanged`, ≈1×/min)
ou o carro anda ≥ 30 m.

Sob a flag `shared_route_v1`, o ETA do passageiro vem de `route_eta_min` (rota
única do servidor), atualizado a cada `route_version`.

## Arquivos

| Arquivo | Papel |
|---|---|
| `src/lib/nav/etaTracker.ts` | Núcleo **puro**: baseline + projeção + congelamento parado + horário de chegada. |
| `src/lib/nav/__tests__/etaTracker.test.ts` | 12 testes (decremento, congelamento, clock skew, minutos, chegada). |
| `src/hooks/useDynamicEta.ts` | Hook: reancorar baseline a cada nova rota + tick de 1 s. |
| `src/hooks/useRoute.ts` | Novo parâmetro `refreshKey` → recálculo periódico (45 s). |
| `src/screens/driver/DriverNavigateScreen.tsx` | Cadência 45 s + `useDynamicEta` + grava ETA dinâmico + horário de chegada no badge. |

## Exibição

O badge de ETA do motorista mostra **minutos + horário de chegada previsto**
(`agora + ETA restante`). A distância continua vindo de `path.distanceKm`.

## Validação

```bash
cd /Users/mamute99/go-xl
npx tsc --noEmit -p .
npx jest --config package.json src/lib/nav
```
