# Navegação — Fase 4: map-matching robusto (Feature F3)

O snap ingênuo (`nearestPointOnPath` global) escolhe sempre o ponto
geometricamente mais próximo em TODA a polyline. Isso quebra em três casos que
aparecem na cena de referência (I-4 × Conroy Rd / Millenia, Orlando):

1. **Salto para trás** em rotas que voltam (alça de retorno na I-4): o ponto mais
   próximo pode cair num trecho já percorrido.
2. **Via errada** entre paralelas próximas (rodovia + marginal): só a distância
   não distingue as duas.
3. **Falso "fora da rota"** por um único fix ruim de GPS.

## Núcleo puro — `src/lib/nav/mapMatch.ts`

Determinístico (estado + `dt`/rumo por parâmetro), testável sem GPS.

| Peça | O que faz |
|---|---|
| `isPlausibleStep(prev, next, dtSec, max=60)` | Anti-teletransporte: rejeita passo cuja velocidade implícita passa de `MAX_PLAUSIBLE_SPEED_MPS` (60 m/s ≈ 216 km/h); `dt ≤ 0` (fix fora de ordem) → implausível; sem `prev` → plausível. |
| `matchToRoute(point, headingDeg, path, state)` | Casa o fix na rota partindo de `state.index`. |

Dentro de `matchToRoute`:

- **Janela monotônica**: só considera segmentos de `state.index` até
  `index + MATCH_WINDOW` (12). O índice nunca regride na mesma rota → mata o
  salto para trás (1).
- **Score composto**: `distanceM + headingErr * HEADING_WEIGHT_M_PER_DEG` (0.5
  m/grau). O rumo do curso desempata vias paralelas (2). Sem `headingDeg` → só
  distância.
- **Histerese por contagem**: `offRoute` só é `true` após `OFF_ROUTE_N` (4) fixes
  consecutivos além de `OFF_ROUTE_DIST_M` (40 m); um único fix bom zera o
  contador (3).
- **Confiança** [0,1]: cai com a distância ao corredor e com o desacordo de rumo.

## Flag e fiação

`nav_map_match_v2` (default **OFF**). No `DriverNavigateScreen`, o efeito de snap
ramifica:

```
flag ON  → matchToRoute(here, location.heading, lite, matchStateRef.current)
             → splitPathAtSnap(lite, {index, snapped})   (percorrido/restante)
             → reroute quando m.offRoute (histerese de contagem)
flag OFF → nearestPointOnPath + updateOffRoute            (legado, histerese temporal)
```

O `matchStateRef` (índice monotônico) é resetado quando a polyline ativa muda
(nova fase / reroute) — senão o índice apontaria para um vértice inexistente na
nova rota.

## Arquivos

| Arquivo | Papel |
|---|---|
| `src/lib/nav/mapMatch.ts` | Núcleo puro (novo). |
| `src/lib/nav/__tests__/mapMatch.test.ts` | 12 casos (anti-teletransporte, monotonia, score por rumo, histerese). |
| `src/lib/nav/geo.ts` | `projectOnSegment` agora exportado (reuso). |
| `src/lib/systemConfig.ts` | Flag `nav_map_match_v2` (default OFF). |
| `src/screens/driver/DriverNavigateScreen.tsx` | Ramo do snap sob a flag. |

## Validação

```bash
cd /Users/mamute99/go-xl
npx tsc --noEmit -p .
npx jest --config package.json src/lib/nav
```

## Pendências (fases seguintes)

- `isPlausibleStep` existe como utilitário mas ainda **não** está fiado no
  pipeline de GPS ao vivo (`useDriverLocation`) — entra na Fase 5 (F4), junto com
  a interpolação/dead reckoning, para não tocar no pipeline de localização agora.
