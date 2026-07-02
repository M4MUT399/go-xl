# ADR-0001 — App único (com papel) vs. apps separados Rider/Driver

- **Status:** Proposto (recomendação para decisão do fundador)
- **Data:** 2026-07-02
- **Contexto do programa:** upgrades pré-reenvio às lojas (Apple/Google) do Go XL
- **Decisão que precisa ser tomada:** manter **um único app** que atende passageiro
  e motorista, ou dividir em **dois apps** (Go XL Rider e Go XL Driver), como fazem
  Uber, Lyft, 99 e inDrive.

---

## 1. Estado atual (fatos, não suposições)

Levantamento do código em `/Users/mamute99/go-xl`:

- **Modelo de papel:** `profile.type` é `'passenger' | 'driver'` — **mutuamente
  exclusivo**, com `check` no banco. Escolhido **uma vez** no cadastro
  (`RegisterScreen`, via `WelcomeScreen`/`ExpressRegisterScreen`). **Não há troca
  de papel** depois: nenhuma UI ou rota altera `type`.
- **Navegação:** árvore única (`src/navigation/AppNavigator.tsx`) que **ramifica
  forte** por papel. `DriverTabs` (Mapa/Agenda/Ganhos/Perfil) e `PassengerTabs`
  (Início/Viagens/Perfil) são totalmente separadas. Telas realmente compartilhadas:
  `ProfileScreen`, `ChatScreen`, auth e alguns modais.
- **Identidade única:** um só bundle `com.goxl.app` (iOS e Android), slug `go-xl`,
  scheme `goxl`. **Não existe** segundo app/segundo projeto EAS.
- **Tamanho e reuso:** ~17.8k LOC. Cerca de **40–45% específico de papel**
  (telas passageiro ~21%, telas motorista ~16%) e **~55–60% compartilhado**
  (hooks, lib pura, navegação, i18n, pagamentos, chat, notificações).
- **Peso do lado motorista:** rastreio de localização + duty sessions (limite de
  direção P3), verificação/background check (P7), veículo, ganhos/payouts, waybill
  (P4), navegação ao vivo (`DriverNavigateScreen`, 837 LOC), QR de vínculo.
- **Permissões (atenção):** o `app.json` **declara** background location
  (`isAndroidBackgroundLocationEnabled: true`, iOS `UIBackgroundModes: ["location"]`,
  strings `NSLocationAlways*`) — no app único, portanto também no build do
  passageiro. Porém o **runtime só pede foreground**: `useLocation.ts` chama
  `requestForegroundPermissionsAsync()` e nunca `requestBackgroundPermissionsAsync()`.
  Ou seja, há uma **capacidade de background declarada mas não usada** (a entrega
  em background/lockscreen — P1b — está adiada). Esse *mismatch* é motivo comum de
  rejeição (Apple: "declara background location sem feature que a use"; Google Play:
  exige revisão especial + vídeo de justificativa para `ACCESS_BACKGROUND_LOCATION`).

**Resumo técnico:** já estamos *desacoplados na navegação* (branch por
`profile.type`), mas *acoplados nas dependências* (hooks e lib compartilhados).
A arquitetura está "meio caminho" de uma eventual separação.

---

## 2. Opções

### Opção A — Manter app único (estado atual)

**Prós**
- Um binário, um ciclo de release, uma revisão de loja.
- Reuso alto (~60%): auth, pagamentos, chat, notificações, i18n, roteamento.
- Backend simples: uma tabela de usuário, um modelo de corrida.
- Menor custo de manutenção/compliance para uma equipe pequena.
- Um motorista que às vezes é passageiro não precisa de segundo app (hoje isso
  nem é possível pelo modelo de papel, mas removeria fricção no futuro).

**Contras**
- Lógica condicional por papel espalhada (toda tela/hardesh checa `type`).
- Binário do passageiro carrega código que ele não usa.
- **Risco de revisão Apple/Google:** app único pedindo `ACCESS_BACKGROUND_LOCATION`
  para *todos* os usuários (inclusive passageiros) é motivo comum de rejeição —
  a Apple exige justificar background location e mostrá-la só a quem precisa.
