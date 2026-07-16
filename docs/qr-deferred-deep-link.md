# Go XL — Deferred deep link do QR de motorista (instalar → já vinculado)

Faz o passageiro que **não tem o app** e lê o QR de um motorista **baixar o app
e já ficar vinculado àquele motorista** na 1ª corrida — sem digitar código.
Paridade com o "invite install" do Uber, feito **DIY** (sem SDK de terceiros).

## O gap

- Hoje o QR codifica o **custom scheme** direto (`goxl://ride?driver=CODE`).
  Quem já tem o app abre e a corrida trava no motorista. Quem **não** tem: a
  câmera não sabe o que fazer com `goxl://`, ou (na melhor das hipóteses) manda
  para a loja e o vínculo **se perde** entre o clique e o primeiro open.
- Uber resolve com *deferred deep linking*: a origem (quem convidou / qual QR)
  sobrevive à ida à loja e é recuperada no primeiro open.

## Arquitetura (sem SDK de terceiros)

```
  QR do motorista  =  https://goxl.app/qr?driver=CODE   (landing própria)
        │
        │ leitura pela câmera nativa (abre https sem atrito, com ou sem app)
        ▼
  Landing goxl.app/qr
   ├── "Já tenho o app"  → bounce  goxl://ride?driver=CODE ──► app trava a corrida
   │                                    (padrão idêntico ao /track)
   └── "Baixar o Go XL"  → grava  goxl-ride:CODE  no CLIPBOARD (gesto do usuário)
                           → redireciona para App Store / Play Store
                                    │
                                    ▼ (após instalar, 1º open)
                           AppNavigator lê o clipboard UMA vez
                           → parseClipboardPayload → pendingDriverCode
                           → ExpressRegister { driverCode }  (fluxo expresso atual)
```

- **Por que https e não `goxl://` no QR:** a câmera nativa do iOS/Android abre
  `https` sem atrito para **qualquer** pessoa (tenha ou não o app). A landing é
  quem decide entre *bounce* (instalado) e *clipboard + loja* (não instalado).
- **Por que clipboard e não Android install-referrer:** o Expo 54 roda com New
  Architecture; a lib `react-native-play-install-referrer` está sem manutenção e
  é risco de estabilidade de build. O clipboard funciona nos **dois** SOs. O
  parser de referrer fica pronto (`parseInstallReferrer`) para plugar no futuro
  sem reescrever nada.
- **Nota iOS:** ler o clipboard exibe o banner "colado da área de transferência".
  Aceitável porque acontece **uma única vez**, logo após uma instalação que o
  próprio usuário iniciou lendo o QR (flag em AsyncStorage garante o "uma vez").

## Núcleo puro (`src/lib/deferredDeepLink.ts`)

Parsing **sem React nem rede**, testável em unidade (13 testes):

- `DEFERRED_CLIP_PREFIX = 'goxl-ride:'` — prefixo do payload de clipboard.
- `parseClipboardPayload(raw)` → `CODE | null`. Só aceita `goxl-ride:CODE` com
  CODE no charset/comprimento canônicos (`^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$`
  — mesmo `codeFromId` do `QRCodeScreen`). Normaliza caixa/espaços. Nunca confia
  cegamente no clipboard: qualquer outro conteúdo → `null`.
- `parseInstallReferrer(ref)` → `CODE | null`. Fonte **futura** (Android Play
  referrer): extrai `goxl_driver`/`driver` de uma query string, url-decode
  tolerante. Hoje não há lib de referrer; o parser fica pronto.
- `readDeferredDriverCode()` — **impura**: importa `expo-clipboard` de forma
  preguiçosa (para os parsers puros continuarem testáveis sem o módulo nativo),
  lê o clipboard e devolve `parseClipboardPayload(...)`. Best-effort: qualquer
  falha (permissão/plataforma) é engolida e devolve `null`.

## Cliente

### QR (`src/screens/driver/QRCodeScreen.tsx`)

- O valor do QR passa de `ExpoLinking.createURL('ride', …)` (custom scheme) para
  **`https://goxl.app/qr?driver=${code}`** (landing). O `code` continua sendo o
  `codeFromId(profile.id)` já existente.

### AppNavigator (`src/navigation/AppNavigator.tsx`)

- **`routePendingCodeByAuth()`** (novo helper): roteia um `pendingDriverCode` já
  assentado pelo estado de auth atual (`isAuthedRef`) — autenticado ⇒ trava a
  corrida (`dispatchPendingDeepLink` → RequestRide); sem login ⇒ `ExpressRegister
  { driverCode }`. Replica a decisão do efeito `[loading, session]` para o caso
  assíncrono do clipboard (que pode chegar **depois** daquele efeito).
