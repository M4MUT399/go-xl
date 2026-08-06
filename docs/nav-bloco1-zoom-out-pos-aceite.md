# Go XL — Bloco 1 (paridade Uber): fim do zoom-out continental pós-aceite (iOS)

Fecha as lacunas do bug crítico do iOS em que o mapa da navegação do motorista
"explodia" para a escala de continente **logo após aceitar a corrida**. Este
bloco NÃO reescreve a câmera — o funil único (`CameraController`) e o guarda de
validação (`cameraGuard`) já existiam (ver tarefas #104 e #117). Aqui fechamos a
**última brecha não-guardada**: a *região inicial de montagem* da tela de
navegação.

## O bug (causa raiz da brecha restante)

Com a flag `camera_controller_enabled` ligada (padrão), toda animação de câmera
(`follow`/`region`/`fit`) já passa pelo guarda, que:

- rejeita `null`/`NaN`/`(0,0)` (Null Island) e saltos impossíveis (> 200 km);
- faz clamp do zoom para `[10, 20]` e dos deltas de região para `≤ 0.5`.

Logo, **nenhuma operação de câmera** consegue produzir zoom continental. Sobrava
**um** caminho sem guarda: o `initialRegion`/seed do `MapView` no
`DriverNavigateScreen`, que era montado com `rideOrigin(ride)` **cru**. Quando a
corrida chegava sem coordenada de embarque resolvida (ou com `(0,0)` de GPS sem
fix), o mapa **montava em Null Island** e o MapKit abria na visão de mundo antes
do primeiro fix chegar.

**Invariante que passa a valer:** a tela de navegação **nunca monta** numa região
default nem em coordenada-lixo. O centro de montagem é sempre a **primeira
coordenada válida** de uma lista de candidatos em ordem de preferência.

## A correção

### 1. Herança de enquadramento entre telas (`src/lib/nav/lastCamera.ts` — novo)

Slot único em memória de processo com a **última câmera válida** que o
`CameraController` aplicou com sucesso. A tela anterior (Home/aceite) grava; a
tela de navegação **herda**, em vez de abrir numa região arbitrária.

| Função | Comportamento |
|--------|---------------|
| `setLastValidCamera({lat,lng})` | Grava a última câmera válida (chamado pelo controller ao aplicar). |
| `getLastValidCamera()` | Última câmera válida conhecida, ou `null`. |
| `resetLastValidCamera()` | Zera o slot (uso em testes). |

O `CameraController` passou a chamar `setLastValidCamera` em **todo** ponto onde
confirma um centro (`follow`/`region`/`fit`), via o novo método privado
`commitValid(lat,lng)`.

### 2. Centro de montagem seguro (`firstValidCoord` em `cameraGuard.ts`)

Novo seletor **puro**: devolve a primeira coordenada finita, dentro dos limites e
não-`(0,0)` de uma lista de candidatos — ou `null` se nenhuma servir.

```ts
firstValidCoord([
  getLastValidCamera(),                 // 1. enquadramento herdado da tela anterior
  initialDriverLocation,                // 2. posição do motorista no aceite
  rideOrigin(ride),                     // 3. ponto de embarque
  rideDestination(ride),                // 4. destino (último recurso)
]);
```

### 3. Seed da tela (`src/screens/driver/DriverNavigateScreen.tsx`)

`seedCenter` é um `useMemo` de **deps vazias** (fixo por montagem) que resolve o
centro seguro uma única vez. Tanto o `carRegion` inicial quanto o `initialRegion`
do `MapView` usam `seedCenter.lat/lng` (delta `0.02`, nível de bairro). Se —
teoricamente impossível — todos os candidatos forem lixo, cai para `rideOrigin`
cru e **loga um `reportWarning`** (`nav mount: nenhum centro válido`) para
confirmarmos em produção que esse caminho nunca é exercido.

## Comportamento ambíguo documentado (decisão registrada)

O spec pedia "cancelar animações de câmera pendentes na transição
(generation/token)". Após a reconhecimento (Fase 0), concluímos que esse
requisito **já está estruturalmente satisfeito** e **não** construímos maquinaria
especulativa de token (o que arriscaria regressão no código de câmera já
validado):

- cada tela cria **seu próprio** `CameraController` (instância por montagem); ao
  desmontar, os efeitos que disparam `follow` têm cleanup, então nenhuma animação
  da tela anterior sobrevive na nova;
- uma nova animação no `animateCamera`/`animateToRegion` do `react-native-maps`
  **substitui** a anterior no mesmo `MapView` (não empilha).

Portanto o "generation-token" seria redundante. Registrado aqui em vez de mudar a
regra sem necessidade.

## Feature flag / rollout

- O guarda de câmera continua sob `camera_controller_enabled` (padrão **ON**);
  OFF = pass-through legado, rollback instantâneo sem redeploy.
- O **seed-guard** (itens 1–3) é um **bugfix puro sem flag**: só troca uma origem
  de montagem crua por uma coordenada validada. Não há caminho em que a versão
  antiga seja preferível, então uma flag dedicada só adicionaria superfície de
  risco. (Decisão consciente — se quisermos gating, a flag natural seria
  `nav_initial_region_guard`; hoje **não** existe.)

## Arquivos

| Arquivo | Mudança |
|---------|---------|
| `src/lib/nav/lastCamera.ts` | **novo** — slot da última câmera válida compartilhada entre telas. |
| `src/lib/nav/cameraGuard.ts` | **novo** `firstValidCoord` (seletor puro do centro de montagem). |
| `src/lib/nav/CameraController.ts` | grava `setLastValidCamera` em `follow`/`region`/`fit` via `commitValid`. |
| `src/screens/driver/DriverNavigateScreen.tsx` | `seedCenter` (firstValidCoord) alimenta `carRegion` + `initialRegion`; warning se tudo falhar. |
| `src/lib/nav/__tests__/cameraGuard.test.ts` | +5 testes de `firstValidCoord`. |

## Como validar localmente

O jest com preset `jest-expo` não roda neste ambiente (layout `.deno` em
`node_modules` quebra o setup do React Native). Os testes de **lógica pura**
rodam com a config default do jest (sem o preset):

```
npx jest --config package.json src/lib/nav/__tests__/cameraGuard.test.ts
npx tsc --noEmit -p .
```

Resultado atual: **25 passed, 25 total** (incl. os 5 de `firstValidCoord`);
`tsc` EXIT 0.

## Roteiro de teste manual (iPhone físico)

Pré-condição: `camera_controller_enabled = true` (padrão).

1. **Aceite com embarque resolvido:** fique online, receba e **aceite** uma
   corrida com endereço de embarque válido. A tela de navegação deve **abrir já
   enquadrada** no motorista/embarque (nível de bairro), **sem** nenhum frame de
   mundo/continente.
2. **Aceite antes do primeiro fix:** force o aceite com GPS ainda buscando fix
   (ou embarque não resolvido). A tela **não** pode piscar em Null Island/mundo;
   deve herdar o enquadramento da tela anterior e reancorar no primeiro fix bom.
3. **Salto de GPS:** durante a navegação, um fix-lixo (salto > 200 km) **não**
   pode reenquadrar o mapa — a câmera mantém a última posição válida.
4. **Telemetria:** confirme no sink de erros que updates rejeitados aparecem como
   `camera_update_rejected` (com `reason`) e que `nav mount: nenhum centro
   válido` **nunca** dispara em operação real.

## Riscos e rollback

- **Sem migration, sem contrato novo.** Só troca a origem de montagem crua por
  uma validada e liga o slot compartilhado de câmera.
- **Rollback do guarda:** `camera_controller_enabled = false` restaura o
  pass-through legado (config dinâmica, sem build). O seed-guard permanece (é
  bugfix puro), mas sem o controller alimentando o slot a herança degrada com
  segurança para os demais candidatos (posição do aceite / embarque / destino).
