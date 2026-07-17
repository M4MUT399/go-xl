# Navegação — Fase 5: movimento fluido (Feature F4)

F4 pede movimento estilo Uber/Waze: marcador que desliza a 60fps sem teleporte,
rotação pelo arco mais curto, dead reckoning entre fixes, câmera course-up e uma
cadência de publicação que mantenha o marcador do passageiro vivo mesmo com o
carro devagar/parado.

## O que já existia (Blocos 1–3, reaproveitado)

| Peça F4 | Onde | Estado |
|---|---|---|
| Interpolação sem teleporte | `AnimatedRegion` (motorista) + `SmoothMarker` (passageiro) | ✅ |
| Rotação pelo arco mais curto | `shortestAngleDelta` / heading contínuo | ✅ |
| Dead reckoning | núcleo `nav/smoothMarker.ts` (`deadReckonMaxMs`) | ✅ (passageiro) |
| Câmera course-up | `nav/courseUp.ts` + `advanceHeading` | ✅ |

## O que esta fase adiciona (5a — JS puro, sem rebuild)

O elo que faltava era a **cadência de publicação**. Até aqui o motorista só
publicava a posição ao andar **> 30 m**. No trânsito parado ou no embarque, o
marcador do **passageiro congelava** (nenhum write saía) e a última posição
"envelhecia".

### Núcleo puro — `src/lib/nav/publishGate.ts`

`shouldPublishFix(last, next, nowMs, cfg)` combina tempo + distância:

- **piso** (`minIntervalMs` 1 s): nunca publica mais rápido (anti-flood);
- **distância** (`minDistanceM` 25 m): publica ao andar o suficiente;
- **heartbeat** (`maxIntervalMs` 4 s): publica mesmo parado, para o dado ficar
  fresco (o `SmoothMarker` do passageiro interpola/segura o dead reckoning com
  base num timestamp recente).

Puro/determinístico (`nowMs` por parâmetro) → 6 testes em `publishGate.test.ts`.

### Fiação — `DriverNavigateScreen`

Atrás da flag `nav_publish_cadence` (default **OFF**), os **dois** publicadores
passam a usar `shouldPublishFix` + um heartbeat (`setInterval` 1 s → `publishTick`
nas deps, para reavaliar mesmo sem novo fix):

- `driver_locations.upsert` (stream de presença);
- `rides.update` (**é daqui que o passageiro lê** `driver_lat/lng/heading`).

Sem a flag, mantém o throttle só-distância legado (> 30 m) em ambos.

## Flag

`nav_publish_cadence` (default **OFF**). Ligar por jurisdição após QA.

## Arquivos

| Arquivo | Papel |
|---|---|
| `src/lib/nav/publishGate.ts` | Núcleo puro da cadência (novo). |
| `src/lib/nav/__tests__/publishGate.test.ts` | 6 casos (piso, distância, heartbeat, custom). |
| `src/lib/systemConfig.ts` | Flag `nav_publish_cadence` (default OFF). |
| `src/screens/driver/DriverNavigateScreen.tsx` | Cadência nos dois publicadores + heartbeat. |

## Validação

```bash
cd /Users/mamute99/go-xl
npx tsc --noEmit -p .
npx jest --config package.json src/lib/nav
```

## Pendente — 5b: background location (EXIGE REBUILD NATIVO)

Transmitir a posição do motorista com o app em **segundo plano** exige:

- `expo-location` background task (`startLocationUpdatesAsync` + `TaskManager`);
- iOS: `UIBackgroundModes: [location]` + `NSLocationAlwaysAndWhenInUseUsageDescription`;
- Android: foreground service (`FOREGROUND_SERVICE_LOCATION`) + notificação persistente;
- um novo build EAS (não valida no Expo Go nem em OTA).

**Não incluído nesta fase por decisão do usuário** ("só a parte JS agora"). O
background location fica como decisão/entrega separada, a ser confirmada antes de
qualquer alteração de config nativa e disparo de build.