- **Efeito de deferred deep link** (roda quando `!loading`, **uma vez** por
  processo + flag `goxl_deferred_dl_checked` em AsyncStorage): se **não** houver
  deep link direto pendente (`pendingDriverCode`/`pendingTrackToken` — o bounce
  `goxl://` tem prioridade), lê o clipboard via `readDeferredDriverCode()`; se
  achar CODE, seta `pendingDriverCode.current` e chama `routePendingCodeByAuth()`.
- A flag em AsyncStorage é gravada **antes** da leitura → o clipboard é lido no
  máximo uma vez na vida do install (privacidade + evita pegar conteúdo alheio
  em opens futuros).

### Landing (`go-xl-site/qr/index.html`)

Página própria em `goxl.app/qr` (Netlify serve `qr/index.html`, como `/track`):
- valida `?driver=CODE` com o mesmo charset;
- **"Baixar o Go XL"** → `navigator.clipboard.writeText('goxl-ride:CODE')` (gesto
  do usuário + https) e redireciona para a loja certa por UA;
- **"Já tenho o app"** → bounce `goxl://ride?driver=CODE` com fallback à loja
  após 1200 ms (mesmo padrão do `/track`).

## Sem mudança de infra

- **Nenhuma** `associatedDomains` (iOS Universal Links) nem intent-filter novo no
  Android: o `/qr` **não** precisa abrir o app diretamente — a landing faz todo o
  roteamento (bounce ou clipboard). Reaproveita o padrão já provado do `/track`.
- `expo-clipboard` autolinka no prebuild (não precisa de config plugin em
  `app.json`).

## Arquivos

| Arquivo | Mudança |
|---------|---------|
| `src/lib/deferredDeepLink.ts` | **novo** — parsers puros + `readDeferredDriverCode`. |
| `src/lib/__tests__/deferredDeepLink.test.ts` | **novo** — 13 testes dos parsers. |
| `src/screens/driver/QRCodeScreen.tsx` | QR passa a codificar `https://goxl.app/qr?driver=CODE`; remove import `expo-linking`. |
| `src/navigation/AppNavigator.tsx` | helper `routePendingCodeByAuth` + efeito de deferred deep link (clipboard, uma vez). |
| `go-xl-site/qr/index.html` | **novo** — landing (bounce / clipboard + loja). |
| `package.json` | + `expo-clipboard`. |

## Como validar localmente

```
cd /Users/mamute99/go-xl
npx jest --config package.json src/lib/__tests__/deferredDeepLink.test.ts
npx tsc --noEmit -p .
```

Resultado atual: **13 passed** (deferredDeepLink) · suíte `nav`+`lib` **138
passed** · `tsc` EXIT 0.

## Roteiro de teste manual (um iPhone/Android SEM o app)

Pré-condição: `go-xl-site` publicado (landing `/qr` no ar) + build do app com
esta mudança nas lojas.

1. **Sem app instalado:** ler o QR do motorista → abre `goxl.app/qr` mostrando o
   código do motorista. Tocar **"Baixar o Go XL"** → toast "vinculado" → loja.
2. **Instalar e abrir:** no 1º open, o app lê o clipboard, reconhece o motorista
   e leva ao **cadastro expresso** (cartão) já travado nele. Concluído o
   cadastro, a corrida sai vinculada ao motorista do QR.
3. **Segundo open:** o app **não** relê o clipboard (flag AsyncStorage) — sem
   banner de "colado" e sem vínculo indevido.
4. **Com app já instalado:** ler o mesmo QR → tocar **"Já tenho o app"** →
   bounce `goxl://ride?driver=CODE` → app trava a corrida no motorista (fluxo já
   existente, inalterado).
5. **Passageiro logado:** com sessão ativa, o deferred/bounce cai em
   `RequestRide` travado (não em ExpressRegister).

## Riscos e degradação segura

- **Best-effort em toda a cadeia:** falha ao escrever/ler clipboard ⇒ o app
  simplesmente segue o fluxo normal (passageiro pede a corrida sem trava). Nada
  quebra.
- **Prioridade do deep link direto:** se um `goxl://ride` (bounce) já assentou
  `pendingDriverCode`, o efeito de clipboard não sobrescreve.
- **Privacidade:** clipboard lido no máximo uma vez por install; só payloads
  `goxl-ride:` com código válido são aceitos.
- **Reversível:** voltar o QR para o custom scheme é trocar uma linha em
  `QRCodeScreen.tsx`; a landing e o parser podem coexistir sem efeito.
```
