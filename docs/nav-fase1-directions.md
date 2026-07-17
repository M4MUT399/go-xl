# Navegação — Fase 1: provider de rotas Google Directions

Troca o **OSRM demo público** (sem SLA, sem trânsito, sem lane guidance) pela
**Google Directions API** como provider de rotas, mantendo `react-native-maps`
e toda a camada `src/lib/nav/`. Ganhos:

- **ETA com trânsito em tempo real** (`departure_time=now` → `duration_in_traffic`).
- **Geometria por-step de alta resolução** (cada manobra traz sua própria
  polyline) — base do map-matching robusto da Fase 4.
- **Manobras mais ricas**, traduzidas para o vocabulário `{type, modifier}`
  estilo OSRM que os banners já entendem (nenhuma tela de UI muda nesta fase).

A **chave nunca vai para o cliente**: fica secreta no servidor (Edge Functions).
O cliente só recebe o JSON da Google e normaliza num módulo **puro e testável**.

## Arquitetura

```
Cliente (useRoute)
  └─ flag directions_v2 ON ─▶ getRouteViaDirections()
                                └─ Edge Function `directions` (chave secreta)
                                     └─ Google Directions API
                                └─ normalizeGoogleDirections()  ← parser puro/testado
  └─ falhou / flag OFF ──────▶ getRoute()  ← OSRM (fallback seguro)

Rota compartilhada (shared_route_v1)
  └─ Edge Function `compute-route`
       └─ computeRoute(): Google (se houver chave) ─▶ fallback OSRM
```

## Arquivos

| Arquivo | Papel |
|---|---|
| `src/lib/nav/directions.ts` | Parser **puro** Google→`RouteResult` (decode por step + `mapGoogleManeuver` + `stripHtml`). |
| `src/lib/nav/__tests__/directions.test.ts` | 10 testes (cenário I-4 × Conroy Rd). |
| `src/lib/routing.ts` | `getRouteViaDirections()` (proxy) + `RouteStep.coordinates` (geometria por step). |
| `src/hooks/useRoute.ts` | Escolhe provider pela flag `directions_v2`, com fallback OSRM. |
| `src/lib/systemConfig.ts` | Flag `directions_v2` (default **OFF**). |
| `supabase/functions/directions/index.ts` | Proxy autenticado da Directions API (chave secreta). |
| `supabase/functions/compute-route/index.ts` | Passa a usar Google quando há chave; senão OSRM. |

## Setup (uma vez, antes de ligar a flag)

1. **Google Cloud Console** (projeto `goxl-2026`): habilitar **Directions API**.
2. Criar/reutilizar uma **chave de servidor** — sem restrição de app; de
   preferência restrita por IP/API à Directions API. (Não reutilizar a chave de
   Maps SDK embutida no `app.json`.)
3. Definir o secret nas Edge Functions:
   ```bash
   supabase secrets set GOOGLE_DIRECTIONS_API_KEY=xxxxx
   ```
4. Deploy das funções:
   ```bash
   npx supabase functions deploy directions
   npx supabase functions deploy compute-route
   ```
5. **Só então** ligar a flag por jurisdição, após QA:
   ```sql
   -- system_config: directions_v2 = true (global ou por jurisdição)
   ```

## Comportamento de fallback (à prova de falhas)

- Flag **OFF** → cliente e servidor usam OSRM (comportamento legado, intacto).
- Flag **ON** mas função não deployada / sem cobertura / erro de rede →
  `getRouteViaDirections()` retorna `null` e o `useRoute` cai automaticamente no
  OSRM. Nenhuma tela fica sem rota.
- `compute-route` sem `GOOGLE_DIRECTIONS_API_KEY` → usa OSRM (como antes).

## Validação

```bash
cd /Users/mamute99/go-xl
npx tsc --noEmit -p .
npx jest --config package.json src/lib/nav
```
