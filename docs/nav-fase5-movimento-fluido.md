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

## 5b: background location (entregue — EXIGE REBUILD NATIVO)

Transmite a posição do motorista com o app em **segundo plano** (minimizado ou
tela bloqueada) durante uma corrida ativa, para o passageiro não perder o
motorista de vista. Atrás da flag `nav_background_location_v1` (default
**OFF**) — precisa do rebuild nativo publicado nas lojas antes de ligar por
jurisdição.

Peças:

- `src/lib/nav/backgroundLocationTask.ts` — `TaskManager.defineTask` no escopo
  do módulo (mesmo padrão de `backgroundNotifications.ts`, Camada 2). Contexto
  da corrida ativa (`rideId`/`driverId`) e o último fix publicado ficam em
  AsyncStorage (não memória) — a task roda fora do ciclo de vida do React e o
  iOS pode suspender/relançar o processo entre fixes. Cadência mais folgada
  (`DEFAULT_BACKGROUND_PUBLISH_GATE`: piso 5 s, heartbeat 15 s, 50 m) que a de
  primeiro plano — sem tela para mostrar "ao vivo" e cada write custa
  bateria/rádio com o processo suspenso.
- `index.ts` — importa `backgroundLocationTask` como efeito colateral, junto
  com `backgroundNotifications`, ANTES do import de `App` (registro precisa
  acontecer antes de o SO poder invocar a task).
- `src/screens/driver/DriverNavigateScreen.tsx` — ao montar (corrida já
  aceita) com a flag ON, mostra uma vez o aviso de consentimento
  (`driverNav.bgLocation*` em en/es/pt); se autorizado, pede a permissão
  "always" (`Location.requestBackgroundPermissionsAsync`) e inicia a task.
  Para no desmonte (cancelamento, finalização ou navegar para trás) — nunca
  segue rastreando fora de uma corrida ativa.
- `src/lib/systemConfig.ts` — flag `nav_background_location_v1` (default OFF).
- app.json — iOS: `UIBackgroundModes: [remote-notification, location]` +
  `NSLocationAlwaysAndWhenInUseUsageDescription`. Android: permissions
  `ACCESS_BACKGROUND_LOCATION` + `FOREGROUND_SERVICE_LOCATION` (removido de
  `blockedPermissions`); plugin `expo-location` com
  `isAndroidBackgroundLocationEnabled: true` +
  `isAndroidForegroundServiceEnabled: true` (notificação persistente
  obrigatória no Android com localização em background).

Não valida no Expo Go nem em OTA — exige rebuild EAS nativo (iOS + Android)
antes de qualquer QA de campo.
