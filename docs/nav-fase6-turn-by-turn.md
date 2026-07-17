# Navegação — Fase 6: turn-by-turn (Feature F2) — estado e limites

## O que JÁ existe (entregue em fases anteriores)

O turn-by-turn **visual** já está completo no `DriverNavigateScreen`:

- **Manobras tipadas**: o campo `maneuver` da Google Directions é traduzido para
  o par `{type, modifier}` estilo OSRM (`mapGoogleManeuver` em `nav/directions.ts`),
  que os banners já entendem.
- **Banner de instrução**: seta da manobra (`maneuverArrow`), cor por manobra
  (`maneuverColor`), instrução traduzida pt/en/es (`maneuverInstruction` →
  chaves `driverNav.maneuver*`) e distância até a manobra (`formatStepDist`).
- **Reroute** por desvio (Fase 4 / `updateOffRoute` / `matchToRoute`).
- **Progresso**: distância à próxima manobra no banner.

## O que FICOU DE FORA nesta fase (decisões do usuário)

### 1. Voz (TTS) — ADIADA

Locução das manobras (en-US / pt-BR, com antecipação por distância) exigiria a
dependência nativa **`expo-speech`**, que **não está instalada**. Adicioná-la
força um **rebuild EAS** (não funciona por OTA / Expo Go).

**Decisão do usuário: pular a voz por ora.** Quando o rebuild for autorizado, o
plano é:

- núcleo **puro** `voiceGuidance.ts` — decide *o que* falar e *quando* (limiares
  de antecipação ~300 m / ~120 m / ~40 m, deduplicado por manobra, sem regredir
  de faixa), testável sem GPS/TTS;
- um **adapter** fino sobre `expo-speech` (interface `Speaker.speak(text, lang)`),
  com i18n dos avisos;
- fiação no `DriverNavigateScreen` usando a distância remanescente até o ponto da
  manobra (fim de `steps[0]`).

### 2. Lane guidance — NÃO DISPONÍVEL no provider atual (aceito sem, documentado)

A **Google Directions API não fornece lane guidance de forma estruturada** — as
faixas só aparecem embutidas no HTML das instruções (texto, tipicamente em
inglês, cobertura parcial e frágil). Lane guidance "de verdade" (setas por faixa,
faixas recomendadas destacadas) só vem de um **Navigation SDK** dedicado
(Mapbox Navigation SDK, Google Navigation SDK) — troca que a missão exige
**aprovação explícita** antes de executar.

**Decisão do usuário: aceitar sem lane guidance nesta fase e documentar.** O
restante do turn-by-turn (manobras tipadas, distância, futura voz) cobre a maior
parte do valor de navegação. Reavaliar o custo/benefício de um Navigation SDK
(rebuild, licenciamento, manutenção) se/quando lane guidance passar a ser
requisito firme.

## Resumo

| Item F2 | Estado |
|---|---|
| Manobras tipadas | ✅ entregue |
| Banner + distância + progresso | ✅ entregue |
| Reroute | ✅ entregue (Fase 4) |
| Voz (TTS) | ⏸ adiada — exige `expo-speech` + rebuild |
| Lane guidance | ❌ indisponível no provider atual — aceito sem, documentado |
