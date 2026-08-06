# Go XL — Bloco 4 (paridade Uber): card de corrida clicável/expansível

Transforma o painel compacto pós-aceite do **motorista** (`DriverNavigateScreen`)
num card **tocável e expansível** estilo Uber: a faixa de identidade do
passageiro vira uma área de toque (≥44pt) que expande o card para revelar o
endereço oposto completo, o nome do passageiro e o resumo da viagem
(preço · distância) — **sem reenquadrar o mapa**.

## O gap

- O painel compacto (`bottomSheetCompact`) já mostrava foto/nome/rating do
  passageiro + tempo/velocidade + botão de ação. Mas era **estático**: o
  motorista não tinha como consultar o endereço completo de destino/embarque
  nem o resumo financeiro sem sair da tela.
- Uber deixa esse card **tocável** (área ≥44pt, do aceite ao fim da corrida) e
  **expansível**, e a expansão **não** mexe na câmera do mapa.

## Núcleo puro (`src/lib/nav/rideCard.ts`)

A decisão de **qual endereço fica em destaque** e **quais linhas aparecem ao
expandir** vive num módulo **sem React nem i18n resolvido** (devolve só chaves de
tradução), testável em unidade e mantendo a tela burra.

`buildRideCardModel(input)` → `{ primaryLabelKey, primaryAddress, expandedRows }`:

| Fase | Destaque (primary) | Linhas reveladas ao expandir |
|------|--------------------|------------------------------|
| `pickup` | EMBARQUE (origem) | destino · passageiro · (preço · distância) |
| `dropoff` | DESTINO | onde foi o embarque · passageiro · (preço · distância) |

Regras:
- O endereço em destaque **nunca** se repete nas linhas expandidas.
- Linha do passageiro **omitida** se o nome estiver ausente/vazio.
- Preço e distância viram **uma única** linha de resumo, unidos por `·`; se só um
  existir, mostra só ele; se nenhum, a linha some.

## Wiring (`src/screens/driver/DriverNavigateScreen.tsx`)

Sob a flag, a `paxRow` vira um `<TouchableOpacity>` (com `minHeight: 44`,
`accessibilityRole="button"` + `accessibilityState={{ expanded }}`) que alterna
`cardExpanded`. Abaixo dela, um `cardBody` mostra sempre o endereço em destaque
da fase atual (1 linha quando recolhido, completo quando expandido) e, quando
expandido, as `expandedRows` do modelo.

- **Câmera intocada:** a expansão usa `LayoutAnimation.easeInEaseOut()`, que anima
  **só a altura do próprio card**. Não há nenhuma chamada ao `CameraController`
  no toggle → o mapa **não** dá zoom/pan ao expandir/recolher (requisito Bloco 4).
- **Android:** `UIManager.setLayoutAnimationEnabledExperimental(true)` é chamado
  uma vez no carregamento do módulo (necessário p/ `LayoutAnimation` no Android).
- Valores já formatados entram no modelo: `formatCurrency(ride.price)` e
  `formatDistance(ride.distance_km)` (mi). A tela só resolve as chaves i18n.

## i18n

Nova chave `driverNav.tripSummary` nas 3 línguas de `src/i18n/translations.ts`:

| Idioma | Valor |
|--------|-------|
| EN | `Trip` |
| ES | `Viaje` |
| PT | `Viagem` |

Reaproveita as chaves existentes `tripDetails.pickup`, `tripDetails.dropoff` e
`driverNav.passenger`.

## Feature flag

`src/lib/systemConfig.ts` → `CONFIG_DEFAULTS`:

```
ride_card_expandable: false   // DESLIGADA por padrão
```

- **OFF (padrão):** painel compacto legado, sem chevron e sem toque (a `paxRow`
  fica com `disabled` e `activeOpacity={1}` → visualmente idêntico ao de hoje).
- **ON:** card tocável/expansível. Habilitar por jurisdição após QA. Rollback
  instantâneo sem redeploy (config dinâmica).

## Arquivos

| Arquivo | Mudança |
|---------|---------|
| `src/lib/nav/rideCard.ts` | **novo** — modelo puro `buildRideCardModel`. |
| `src/lib/nav/__tests__/rideCard.test.ts` | **novo** — 10 testes unitários. |
| `src/i18n/translations.ts` | nova chave `driverNav.tripSummary` (pt/en/es). |
| `src/lib/systemConfig.ts` | flag `ride_card_expandable: false`. |
| `src/screens/driver/DriverNavigateScreen.tsx` | card tocável/expansível sob flag; painel compacto legado quando OFF. |

## Como validar localmente

```
npx jest --config package.json src/lib/nav/__tests__/rideCard.test.ts
npx tsc --noEmit -p .
```

Resultado atual: **10 passed** (rideCard) · suíte `nav` completa **111 passed** ·
`tsc` EXIT 0.

## Roteiro de teste manual (iPhone físico)

Pré-condição: `ride_card_expandable = true` (jurisdição de teste). Motorista com
uma corrida aceita (fase `pickup`) e depois `in_progress` (fase `dropoff`).

1. **Área de toque:** tocar em qualquer ponto da faixa do passageiro expande o
   card (o chevron `›` vira `⌄`). A faixa toda responde ao toque (≥44pt).
2. **Conteúdo por fase — pickup:** destaque = **EMBARQUE**; expandido revela
   **destino** (endereço completo), passageiro e resumo (preço · distância).
3. **Conteúdo por fase — dropoff:** destaque = **DESTINO**; expandido revela onde
   foi o **embarque**, passageiro e resumo.
4. **Câmera estável:** ao expandir/recolher, o mapa **não** dá zoom nem pan —
   só o card muda de altura, com animação suave.
5. **Recolher:** tocar de novo recolhe; o endereço em destaque volta a 1 linha.
6. **Rollback:** `ride_card_expandable = false` → volta ao painel compacto
   legado (sem chevron, sem toque), confirmando o rollback sem redeploy.

## Riscos e rollback

- **Sem migration, sem contrato novo.** Só muda a renderização do painel do
  motorista sob flag; nenhuma escrita/rota nova.
- **Câmera preservada:** a animação é puramente local ao card (`LayoutAnimation`),
  sem tocar no `CameraController` → zero risco de regressão no enquadramento do
  Bloco 1.
- **Degradação segura:** com a flag OFF a `paxRow` fica desabilitada e opaca —
  comportamento idêntico ao painel de produção atual.
