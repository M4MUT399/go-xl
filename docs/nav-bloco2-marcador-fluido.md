# Go XL — Bloco 2 (paridade Uber): marcador de veículo com movimento fluido

Substitui o "pulo" do marcador do motorista por um movimento contínuo estilo
Uber/Waze, num **componente reutilizável** (`SmoothMarker`) que o Bloco 3
(mapa compartilhado) também consumirá para animar a posição no lado do
passageiro.

## O gap

- **Motorista** (`DriverNavigateScreen`): já animava nativamente via
  `AnimatedRegion` + `MarkerAnimated.timing()`. **Não** foi mexido (evita
  regressão no laço câmera+marcador já validado no Bloco 1).
- **Passageiro** (`ActiveRideScreen`): renderizava o carro num `<Marker>` cru
  cuja `coordinate` mudava a cada atualização de posição vinda do realtime → o
  ícone **teleportava** de um ponto ao outro. Este é o gap que o Bloco 2 fecha.

## Núcleo puro (`src/lib/nav/smoothMarker.ts`)

Toda a decisão vive num módulo **sem React nem SDK de mapa**, testável em
unidade e reutilizável nos dois lados:

| Função | O que faz |
|--------|-----------|
| `interpolationDuration(prevTs, now, cfg)` | Duração da animação = intervalo entre fixes, clampado a `[min, max]`. 1º fix → `0` (crava, sem glide de seed). |
| `resolveTarget(fix, route, cfg)` | **Snap-na-rota**: cola o marcador na polyline se estiver a ≤ `snapMaxMeters`; senão usa o fix cru. Sem rota → sempre cru. |
| `deadReckon(fix, now, cfg)` | **Dead reckoning**: projeta a posição à frente pelo rumo+velocidade quando o próximo fix atrasa, limitado a `deadReckonMaxMs` (3 s). Sem velocidade/rumo → não projeta (nunca inventa). |
| `continuousHeading(current, fix, cfg)` | Rotação pelo **arco mais curto** (desenrolado: 359°→1° gira +2°). Congela parado (velocidade conhecida e baixa). Velocidade **desconhecida** → confia no rumo. |
| `inferHeading(from, to)` | Fallback de rumo pela direção do deslocamento quando o GPS não traz curso (ignora passos < 2 m). |

Apoia-se em primitivas já existentes de `nav/geo.ts` (`nearestPointOnPath`,
`bearingBetween`, `shortestAngleDelta`) + a nova `destinationPoint` (projeção
geodésica, base do dead reckoning).

### Parâmetros (`DEFAULT_SMOOTH`)

| Chave | Default | Controla |
|-------|---------|----------|
| `interpolateMs` | `1000` | Duração-alvo da interpolação entre fixes. |
| `minInterpolateMs` / `maxInterpolateMs` | `400` / `1200` | Piso/teto da duração (evita animação instantânea ou "arrastão"). |
| `snapMaxMeters` | `25` | Desvio máx. para colar na via. |
| `deadReckonMaxMs` | `3000` | Projeção máxima sem novo fix. |
| `minMotionMps` | `1.5` | Abaixo disso o rumo congela e não há dead reckoning. |

## Componente (`src/components/common/SmoothMarker.tsx`)

Envolve `<MarkerAnimated>` preso a uma `<AnimatedRegion>`. A cada fix anima a
posição **nativamente (60 fps)** para o alvo resolvido; um timer de 500 ms cobre
o dead reckoning quando o fix atrasa. Entrega o heading suavizado ao visual via
render-prop, para funcionar com qualquer marcador:

```tsx
<SmoothMarker fix={driverFix} route={smoothRoute} anchor={{ x: 0.5, y: 0.5 }}>
  {(heading) => <CarMarker scale={0.75} heading={heading} />}
</SmoothMarker>
```

## Wiring (`src/screens/passenger/ActiveRideScreen.tsx`)

Sob a flag, o `<Marker>` cru do motorista é trocado pelo `<SmoothMarker>`.
`driverLoc` (realtime) não traz velocidade/timestamp: carimbamos `Date.now()` na
atualização e deixamos a velocidade **indefinida** — assim o marcador **rotaciona
seguindo o rumo** mas **não** faz dead reckoning (seguro, sem inventar posição
sem dado de velocidade). O trecho ativo da rota é passado para o snap.

## Feature flag

`src/lib/systemConfig.ts` → `CONFIG_DEFAULTS`:

```
nav_smooth_marker: false   // DESLIGADA por padrão
```

- **OFF (padrão):** passageiro segue com o `<Marker>` cru legado. Rollback
  instantâneo sem redeploy (config dinâmica por jurisdição).
- **ON:** passageiro usa o `<SmoothMarker>`. Habilitar por jurisdição após QA.

## Arquivos

| Arquivo | Mudança |
|---------|---------|
| `src/lib/nav/geo.ts` | **novo** `destinationPoint` (projeção geodésica). |
| `src/lib/nav/smoothMarker.ts` | **novo** — núcleo puro do marcador fluido. |
| `src/lib/nav/__tests__/smoothMarker.test.ts` | **novo** — 18 testes unitários. |
| `src/components/common/SmoothMarker.tsx` | **novo** — componente reutilizável. |
| `src/lib/systemConfig.ts` | flag `nav_smooth_marker: false`. |
| `src/screens/passenger/ActiveRideScreen.tsx` | marcador do motorista sob flag: `<SmoothMarker>` vs `<Marker>` legado. |

## Como validar localmente

```
npx jest --config package.json src/lib/nav/__tests__/smoothMarker.test.ts
npx tsc --noEmit -p .
```

Resultado atual: **18 passed** (smoothMarker) · suíte `nav` completa **43
passed** · `tsc` EXIT 0.

## Roteiro de teste manual (iPhone físico, 2 aparelhos)

Pré-condição: `nav_smooth_marker = true` (jurisdição de teste). App do passageiro
com uma corrida `accepted`/`in_progress` e o motorista se deslocando.

1. **Movimento fluido:** no app do passageiro, o carro do motorista deve
   **deslizar** suavemente entre atualizações, sem saltos/teleporte.
2. **Rotação suave:** ao o motorista virar, a seta gira pelo **caminho mais
   curto** (nunca dá a volta de 358°).
3. **Snap-na-rota:** com o carro sobre a via, o marcador acompanha a linha da
   rota (não "flutua" no meio-fio) enquanto estiver a ≤ 25 m dela.
4. **Sem reenquadrar por causa do marcador:** a suavização **não** deve disparar
   zoom/pan do mapa (a câmera continua governada pelo Bloco 1/CameraController).
5. **Rollback:** `nav_smooth_marker = false` → volta ao marcador cru (que pula),
   confirmando o rollback sem redeploy.

## Riscos e rollback

- **Sem migration, sem contrato novo.** Só troca a renderização do marcador do
  passageiro sob flag; o motorista fica intocado.
- **Dead reckoning conservador:** sem velocidade (caso do passageiro hoje) ele
  **não** projeta — no pior caso o marcador só interpola entre fixes, nunca
  extrapola para uma posição inexistente.
- **Reuso Bloco 3:** quando o passageiro passar a receber posição do servidor com
  velocidade/timestamp, o mesmo `SmoothMarker` já habilita dead reckoning sem
  mudança de componente.