- Superfície de engenharia reversa: o passageiro tem o código do motorista no
  bundle.

### Opção B — Dois apps (Rider / Driver) sobre um core compartilhado

**Prós**
- Binários menores e UX sem checagem de papel.
- Cadência de release independente (motorista itera mais rápido).
- Listagens de loja e marketing dedicados por público.
- Permissões corretas por app: só o Driver pede background location → **remove o
  principal risco de rejeição** citado acima.
- Menor superfície de ataque por app.

**Contras**
- Duplicação: exige extrair **core compartilhado** (monorepo + pacote `@goxl/core`
  ou workspaces) para não copiar 55–60% do código.
- Dois reviews, duas fichas de loja, dois pipelines EAS para manter.
- O backend continua servindo os dois papéis (mesmo schema) — a separação é só no
  cliente.
- Reescrita de navegação e de bootstrap; custo real de dias/semanas.

---

## 3. Recomendação

**Manter o app único agora (Opção A) para o reenvio imediato**, e **preparar o
terreno** para uma separação futura, tratando-a como decisão de escala, não de
bloqueio.

**Por quê:**
1. O reenvio às lojas é iminente; dividir agora **dobra a superfície de revisão**
   e atrasa o retorno ao ar, sem ganho de produto para o usuário final.
2. Os maiores motivos para separar (binário menor, listagens dedicadas, velocidade
   de iteração do motorista) **não superam o custo** na escala atual e com equipe
   enxuta.
3. A arquitetura já ramifica por papel; o reuso está saudável. O "meio caminho"
   atual permite separar depois **sem retrabalho grande**, desde que o core siga
   limpo (lib pura já é testável e sem dependência de RN em vários módulos).

**Ressalva importante (independe da decisão):** existe **hoje** uma capacidade de
background location **declarada mas não usada** (ver §1). Como a P1b (entrega em
background) está adiada, a mitigação pré-reenvio recomendada é:
- **Remover as declarações de background location** do `app.json` enquanto não há
  feature que as use: `isAndroidBackgroundLocationEnabled: false` (remove
  `ACCESS_BACKGROUND_LOCATION`), tirar `"location"` de `UIBackgroundModes` e as
  strings `NSLocationAlways*`. O runtime já só usa foreground, então **não há
  regressão funcional**. Re-adicionar quando a P1b entrar.
- Alternativa (se for implementar P1b antes do reenvio): **solicitar background em
  runtime só quando `type === 'driver'`** e justificar nas purpose strings o uso
  pelo motorista.
- Se a Apple/Google questionar mesmo com foreground-only, isso vira **gatilho nº 1**
  para separar os apps (o Driver carrega as permissões sensíveis; o Rider não).

---

## 4. Gatilhos para reavaliar (quando separar deixa de ser prematuro)

Revisar esta ADR se **qualquer** um ocorrer:

1. **Rejeição de loja** ligada a permissões/escopo do papel (ex.: background
   location no app do passageiro).
2. Necessidade de **cadência de release divergente** entre passageiro e motorista.
3. Base de motoristas grande o suficiente para justificar **listagem e marketing
   dedicados**.
4. Binário/cold-start do passageiro degradado por features de motorista.
5. Requisito de **conta com os dois papéis** (motorista que também pede corrida) —
   aí um app único com *troca de papel* OU dois apps + SSO viram pauta.

---

## 5. Consequências da recomendação

- **Curto prazo:** nada de reestruturação de projeto agora; foco no reenvio.
  Ação concreta pré-build: remover as declarações de background location não usadas
  do `app.json` (ver §3) — sem regressão, pois o runtime já é foreground-only.
- **Médio prazo:** manter a disciplina de **core sem acoplamento a RN/roles** na
  `src/lib` (já é o padrão) para que a extração futura para `@goxl/core` seja
  mecânica, não uma reescrita.
- **Não fazemos agora:** monorepo, segundo projeto EAS, segunda ficha de loja.
- **Registrado:** a decisão é reversível e datada; a separação é uma evolução de
  escala, com gatilhos objetivos acima.
