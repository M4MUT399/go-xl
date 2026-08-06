# Navegação GoXL — Fase 9: auditoria final, critérios de aceite e plano de teste GPX

Fechamento da missão **"Sistema de navegação — do aceite à finalização da
viagem."** Este documento audita o que foi entregue (bugs B1–B3, features F1–F5),
consolida o mapa de flags, define **critérios de aceite mensuráveis** e um
**plano de teste em campo por GPX** no cenário de referência
**I-4 × Conroy Rd / The Mall at Millenia (Orlando, FL)**.

Princípios que guiaram toda a missão:

- **Núcleo puro + testes**: toda regra de navegação vive em `src/lib/nav/*.ts`,
  determinística (recebe distância/pontos/tempo por parâmetro) e coberta por Jest;
  hooks/telas só orquestram.
- **Flags default OFF**: cada mudança de comportamento entra atrás de uma flag
  desligada, para rollout por jurisdição após QA. O caminho legado permanece
  intacto e é o fallback à prova de falhas.
- **Não trocar SDK sem aprovação**: mantido `react-native-maps` + camada própria
  sobre a Google Directions API. Itens que exigiriam Navigation SDK ou rebuild
  nativo foram **parados e sinalizados**, não executados.

## 1. Auditoria — bugs e features

| # | Item | Fase | Onde | Flag | Estado |
|---|---|---|---|---|---|
| **B1** | Marcador do motorista / zoom-out pós-aceite | Bloco 1 | `CameraController` único | — (base) | ✅ resolvido; **decisão**: manter o marcador GX navy+gold atual (sem troca) |
| **B2** | Polyline consumível (percorrido × restante) | Fase 3 | `geo.splitPathAtSnap` / passageiro | `nav_consume_polyline` | ✅ entregue (OFF) |
| **B3** | ETA dinâmico (decresce no tempo real, congela parado) + cadência de recálculo | Fase 2 | `useDynamicEta` + `etaTracker.ts` + cadência 45 s | — (base) | ✅ entregue |
| **F1** | Card do motorista clicável/expansível | Fase 7 | `rideCard.ts` + `DriverNavigateScreen` | `ride_card_expandable` | ✅ entregue (OFF) |
| **F2** | Turn-by-turn (manobras tipadas + distância) | Fase 6 | `directions.ts` + banners | `directions_v2` | ✅ visual entregue |
| F2 | └ Voz (TTS) | — | — | — | ⏸ **adiada** — exige `expo-speech` + rebuild EAS |
| F2 | └ Lane guidance | — | — | — | ❌ **indisponível** no provider atual — aceito sem, documentado |
| **F3** | Map-matching robusto (janela monotônica + score) | Fase 4 | `mapMatch.ts` | `nav_map_match_v2` | ✅ entregue (OFF) |
| **F4** | Movimento fluido — cadência de publicação | Fase 5a | `publishGate.ts` | `nav_publish_cadence` | ✅ entregue (OFF) |
| F4 | └ Background location | Fase 5b | `backgroundLocationTask.ts` | `nav_background_location_v1` | ✅ entregue (OFF) — exige rebuild EAS nativo antes de ligar |
| **F5** | Fluxo completo + geofence de chegada (~50 m) | Fase 8 | `arrival.ts` | `nav_arrival_geofence` | ✅ entregue (OFF) |
| — | Provider Google Directions (fundação de F2/F3) | Fase 1 | `directions.ts` + Edge Function | `directions_v2` | ✅ entregue (OFF, fallback OSRM) |

> As etiquetas B/F seguem os documentos de fase. B1 refere-se ao comportamento do
> marcador/câmera pós-aceite: o bug de zoom-out continental (iOS) foi corrigido no
> Bloco 1 (CameraController único) e a proposta de trocar o marcador foi
> **recusada pelo usuário** — mantém-se o crachá GX navy+gold.

### Cobertura de testes (núcleo puro)

`npx jest --config package.json src/lib/nav` → **14 suítes, 177 testes** passando
(inclui 3 casos novos para `DEFAULT_BACKGROUND_PUBLISH_GATE`, Fase 5b).
Suítes por peça: `geo`, `follow`, `courseUp`, `cameraGuard`, `filter`,
`smoothMarker`, `simulator`, `directions`, `etaTracker`, `sharedRoute`,
`rideCard`, `mapMatch`, `publishGate`, `arrival`.

## 2. Mapa de flags de navegação

