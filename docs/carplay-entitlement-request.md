# CarPlay Entitlement — pedido à Apple

Rascunho pronto para colar no formulário
https://developer.apple.com/contact/request/carplay (login próprio do
fundador — a Apple exige que o pedido venha da conta do Apple Developer
Program dona do app; isto não pode ser enviado por terceiros).

O formulário da Apple é em inglês e normalmente pede: nome do app, categoria
CarPlay pretendida, e uma descrição do caso de uso. Abaixo, os dois blocos —
use o em inglês no formulário; o em português é só para sua conferência.

---

## Categoria CarPlay a selecionar

**Ride-Sharing / Rider** — CarPlay tem uma categoria (`CPTemplateApplicationSceneDelegate`
+ `CPMapTemplate`/ride-hailing entitlement) voltada especificamente a apps do
tipo Uber/Lyft. É a que se aplica ao Go XL.

Observação importante para o formulário: a Apple normalmente concede o
entitlement de CarPlay para apps de ride-sharing pensando na experiência do
**passageiro** dentro do carro de terceiros (acompanhar o motorista chegando,
ver ETA). No caso do Go XL, o uso pretendido é o oposto — o **motorista**
usando CarPlay no próprio carro para navegar e gerenciar corridas. Vale
deixar isso explícito no pedido (parágrafo 2 do texto em inglês abaixo), para
não gerar confusão na revisão.

---

## Texto em inglês (colar no formulário)

**App name:** Go XL

**Company:** 2MT (Go XL)

**CarPlay category requested:** Ride-Sharing (Driver-side navigation and trip
management)

**Use case description:**

Go XL is a ride-hailing app (single "Executive XL" vehicle tier) operating in
Florida, USA. We are requesting CarPlay entitlement for the **driver-facing**
side of the app — the goal is to let drivers manage ride requests and
navigate to pickup/drop-off locations directly from their vehicle's built-in
display, reducing the need to interact with a handheld phone while driving.

Planned CarPlay experience for drivers:
- Incoming ride request shown as a native CarPlay template (pickup location,
  destination, estimated fare) with Accept/Decline actions.
- Active trip status and turn-by-turn navigation to pickup and drop-off
  points, using CarPlay's map/navigation templates.
- No passenger-facing features are planned for CarPlay in this phase — this
  request covers the driver app flow only.

This mirrors the driver-side CarPlay integration already available in
comparable ride-hailing platforms, and is intended to improve road safety by
minimizing phone handling while driving.

**Estimated timeline:** Development is already underway on the Android
equivalent (Android Auto, Car App Library) for the same driver flow; CarPlay
support is planned as the counterpart once the entitlement is granted.

---

## Texto em português (referência, não enviar)

**Nome do app:** Go XL

**Categoria pedida:** Ride-Sharing — mas para o **motorista**, não o
passageiro (a Apple normalmente pensa nesse entitlement do lado do
passageiro; deixamos isso explícito no texto em inglês pra não gerar
confusão).

**Resumo do que pretendemos construir:**
- Chamada de corrida chegando aparece como tela nativa do CarPlay (origem,
  destino, valor estimado) com botões Aceitar/Recusar.
- Status da corrida ativa + navegação até o embarque/desembarque usando os
  templates de mapa/navegação do próprio CarPlay.
- Nenhuma tela voltada ao passageiro no CarPlay nesta fase — só o fluxo do
  motorista.

**Por quê:** reduzir a necessidade de o motorista mexer no celular durante a
condução (segurança), no mesmo espírito da integração equivalente que já
está em desenvolvimento para Android Auto.

---

## Depois de enviar

- A aprovação normalmente demora **algumas semanas** — não é imediata.
- Quando o entitlement chegar (email da Apple + novo capability disponível no
  Apple Developer Portal para o App ID do Go XL), volte a este projeto e
  retome a task "CarPlay: setup técnico" — nesse ponto entra
  `react-native-carplay` + os templates nativos (ver seção correspondente no
  backlog/memória do projeto).
- Nada no código do app depende deste pedido enquanto ele está pendente — o
  trabalho de Android Auto segue em paralelo sem bloqueio.
