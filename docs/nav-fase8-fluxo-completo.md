# Navegação — Fase 8: fluxo completo do aceite à finalização (Feature F5)

F5 pede o **fluxo de ponta a ponta** da navegação do motorista: aceite →
deslocamento ao embarque → embarque do passageiro → deslocamento ao destino →
finalização. A maior parte disso **já existia** e continua intacta; esta fase
fecha a única lacuna real — a **sinalização de chegada** — sem tocar na lógica de
negócio da máquina de fases.

## O que JÁ existia (entregue em fases/blocos anteriores)

A máquina de fases do `DriverNavigateScreen` já cobre o fluxo completo:

| Etapa F5 | Onde | Estado |
|---|---|---|
| Duas fases (`pickup` → `dropoff`) | `phase` state + `target = phase === 'pickup' ? origin : dest` | ✅ |
| Avanço de fase com escrita confirmada | `handleNextPhase` (`in_progress` → `dropoff`; `completed` → reset) | ✅ |
| Confirmação **dupla** anti-toque acidental | `startPhaseConfirmation` (dois `Alert` encadeados) | ✅ |
| Aviso de embarque não confirmado (não bloqueante) | `handleNextPhasePress` + `boardingWarning` | ✅ |
| Notificação de finalização ao passageiro | `notifyPassengerRideCompleted` + recibo | ✅ |
| Cancelamento pelo passageiro (3 caminhos redundantes) | canais realtime + `cancelledHandledRef` | ✅ |
| Rota única por fase + reroute | Bloco 3 / Fase 4 | ✅ |

**Regra preservada:** a ação principal ("Cheguei" / "Finalizar") é **sempre
manual** e passa pela confirmação dupla. Nada nesta fase avança fase
automaticamente.

## O que esta fase adiciona — geofence de chegada (~50 m)

O elo que faltava era **sinalizar o momento de agir**. Sem isso, o motorista tem
de adivinhar quando já está "em cima" do embarque/destino para tocar no botão. A
Fase 8 acrescenta um **geofence de chegada** que apenas **destaca** a ação — não
bloqueia, não dispara, não confirma nada sozinho.

### Núcleo puro — `src/lib/nav/arrival.ts`

`updateArrival(state, distanceM, cfg)` e a conveniência `updateArrivalAt(state,
point, target, cfg)` (calcula a distância por haversine):

- **HISTERESE anti-jitter**: entra em "chegou" a `enterM` (**50 m**) e só sai
  acima de `exitM` (**80 m**). Sem isso o estado piscaria com o jitter do GPS
  parado no ponto.
- **`justArrived`**: `true` só na **borda de subida** (não-chegou → chegou), para
  eventuais efeitos únicos; não repete enquanto permanece chegado.
- **Determinístico**: recebe a distância (ou os pontos) por parâmetro → testável
  sem GPS. Alvo/ponto `null` → mantém o estado, distância `Infinity`, sem chegada.

Puro/determinístico → **9 testes** em `arrival.test.ts` (longe, entrada, borda
única, zona de histerese, cancela só acima de exitM, config custom, a partir dos
pontos).

### Fiação — `DriverNavigateScreen`

Atrás da flag `nav_arrival_geofence` (default **OFF**):

- um efeito por fix mede a distância de `location` ao `target` da fase e aplica
  `updateArrivalAt` (histerese) → espelha o resultado em `arrivedHint`;
- ao **trocar de fase** (pickup → dropoff) o alvo muda; o geofence é **zerado**
  (mesmo ponto onde o índice do map-matcher é resetado) para não herdar um
  "chegou" da fase anterior;
- na UI, quando chegado, aparece uma **pílula não bloqueante** ("Você chegou ao
  embarque/destino") acima do botão e o botão ganha um **realce sutil** (sombra na
  cor primária). O `onPress`, o rótulo e a confirmação dupla seguem **idênticos**.

Sem a flag, a tela se comporta exatamente como antes (nenhum hint, nenhum realce).

## Flag

`nav_arrival_geofence` (default **OFF**). Ligar por jurisdição após QA de campo
(validar `enterM`/`exitM` contra o comportamento real do GPS na cidade-alvo).

## Arquivos

| Arquivo | Papel |
|---|---|
| `src/lib/nav/arrival.ts` | Núcleo puro do geofence de chegada (novo). |
| `src/lib/nav/__tests__/arrival.test.ts` | 9 casos (histerese, borda, custom, pontos). |
| `src/lib/systemConfig.ts` | Flag `nav_arrival_geofence` (default OFF). |
| `src/i18n/translations.ts` | Chaves `driverNav.arrived*Hint` (pt/en/es). |
| `src/screens/driver/DriverNavigateScreen.tsx` | Efeito do geofence + pílula/realce não bloqueantes. |

## Validação

```bash
cd /Users/mamute99/go-xl
npx tsc --noEmit -p .
npx jest --config package.json src/lib/nav
```

## Resumo

| Item F5 | Estado |
|---|---|
| Máquina de fases pickup → dropoff → completed | ✅ já existia |
| Confirmação dupla + aviso de embarque | ✅ já existia |
| Notificação/recibo de finalização | ✅ já existia |
| Cancelamento pelo passageiro | ✅ já existia |
| **Geofence de chegada (~50 m, histerese)** | ✅ **entregue nesta fase** (flag OFF) |