| Flag | Default | Papel | Rollout |
|---|---|---|---|
| `nav_course_up_enabled` | **ON** | Câmera course-up (rumo do GPS > 4 km/h, filtro passa-baixa) | já ativa |
| `directions_v2` | OFF | Provider Google Directions (ETA com trânsito + geometria por step) | requer setup de chave/secret + deploy das funções |
| `shared_route_v1` | OFF | Rota única no servidor (motorista e passageiro leem a mesma) | após `directions_v2` |
| `nav_consume_polyline` | OFF | Polyline consumível no passageiro (B2) | por jurisdição, pós-QA |
| `nav_smooth_marker` | OFF | Interpolação/dead reckoning do marcador do passageiro | por jurisdição, pós-QA |
| `nav_map_match_v2` | OFF | Map-matching robusto (F3) | por jurisdição, pós-QA de campo |
| `nav_publish_cadence` | OFF | Cadência de publicação tempo+distância+heartbeat (F4) | por jurisdição, pós-QA |
| `nav_arrival_geofence` | OFF | Geofence de chegada ~50 m — só sinaliza a ação (F5) | por jurisdição, pós-QA (validar 50/80 m em campo) |
| `ride_card_expandable` | OFF | Card de corrida clicável/expansível (F1) | por jurisdição, pós-QA |
| `nav_background_location_v1` | OFF | Publica posição em background durante corrida ativa (F4, Fase 5b) | só após rebuild EAS publicado nas lojas + QA de campo |

**Ordem sugerida de ativação por jurisdição**: `directions_v2` →
`shared_route_v1` → `nav_map_match_v2` → `nav_publish_cadence` →
`nav_arrival_geofence` → `ride_card_expandable` / `nav_smooth_marker` /
`nav_consume_polyline`. Ligar uma de cada vez, observando telemetria entre passos.

## 3. Critérios de aceite (mensuráveis)

Cada critério é verificável com o app rodando + a flag correspondente ON.

**AC-1 — Provider (directions_v2)**
- Com chave/secret e função `directions` deployadas, a rota exibida traz ETA
  coerente com trânsito; **derrubando a rede da função**, a tela cai no OSRM sem
  ficar sem rota (fallback à prova de falhas).

**AC-2 — ETA dinâmico (B3)**
- Parado no trânsito, o número de ETA **não sobe** e congela (não pisca a cada
  fix). Andando, decresce de forma contínua; a cada ~45 s há um recálculo que
  reconcilia com o trânsito real. O horário previsto de chegada acompanha.

**AC-3 — Polyline consumível (B2)**
- Conforme o carro avança, o trecho percorrido some (cinza) e o restante
  permanece colorido; em alça de retorno o trecho não "revive" atrás do carro.

**AC-4 — Map-matching (F3)**
- Em via paralela à I-4 (frontage road), o snap **não pula** para a interestadual;
  o índice casado não regride em alças; desvio real > 40 m por ≥ 4 fixes dispara
  **um** reroute (não oscila).

**AC-5 — Cadência de publicação (F4)**
- Motorista **parado** no embarque: o marcador do passageiro **não congela** —
  há heartbeat ≤ 4 s. Andando, publica ao mover ≥ 25 m, respeitando o piso de
  1 s (sem flood).

**AC-6 — Geofence de chegada (F5)**
- Ao entrar em ≤ 50 m do alvo da fase, aparece a dica não bloqueante e o botão
  ganha realce; permanece "chegado" na zona 50–80 m (não pisca) e só cancela
  acima de 80 m. **O botão nunca age sozinho** — a confirmação dupla é sempre
  manual. Ao trocar de fase, o estado de chegada zera.

**AC-7 — Card do motorista (F1)**
- Tocar na linha do passageiro expande/recolhe o card (área ≥ 44 pt), revelando
  endereços/resumo, **sem** reenquadrar a câmera.

**AC-8 — Fluxo completo (F5)**
- aceite → embarque (`in_progress`) → destino (`completed`) com confirmação dupla
  em cada avanço; aviso não bloqueante se o embarque não foi confirmado;
  finalização notifica o passageiro e mostra o recibo; cancelamento pelo
  passageiro encerra a tela uma única vez.

**AC-geral — Regressão**
- Com **todas** as flags novas OFF, o comportamento é idêntico ao legado.
- `npx tsc --noEmit -p .` limpo e `npx jest --config package.json src/lib/nav`
  verde (174/174) antes de qualquer build.

## 4. Plano de teste em campo por GPX

Cenário de referência: **I-4 × Conroy Rd / The Mall at Millenia**. Reproduz um
ciclo real: motorista pega o passageiro perto de Millenia e leva a um destino
alcançado pela I-4, exercitando via expressa + frontage roads + alças.

