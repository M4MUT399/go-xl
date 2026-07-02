# Go XL — Entrega dos upgrades pré-reenvio (iOS + Android)

Consolidação do que foi desenvolvido antes de reenviar às lojas. Todo o
desenvolvimento aqui é **cross-platform** (React Native + Expo + Supabase),
aplicável tanto a iOS quanto a Android. Nada removeu funcionalidade existente e
o fluxo de solicitação → aceite → recusa → início → finalização de corrida
permanece intacto.

## Princípios seguidos

- **Sem dado legal chumbado:** empresa/licença/nota do waybill, fees, pedágios,
  aeroportos e background check são **configuráveis por jurisdição** via
  `system_config` (resolução específica → global, com fallback local seguro).
- **Feature flags desligadas por padrão:** nenhuma feature nova muda o
  comportamento até o admin habilitar por jurisdição.
- **Núcleo puro e testado:** a lógica vive em `src/lib/*` sem dependência de RN,
  coberta por testes unitários; as camadas nativas (print/share, location) são
  finas por cima.
- **PII protegida:** nada de SSN puro no banco (só referência tokenizada do
  provider); PII é mascarada antes de ir para logs/telemetria.

## Entregue nesta frente

| Item | O que é | Onde |
|------|---------|------|
| P1 | Tela cheia de chamada + som recorrente + timeout configurável | telas/h’ks de ride |
| P2 | Corridas agendadas: banner fixo, alerta sonoro, antecedência dinâmica | `scheduledRides.ts` |
| P3 | Limite de direção 12h + descanso 6h (configurável) | `drivingLimits.ts`, duty sessions |
| P4 | Waybill/recibo por viagem: núcleo + PDF sob demanda + ação "Recibo" | `waybill.ts`, `waybillExport.ts`, EarningsScreen |
| P5 | Pedágio no preço: provider abstrato + mock + flag | `tolls.ts` |
| P6 | Airport/Port fees por geofence configurável | `airportFees.ts` |
| P7 | Background check: provider abstrato + gate configurável (sem SSN) | `backgroundCheck.ts`, `useBackgroundCheck.ts` |
| Item 8 | ADR: app único vs. apps separados | `docs/adr-0001-*.md` |
| Item 9 (app) | Mascaramento de PII + telemetria unificada de falhas | `mask.ts`, `errorReporting.ts` |

## Feature flags (todas seguras por padrão)

`src/lib/systemConfig.ts` → `CONFIG_DEFAULTS`. Padrões que **preservam o
comportamento atual**:

- `tolls_enabled: false`, `mock_toll_flat/per_km: 0`
- `airport_port_fees: []` (sem zonas → fee 0)
- `background_check_required: false`
- `waybill_enabled: false` (empresa/licença/nota vazias)
- Limites/antecedências de P2/P3 com defaults conservadores

## Banco de dados

Migrations **0021–0033 aplicadas e confirmadas em produção** (ride telemetry,
`system_config`, `ride_offer_events`, duty sessions, toll/airport fee columns +
config, `driver_background_checks` sem coluna de SSN, seeds de waybill). RLS por
tabela: motorista vê só o que é seu; escrita sensível restrita a `service_role`.

## Testes

`npx jest` → **10 suites, 106 testes** passando. `npx tsc --noEmit` limpo.
Cobrem: waybill, tolls, airport fees, background check, driving limits,
scheduled rides, system config, mask e error reporting.

## Checklist pré-build (ação do fundador)

1. **app.json — background location declarada mas não usada** (ver ADR-0001 §3):
   o runtime é foreground-only (`useLocation.ts`). Antes do build, remover as
   declarações não usadas para evitar rejeição:
   - `isAndroidBackgroundLocationEnabled: false` (remove `ACCESS_BACKGROUND_LOCATION`)
   - tirar `"location"` de `UIBackgroundModes` e as strings `NSLocationAlways*`
   - Re-adicionar quando a P1b (entrega em background) entrar.
2. **Google Play Console:** verificar status/saúde da conta de publicação.
3. **Rebuild nativo obrigatório:** foram adicionados `expo-print` e
   `expo-sharing` (P4) — exigem novo build EAS (não funciona em OTA).
4. **EAS:** garantir `package-lock.json` sincronizado (já está) e `eas.json`
   comitado — armadilhas conhecidas de build.
5. **Configurar por jurisdição no admin** o que for entrar no ar (ex.: habilitar
   waybill com dados legais reais; zonas de fee; toll).

## Deferido (fora do escopo cross-platform desta frente)

- **Repo admin/backend:** tabela `waybills` + busca administrativa + RBAC/logs/
  retenção (P4 persistência); rate limit server-side, criptografia em repouso,
  admin audit log e retenção/TTL (Item 9 backend).
- **Nativo:** P1b — entrega da chamada em background/lockscreen (exige módulo
  nativo dedicado).
- **Build/loja:** geração dos binários EAS e submissão.
