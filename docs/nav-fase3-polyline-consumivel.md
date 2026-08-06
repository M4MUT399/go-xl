# Navegação — Fase 3: polyline consumível no passageiro (Bug B2)

Na tela do **motorista**, a rota já é "consumida": a cada fix, o carro é
projetado na polyline (`nearestPointOnPath`) e o traçado é dividido em
**[percorrido]** (esmaecido) e **[restante]** (colorido) via `splitPathAtSnap`.
A tela do **passageiro** desenhava a rota ativa **inteira** como uma linha só —
o traçado atrás do motorista nunca sumia.

Fase 3 leva o mesmo consumo ao passageiro, usando a posição do motorista
(`driverLoc`, vinda do realtime/polling) projetada na polyline ativa.

## Troca embarque → destino após o boarding

Já ocorre por **status** da corrida (`activePolyline`):

```
accepted / driver_en_route → toPickupPath   (motorista → embarque)
in_progress                → remainingPath   (motorista → destino)
shared_route_v1 ON         → serverPath      (rota única do servidor)
```

O consumo divide a polyline **ativa da fase corrente**, então a troca de fase
troca a linha inteira e o consumo recomeça no novo trecho.

## Flag

`nav_consume_polyline` (default **OFF**). Ligada:
```
driverLoc + activePolyline → nearestPointOnPath → splitPathAtSnap
  → traveled (rgba esmaecido, w4) + remaining (accent, w5)
```
Desligada, ou sem `driverLoc`/rota curta → desenha a rota ativa inteira (legado).
Habilitar por jurisdição após QA.

## Arquivos

| Arquivo | Papel |
|---|---|
| `src/lib/systemConfig.ts` | Flag `nav_consume_polyline` (default OFF). |
| `src/screens/passenger/ActiveRideScreen.tsx` | `routeSplit` (memo) + render percorrido/restante. |
| `src/lib/nav/geo.ts` | `nearestPointOnPath` + `splitPathAtSnap` (puros, já testados em `geo.test.ts`). |

## Validação

```bash
cd /Users/mamute99/go-xl
npx tsc --noEmit -p .
npx jest --config package.json src/lib/nav
```