### 4.1 Como reproduzir sem dirigir

- **Simulador embutido**: `src/lib/nav/simulator.ts` (`simulateRouteFixes`) já
  gera fixes ao longo de uma polyline — use-o em dev para "andar" a rota sem GPS.
- **GPX real em device**: iOS Simulator → *Features ▸ Location ▸ Custom GPX*;
  Android emulator → *Extended controls ▸ Location ▸ Routes/Import GPX*. Grave/edite
  um `.gpx` com os segmentos abaixo (1 fix/s ≈ velocidade urbana/expressa).

### 4.2 Segmentos e comportamento esperado

| Seg | Trecho | O que exercita | Esperado |
|---|---|---|---|
| S0 | Parado no ponto de embarque (Millenia) | F4 heartbeat + F5 geofence | marcador do passageiro atualiza ≤ 4 s parado; ao chegar ≤ 50 m, dica "chegou ao embarque" + botão realçado (AC-5, AC-6) |
| S1 | Embarque → rampa de acesso à I-4 | F3 map-matching em rampa | snap acompanha a rampa; sem pulo para a via principal antes de entrar (AC-4) |
| S2 | I-4 em velocidade | B3 ETA + course-up | ETA decresce contínuo; câmera course-up estável, sem giro de 180° (AC-2) |
| S3 | Frontage road paralela à I-4 | F3 desambiguação por rumo | snap fica na frontage, **não** salta para a I-4 (AC-4) |
| S4 | Desvio proposital > 40 m por ≥ 4 fixes | F3 histerese de off-route | exatamente **um** reroute; sem oscilação (AC-4) |
| S5 | Congestionamento simulado (parar 60 s) | B3 congela + F4 heartbeat | ETA não sobe/pisca; passageiro segue recebendo posição (AC-2, AC-5) |
| S6 | Saída da I-4 → aproximação do destino | F5 geofence dropoff | ao entrar ≤ 50 m do destino, dica "chegou ao destino" + realço "Finalizar" (AC-6) |
| S7 | Chegada + finalização manual | F5 fluxo | confirmação dupla → `completed` → recibo + notificação ao passageiro (AC-8) |

### 4.3 Matriz de execução

Rodar o ciclo S0–S7 **duas vezes**:
1. **Todas as flags novas OFF** → confirmar comportamento legado (regressão AC-geral).
2. **Flags ON** na ordem da §2 → confirmar AC-1…AC-8.

Registrar por segmento: ETA observado × esperado, ocorrências de reroute,
latência de atualização do marcador do passageiro, e disparo/《histerese》do
geofence. Anexar o `.gpx` usado ao ticket de QA da jurisdição.

## 5. Pendências que exigem decisão/rebuild (paradas e sinalizadas)

Estes itens **não** foram executados por baterem em limites de plataforma/SDK e
por exigirem aprovação explícita (regra da missão):

| Item | Por que parou | O que exige |
|---|---|---|
| **Voz (TTS)** da F2 | `expo-speech` não instalado | rebuild EAS (não OTA/Expo Go). Plano pronto: núcleo puro `voiceGuidance.ts` + adapter fino. |
| **Background location** da F4 | posição com app em 2º plano | `expo-location` background task + config nativa iOS/Android + rebuild EAS. |
| **Lane guidance** da F2 | Google Directions não fornece de forma estruturada | Navigation SDK dedicado (Mapbox/Google) — troca de SDK exige aprovação. |

Reavaliar cada um se/quando virar requisito firme, apresentando trade-offs
(licenciamento, manutenção, rebuild) antes de executar.

## 6. Resumo executivo

- **Entregue e testado (flags OFF, prontos para rollout)**: provider Google
  Directions com fallback OSRM, ETA dinâmico, polyline consumível, map-matching
  robusto, cadência de publicação, geofence de chegada e card expansível — todos
  sobre núcleos puros com **174 testes** verdes e `tsc` limpo.
- **Fluxo do aceite à finalização**: completo e preservado (fases, confirmação
  dupla, aviso de embarque, recibo, cancelamento), agora com sinalização de
  chegada.
- **Adiado com plano**: voz, background location, lane guidance — dependem de
  rebuild/SDK e de aprovação; documentados para retomada.
- **Próximo passo operacional**: setup da chave Directions + deploy das Edge
  Functions, depois ligar as flags por jurisdição na ordem sugerida, validando
  com o plano GPX da §4.
